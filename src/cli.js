#!/usr/bin/env node
// CLI for Clawstly OpenCode RPC. Keep this file dependency-light: completion,
// help and --version must work before any of the core modules are loaded.

import './safe-stdio.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_PATH, DASHBOARD_PORT, LOG_PATH, STATE_DIR } from './paths.js';
import { APP_NAME, MODEL_PROFILES, METRIC_MODES, modelLabelFor, normalizeMetric } from './branding.js';
import { VERSION } from './version.js';
import { c, fail, info, ok, warn, EX_USER_ERROR, EX_SYS_ERROR } from './ui.js';
import { writeFileAtomic } from './atomic-rename.js';
import { complete, suggestCommand } from './commands.js';
import { BRAND, CLI, renderCommandHelp, renderHelp } from './help.js';

function shortPath(path, max = 92) {
  const value = String(path || '');
  return value.length > max ? `…${value.slice(-max + 1)}` : value;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeUserConfig(config) {
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function updateConfigKey(key, value) {
  const { parseJsonc } = await import('./install.js');
  const raw = existsSync(CONFIG_PATH)
    ? parseJsonc(readFileSync(CONFIG_PATH, 'utf8'), {}) || {}
    : {};
  dottedSet(raw, key, value);
  writeUserConfig(raw);
}

function dottedGet(object, key) {
  return String(key).split('.').filter(Boolean).reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), object);
}

function dottedSet(object, key, value) {
  const parts = String(key).split('.').filter(Boolean);
  if (!parts.length) throw new Error('empty key');
  let cursor = object;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return object;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function hours(ms) {
  return `${((Number(ms) || 0) / 3_600_000).toFixed(1)}h`;
}

function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function flagValue(argv, flag) {
  const exact = argv.indexOf(flag);
  if (exact !== -1) {
    const value = argv[exact + 1];
    if (value === undefined || value.startsWith('-')) fail(`${flag} needs a value`, { code: EX_USER_ERROR });
    return value;
  }
  const prefix = `${flag}=`;
  const hit = argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

// ── daemon control ───────────────────────────────────────────────────────

async function daemonControl() {
  return import('./ensure-daemon.js');
}

function startDaemon(ctl) {
  ctl.clearStopped();
  const pid = ctl.daemonAlive();
  if (pid) {
    info('daemon', `already running (pid ${pid})`);
    return false;
  }
  const child = ctl.spawnDaemonDetached();
  if (!child || !child.pid) {
    warn('daemon failed to spawn', `see ${shortPath(LOG_PATH)} or run \`${CLI} doctor\``);
    return false;
  }
  ok('daemon launched', `pid ${child.pid} · log ${shortPath(LOG_PATH)}`);
  return true;
}

async function confirmDaemonUp(ctl, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    const pid = ctl.daemonAlive();
    if (pid) { ok('daemon is up', `pid ${pid}`); return true; }
  }
  warn('daemon not up yet', `see ${shortPath(LOG_PATH)} or run \`${CLI} doctor\``);
  return false;
}

async function stopDaemon(ctl) {
  ctl.markStopped();
  const pid = ctl.daemonAlive();
  if (!pid) {
    info('daemon stopped', `was not running · stays off until \`${CLI} start\``);
    return true;
  }
  const stopped = await ctl.stopDaemonAndWait();
  if (stopped) ok('daemon stopped', `pid ${pid} · stays off until \`${CLI} start\``);
  else warn('stop failed', `pid ${pid} is still running`);
  return Boolean(stopped);
}

async function restartDaemon(ctl) {
  ctl.markStopped();
  const oldPid = ctl.daemonAlive();
  if (oldPid) await ctl.stopDaemonAndWait();
  ctl.clearStopped();
  const child = ctl.spawnDaemonDetached();
  if (!child || !child.pid) {
    warn('daemon failed to spawn', `see ${shortPath(LOG_PATH)} or run \`${CLI} doctor\``);
    return false;
  }
  ok('daemon restarted', `pid ${child.pid}`);
  await confirmDaemonUp(ctl);
  return true;
}

// ── read-only views ──────────────────────────────────────────────────────

async function aggregate() {
  const { readAggregate } = await import('./scanner.js');
  return readAggregate() || {};
}

function aggregateSummary(agg) {
  const total = (agg.inputTokens || 0) + (agg.outputTokens || 0)
    + (agg.cacheReadTokens || 0) + (agg.cacheWriteTokens || 0);
  return `${plural(agg.sessions || 0, 'session')} · ${hours(agg.activeMs)} · ${tokens(total)} tokens`;
}

async function showStatus() {
  const [{ loadConfig }, state, scanner, format, ctl] = await Promise.all([
    import('./config.js'),
    import('./state.js'),
    import('./scanner.js'),
    import('./format.js'),
    daemonControl(),
  ]);
  const config = loadConfig();
  const active = state.readActiveState();
  const agg = scanner.readAggregate() || null;
  const pid = ctl.daemonAlive();
  const live = scanner.findLiveSessions();
  const vars = format.buildVars(active, config, agg);

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ ${BRAND}${c.reset}  ${c.dim}v${VERSION}${c.reset}`);
  console.log('');
  ok('daemon', pid ? `running (pid ${pid})` : 'not running');
  if (existsSync(CONFIG_PATH)) ok('config', shortPath(CONFIG_PATH));
  else warn('config', `missing - run \`${CLI} setup\``);
  ok('state dir', shortPath(STATE_DIR));
  ok('session', `${vars.statusVerbose || vars.status} · ${vars.project} · ${vars.modelPretty}`);
  ok('live sessions', String(live.length));
  if (agg) ok('aggregate', aggregateSummary(agg));
  else warn('aggregate', `not built yet - run \`${CLI} scan\``);
  if (ctl.isStopped()) info('paused by stop', `use \`${CLI} start\` to resume`);
  console.log('');
}

async function showToday() {
  const { dayKey } = await import('./scanner.js');
  const agg = await aggregate();
  const day = agg.byDay?.[dayKey(Date.now())] || {};
  const total = (day.inputTokens || 0) + (day.outputTokens || 0)
    + (day.cacheReadTokens || 0) + (day.cacheWriteTokens || 0);
  console.log('');
  console.log(`  ${c.bold}Today${c.reset}`);
  ok('active', hours(day.activeMs));
  ok('prompts', String(day.userMessages || 0));
  ok('tool calls', String(day.toolCalls || 0));
  ok('tokens', tokens(total));
  if (agg.peakHour?.hour != null) info('peak hour', `${String(agg.peakHour.hour).padStart(2, '0')}:00`);
  console.log('');
}

async function showStats() {
  const agg = await aggregate();
  console.log('');
  console.log(`  ${c.bold}Lifetime stats${c.reset}`);
  ok('sessions', String(agg.sessions || 0));
  ok('active time', hours(agg.activeMs));
  ok('prompts', String(agg.userMessages || 0));
  ok('tool calls', String(agg.toolCalls || 0));
  ok('files edited', String(agg.uniqueFiles || 0));
  ok('lines', `+${agg.linesAdded || 0} / -${agg.linesRemoved || 0}`);
  if (agg.estimatedCost) info('estimated cost', `$${Number(agg.estimatedCost).toFixed(2)}`);
  if (!Object.keys(agg).length) warn('no aggregate', `run \`${CLI} scan\` first`);
  console.log('');
}

async function showStreak() {
  const agg = await aggregate();
  console.log('');
  console.log(`  ${c.bold}Streak${c.reset}`);
  ok('current', plural(agg.streak || 0, 'day'));
  ok('longest', plural(agg.longestStreak || 0, 'day'));
  if (agg.bestDay?.day) info('best day', String(agg.bestDay.day));
  console.log('');
}

async function showInsights() {
  const agg = await aggregate();
  try {
    const { generateInsights } = await import('./insights.js');
    const lines = generateInsights(agg, { limit: 5 });
    console.log('');
    console.log(`  ${c.bold}Insights${c.reset}`);
    for (const line of lines) {
      console.log(`  ${c.cyan}·${c.reset} ${String(line)}`);
    }
    console.log('');
  } catch (error) {
    warn('insights unavailable', error?.message || String(error));
  }
}

async function runScan(argv) {
  const { scan } = await import('./scanner.js');
  const result = scan({ force: argv.includes('--force') || argv.includes('-f') });
  ok('scan complete', `${plural(result.files || 0, 'state file')} · ${aggregateSummary(result.aggregate || {})}`);
}

// ── config / privacy / pause ─────────────────────────────────────────────

async function configCommand(argv) {
  const sub = argv[0] || 'get';
  if (sub === 'edit') {
    if (!existsSync(CONFIG_PATH)) writeUserConfig({});
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const result = spawnSync(editor, [CONFIG_PATH], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) fail(`could not open editor: ${editor}`, { hint: 'set $EDITOR and try again', code: EX_SYS_ERROR });
    return;
  }
  if (sub === 'get') {
    const { loadConfig } = await import('./config.js');
    const key = argv[1];
    if (!key) {
      const raw = readJson(CONFIG_PATH);
      console.log(JSON.stringify(raw || loadConfig(), null, 2));
      return;
    }
    const value = dottedGet(loadConfig(), key);
    if (value === undefined) fail(`unknown config key: ${key}`, { code: EX_USER_ERROR });
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return;
  }
  if (sub === 'set') {
    const key = argv[1];
    const rawValue = argv[2];
    if (!key || rawValue === undefined) {
      fail('usage: config set <key> <json-value>', { code: EX_USER_ERROR });
    }
    let value;
    try { value = JSON.parse(rawValue); } catch {
      fail(`${rawValue} is not JSON`, { hint: 'quote strings, e.g. config set appName "Clawstly"', code: EX_USER_ERROR });
    }
    try { await updateConfigKey(key, value); } catch (error) {
      fail(`invalid key ${key}: ${error.message}`, { code: EX_USER_ERROR });
    }
    ok('config set', `${key} = ${JSON.stringify(value)}`);
    return;
  }
  fail(`unknown config action: ${sub}`, { hint: `${CLI} config <get|set|edit>`, code: EX_USER_ERROR });
}

async function privateCommand(argv) {
  const privacy = await import('./privacy.js');
  const { loadConfig } = await import('./config.js');
  const sub = argv[0] || 'status';
  const target = argv[1] ? resolve(argv[1]) : process.cwd();

  if (sub === 'add') {
    privacy.addPrivateCwd(target);
    ok('private', `${shortPath(target)} is hidden from Discord`);
    return;
  }
  if (sub === 'remove') {
    privacy.removePrivateCwd(target);
    ok('public', `${shortPath(target)} can be shown again`);
    return;
  }
  if (sub === 'set') {
    const level = argv[2];
    const levels = { hidden: 'hidden', name: 'name-only', public: 'public' };
    if (!levels[level]) {
      fail('usage: private set <cwd> <hidden|name|public>', { code: EX_USER_ERROR });
    }
    privacy.setCwdVisibility(target, levels[level]);
    ok('visibility', `${shortPath(target)} = ${level}`);
    return;
  }
  if (sub === 'list' || sub === 'status') {
    const paths = privacy.listPrivateCwds();
    const visibility = privacy.listVisibility();
    const current = privacy.resolveVisibility(process.cwd(), loadConfig());
    console.log('');
    console.log(`  ${c.bold}Privacy${c.reset}`);
    ok('current folder', `${current.visibility} · ${current.reason}`);
    ok('private paths', paths.length ? paths.map(shortPath).join(', ') : 'none');
    ok('overrides', Object.keys(visibility).length
      ? Object.entries(visibility).map(([path, level]) => `${shortPath(path)}=${level}`).join(', ')
      : 'none');
    console.log('');
    return;
  }
  fail(`unknown private action: ${sub}`, {
    hint: `${CLI} private <add|remove|list|set>`,
    code: EX_USER_ERROR,
  });
}

async function pauseCommand(argv) {
  const pause = await import('./pause.js');
  const value = argv[0] || '1h';
  if (value === 'off' || value === 'status') {
    const removed = pause.clearPause();
    if (value === 'off') ok('presence resumed', removed ? 'pause cleared' : 'was not paused');
    else info('pause', pause.pauseUntil() ? 'paused' : 'not paused');
    return;
  }
  const ms = pause.parseDuration(value);
  if (!ms) fail(`invalid duration: ${value}`, {
    hint: 'use 30m, 2h, 1h30m, a number of minutes, or off',
    code: EX_USER_ERROR,
  });
  const until = pause.setPause(ms);
  ok('presence paused', `until ${new Date(until).toLocaleString()}`);
}

async function modelCommand(argv) {
  const { loadConfig } = await import('./config.js');
  const { seedHistory, recordModelChange } = await import('./display-model-history.js');
  const current = String(loadConfig().displayModel || '').trim();
  const input = argv.join(' ').trim();

  if (!input) {
    const { readActiveState } = await import('./state.js');
    const realModel = readActiveState()?.model || 'unknown';
    console.log('');
    info('displayed model', current || `real model (${realModel})`);
    console.log(`  ${c.gray}choices:${c.reset}`);
    for (const profile of MODEL_PROFILES) {
      console.log(`    ${c.cyan}${profile.alias.padEnd(8)}${c.reset}  ${profile.label}`);
    }
    console.log(`    ${c.cyan}${'real'.padEnd(8)}${c.reset}  use the real model`);
    console.log(`  ${c.gray}current RPC app: ${APP_NAME}${c.reset}`);
    console.log('');
    return;
  }

  const resolved = modelLabelFor(input);
  // Seed the outgoing label at the config file's current mtime BEFORE writing
  // the new one, so dashboard rows from earlier keep their original label.
  seedHistory(current);
  await updateConfigKey('displayModel', resolved.label);
  recordModelChange(resolved.label);
  ok('displayed model', resolved.label || 'real model');
  await restartDaemon(await daemonControl());
  info('discord card', `now showing ${resolved.label || 'the real model'}`);
}

async function metricCommand(argv) {
  const { loadConfig } = await import('./config.js');
  const current = normalizeMetric(loadConfig().displayMetric) || 'cost';
  const input = argv.join(' ').trim();

  if (!input) {
    console.log('');
    info('card metric', current);
    console.log(`  ${c.gray}choices:${c.reset}`);
    for (const mode of METRIC_MODES) {
      console.log(`    ${c.cyan}${mode.value.padEnd(8)}${c.reset}  ${mode.label.padEnd(16)} ${c.gray}${mode.example}${c.reset}`);
    }
    console.log('');
    return;
  }

  const next = normalizeMetric(input);
  if (!next) fail(`unknown metric: ${input}`, {
    hint: 'use tokens, cost or both',
    code: EX_USER_ERROR,
  });
  await updateConfigKey('displayMetric', next);
  ok('card metric', next);
  await restartDaemon(await daemonControl());
  info('discord card', `now showing ${METRIC_MODES.find((m) => m.value === next)?.label || next}`);
}

// ── plugin source / process control ──────────────────────────────────────

async function sourceCommand(argv) {
  const src = await import('./plugin-source.js');
  const sub = String(argv[0] || 'status').toLowerCase();
  if (sub === 'status' || sub === 'show') {
    const st = src.sourceStatus();
    if (argv.includes('--json')) { console.log(JSON.stringify(st, null, 2)); return; }
    if (argv.includes('--short')) { console.log(st.activeTarget || 'none'); return; }
    console.log('');
    ok('config', st.active?.path || 'none (no registration found)');
    ok('source', st.activeTarget || 'none');
    for (const [key, path] of Object.entries(st.presets)) {
      info(`preset ${key}`, path || 'not available on this platform');
    }
    if (st.systemDirs.length) info('system dirs (read-only)', st.systemDirs.join(', '));
    const issues = src.pluginRegistrationIssues(st);
    if (issues.length) warn('duplicate registration', issues.join('; '),
      'run `clawstly-oc-rpc source D` (or your active source) to consolidate');
    console.log('');
    return;
  }
  let result;
  try {
    result = src.setPluginSource(argv.join(' '));
  } catch (error) {
    fail(`plugin source: ${error.message}`, {
      hint: 'use: source C | source D | source <absolute path>', code: EX_USER_ERROR,
    });
  }
  if (result.changed) ok('plugin source', result.target);
  else info('plugin source', `${result.target} (already set)`);
  if (result.cleaned?.length > 1) info('registrations consolidated', result.cleaned.map(shortPath).join(', '));
  ok('config', shortPath(result.path));
  // The running daemon belongs to the old copy. Stop it so the newly loaded
  // plugin starts its own daemon from the selected source.
  const pc = await import('./process-control.js');
  await pc.stopDaemonOnly();
  info('daemon', 'stopped - restart OpenCode to load the new source');
}

async function processCommand(kind) {
  const pc = await import('./process-control.js');
  switch (kind) {
    case 'processes':
      console.log(JSON.stringify(await pc.rpcReport(), null, 2));
      return;
    case 'start-all': {
      const result = await pc.startAll();
      ok('daemon', result.daemon.pid ? `running (pid ${result.daemon.pid})` : 'not started');
      ok('dashboard', result.dashboard.up ? `http://127.0.0.1:${DASHBOARD_PORT}` : 'not started');
      return;
    }
    case 'stop-all': {
      const result = await pc.stopAll();
      ok('plug-in', result.plugin.disabled ? 'disabled - OpenCode left running' : 'not disabled');
      ok('daemon', result.daemon.stopped ? 'stopped' : 'still running');
      ok('dashboard', result.dashboard.stopped ? 'stopped' : 'still running');
      if (result.killed.length) info('force-stopped', result.killed.join(', '));
      if (result.stopped.leftovers) ok('leftovers', 'none');
      else warn('leftovers still running', result.leftovers.map((proc) => `${proc.kind} ${proc.pid}`).join(', '));
      return;
    }
    case 'restart-all': {
      const result = await pc.restartAll();
      ok('daemon', result.daemon.pid ? `running (pid ${result.daemon.pid})` : 'not started');
      ok('dashboard', result.dashboard.up ? `http://127.0.0.1:${DASHBOARD_PORT}` : 'not started');
      return;
    }
    case 'daemon-start': {
      const result = pc.startDaemonOnly();
      ok('daemon', result.pid ? (result.started ? `started (pid ${result.pid})` : `already running (pid ${result.pid})`) : 'failed to start');
      return;
    }
    case 'daemon-stop': {
      const result = await pc.stopDaemonOnly();
      ok('daemon', result.stopped ? 'stopped (stays off until start)' : 'still running');
      if (result.killed.length) info('force-stopped', result.killed.join(', '));
      return;
    }
    case 'daemon-restart': {
      const result = pc.restartDaemonOnly();
      ok('daemon', result.pid ? `restarted (pid ${result.pid})` : 'failed to start');
      return;
    }
    case 'dashboard-start': {
      const result = await pc.startDashboardOnly({ openBrowser: false });
      ok('dashboard', result.up ? `http://127.0.0.1:${DASHBOARD_PORT}` : 'failed to start');
      return;
    }
    case 'dashboard-stop': {
      const result = await pc.stopDashboardOnly();
      ok('dashboard', result.stopped ? 'stopped' : 'still running');
      if (result.killed.length) info('force-stopped', result.killed.join(', '));
      return;
    }
    case 'dashboard-status': {
      const report = await pc.rpcReport();
      ok('dashboard', report.dashboardUp ? `running (pid ${report.dashboardPid || 'unknown'})` : 'not running');
      return;
    }
    default:
      fail(`unknown process action: ${kind}`, { code: EX_USER_ERROR });
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────

async function doComplete(argv) {
  const words = [...argv];
  const current = process.env.CLAWSTLY_OC_RPC_COMP_CUR;
  if (current !== undefined) words.push(current);
  try {
    const lines = complete(words);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } catch {
    // Completion must stay silent on every failure.
  }
}

async function helpCommand(name) {
  if (!name) { console.log(renderHelp()); return; }
  const page = renderCommandHelp(name);
  if (page) { console.log(page); return; }
  const guess = suggestCommand(name);
  fail(`no command called ${name}`, {
    hint: guess ? `did you mean \`${CLI} help ${guess}\`?` : `run \`${CLI} help\``,
    code: EX_USER_ERROR,
  });
}

async function dispatch(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    await helpCommand(cmd === 'help' ? args[0] : undefined);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === '-v') {
    console.log(`${CLI} ${VERSION}`);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    await helpCommand(cmd);
    return 0;
  }
  if (cmd === '__complete') { await doComplete(args); return 0; }
  if (cmd === 'hook') {
    info('no hook needed', `${BRAND} uses an OpenCode V2 plugin instead - run \`${CLI} setup\` to register it`);
    return 0;
  }
  if (cmd === 'setup' || cmd === 'install') {
    const { setup } = await import('./install.js');
    await setup({
      yes: args.includes('--yes'),
      printPlugin: args.includes('--print-plugin'),
    });
    return 0;
  }
  if (cmd === 'start' || cmd === 'stop' || cmd === 'restart') {
    const ctl = await daemonControl();
    if (cmd === 'start') {
      if (startDaemon(ctl)) await confirmDaemonUp(ctl);
    } else if (cmd === 'stop') {
      await stopDaemon(ctl);
    } else {
      ctl.clearStopped();
      await ctl.stopDaemonAndWait();
      if (startDaemon(ctl)) await confirmDaemonUp(ctl);
    }
    return 0;
  }
  if (cmd === 'status') { await showStatus(); return 0; }
  if (cmd === 'today') { await showToday(); return 0; }
  if (cmd === 'stats') { await showStats(); return 0; }
  if (cmd === 'streak') { await showStreak(); return 0; }
  if (cmd === 'insights') { await showInsights(); return 0; }
  if (cmd === 'scan' || cmd === 'rescan') { await runScan(args); return 0; }
  if (cmd === 'serve') {
    const port = flagValue(args, '--port') || String(DASHBOARD_PORT);
    if (!/^\d+$/.test(port)) fail(`invalid port: ${port}`, { code: EX_USER_ERROR });
    process.env.CLAWSTLY_RPC_PORT = port;
    console.log('');
    ok('dashboard', `http://127.0.0.1:${port}`);
    console.log('');
    await import('./server/index.js');
    return 0;
  }
  if (cmd === 'source') { await sourceCommand(args); return 0; }
  if ([
    'processes', 'start-all', 'stop-all', 'restart-all',
    'daemon-start', 'daemon-stop', 'daemon-restart',
    'dashboard-start', 'dashboard-stop', 'dashboard-status',
  ].includes(cmd)) {
    await processCommand(cmd);
    return 0;
  }
  if (cmd === 'model') { await modelCommand(args); return 0; }
  if (cmd === 'metric') { await metricCommand(args); return 0; }
  if (cmd === 'config') { await configCommand(args); return 0; }
  if (cmd === 'private') { await privateCommand(args); return 0; }
  if (cmd === 'pause' || cmd === 'resume' || cmd === 'unpause') {
    await pauseCommand(cmd === 'pause' ? args : ['off', ...args]);
    return 0;
  }
  if (cmd === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    return await runDoctor();
  }

  const guess = suggestCommand(cmd);
  fail(`unknown command: ${cmd}`, {
    hint: guess ? `did you mean \`${CLI} ${guess}\`?` : `run \`${CLI} help\` for the command list`,
    code: EX_USER_ERROR,
  });
}

export async function main(argv = process.argv.slice(2)) {
  let code = 0;
  try {
    code = await dispatch(argv);
  } catch (error) {
    if (error?.code === EX_USER_ERROR) throw error;
    fail(`command failed: ${error?.message || error}`, { code: EX_SYS_ERROR });
  }
  if (code) process.exitCode = code;
  return code;
}

export default main;
