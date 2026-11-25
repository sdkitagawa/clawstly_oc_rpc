// One-shot diagnostics for Clawstly OpenCode RPC.
//
// Checks the local install only: Node, our config, the OpenCode plugin
// registration, the daemon heartbeat, Discord IPC clues in the log, OpenCode
// process detection, session state, the aggregate and privacy settings. There
// are deliberately no credential or subscription-usage checks.

import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  CONFIG_PATH,
  LOG_PATH,
  AGGREGATE_PATH,
  STATE_PATH,
  PLUGIN_DIR,
  OPENCODE_CONFIG_DIR,
} from './paths.js';
import { loadConfig } from './config.js';
import { pluginRegistrationIssues, sourceStatus } from './plugin-source.js';
import { readActiveState, listSessionStates } from './state.js';
import { readAggregate, findLiveSessions } from './scanner.js';
import { daemonAlive, isStopped, readDaemonInfo, BEAT_STALE_MS } from './ensure-daemon.js';
import { listPrivateCwds, listVisibility, resolveVisibility } from './privacy.js';
import { pauseUntil } from './pause.js';
import {
  EVENTS,
  PLUGIN_KEY,
  PLACEHOLDER_CLIENT_ID,
  DISCORD_PORTAL,
  hookWord,
  pluginStatus,
  pluginSnippet,
} from './install.js';
import { c, check as uiCheck, tailLines } from './ui.js';
import { VERSION } from './version.js';

const counters = { pass: 0, fail: 0, warn: 0 };

function check(label, status, detail = '', hint = '') {
  if (status === 'pass') counters.pass++;
  else if (status === 'fail') counters.fail++;
  else if (status === 'warn') counters.warn++;
  uiCheck(label, status, detail, hint);
}

function section(title) {
  console.log(`\n  ${c.bold}${title}${c.reset}`);
}

function shortPath(path, max = 92) {
  const value = String(path || '');
  return value.length > max ? `…${value.slice(-max + 1)}` : value;
}

function classifyClientId(value) {
  const id = String(value || '').trim();
  if (!id) return 'unset';
  if (id === PLACEHOLDER_CLIENT_ID) return 'placeholder';
  if (!/^\d{17,21}$/.test(id)) return 'malformed';
  return 'ok';
}

function checkNode() {
  const major = Number(String(process.versions.node || '').split('.')[0] || 0);
  check('Node.js version', major >= 18 ? 'pass' : 'fail', process.versions.node,
    major >= 18 ? '' : 'install Node 18 or newer from https://nodejs.org');
}

function checkConfig() {
  if (!existsSync(CONFIG_PATH)) {
    check('config present', 'fail', shortPath(CONFIG_PATH),
      'run `clawstly-oc-rpc setup` to seed it');
    return {};
  }
  let config = {};
  try {
    config = loadConfig({ onError: (message) => console.log(`  ${c.dim}${message}${c.reset}`) });
    check('config present', 'pass', shortPath(CONFIG_PATH));
  } catch (error) {
    check('config present', 'fail', error?.message || String(error),
      `fix or replace ${CONFIG_PATH}`);
    return {};
  }

  const kind = classifyClientId(config.clientId);
  if (kind === 'ok') {
    check('discord clientId', 'pass', String(config.clientId));
  } else if (kind === 'placeholder') {
    check('discord clientId', 'warn', 'still the setup placeholder',
      `create an app at ${DISCORD_PORTAL}, then run \`clawstly-oc-rpc config set clientId "<id>"\``);
  } else if (kind === 'unset') {
    check('discord clientId', 'fail', 'missing',
      'run `clawstly-oc-rpc config set clientId "<your application id>"`');
  } else {
    check('discord clientId', 'warn', `${config.clientId} is not a Discord application ID`,
      'application IDs are 17–21 digits');
  }

  const disabled = ['community', 'usage', 'profile'].filter((key) => config[key]?.enabled === false);
  check('network integrations', disabled.length === 3 ? 'pass' : 'warn',
    disabled.length === 3 ? 'community, usage and profile are off'
      : `off: ${disabled.join(', ') || 'none'}`,
    disabled.length === 3 ? '' : 'this fork keeps community, usage and profile disabled; re-run setup');
  return config;
}

function checkPlugin() {
  let status;
  try {
    status = pluginStatus();
  } catch (error) {
    check(`${hookWord()} registration`, 'fail', error?.message || String(error),
      'run `clawstly-oc-rpc setup`');
    return;
  }
  if (status.current) {
    const active = sourceStatus().activeTarget || status.pluginPath;
    check(`${hookWord()} registered`, 'pass', `${PLUGIN_KEY} → ${shortPath(active)}`);
    return;
  }
  if (status.found) {
    check(`${hookWord()} registered`, 'warn', `found but not pointing at ${shortPath(PLUGIN_DIR)}`,
      'run `clawstly-oc-rpc setup` to point it at the local plugin directory');
    return;
  }
  check(`${hookWord()} registered`, 'fail', `no ${PLUGIN_KEY} entry in OpenCode config`,
    `add ${pluginSnippet().replace(/\n\s*/g, ' ')} to ${shortPath(`${OPENCODE_CONFIG_DIR}/opencode.jsonc`)} (or run setup)`);
  if (EVENTS.length) {
    check(`${hookWord()} events`, 'info', `${EVENTS.length} OpenCode V2 events are understood by this build`);
  }
}

function checkPluginRegistrations() {
  let issues;
  try {
    issues = pluginRegistrationIssues();
  } catch (error) {
    check('plugin registrations', 'warn', `lookup failed: ${error?.message || error}`);
    return;
  }
  if (issues.length) {
    check('plugin registrations', 'fail', issues.join('; '),
      'run `clawstly-oc-rpc source D` (or your active source) to consolidate registrations');
  } else {
    check('plugin registrations', 'pass', 'single registration');
  }
}

function checkDaemon() {
  if (isStopped()) {
    check('daemon heartbeat', 'info', 'stopped on purpose', 'run `clawstly-oc-rpc start` to resume');
    return;
  }
  const pid = daemonAlive();
  if (!pid) {
    check('daemon heartbeat', 'warn', 'no live daemon',
      'run `clawstly-oc-rpc start`');
    return;
  }
  const info = readDaemonInfo();
  if (info && info.pid === pid) {
    const age = Date.now() - Number(info.beatAt || 0);
    if (Number.isFinite(age) && age > BEAT_STALE_MS) {
      check('daemon heartbeat', 'fail', `pid ${pid} is alive but its heartbeat is ${Math.round(age / 1000)}s old`,
        'run `clawstly-oc-rpc restart`');
      return;
    }
    if (info.version && info.version !== VERSION) {
      check('daemon heartbeat', 'warn', `pid ${pid} runs v${info.version}; this install is v${VERSION}`,
        'run `clawstly-oc-rpc restart`');
      return;
    }
  }
  check('daemon heartbeat', 'pass', `pid ${pid}${info?.version ? ` · v${info.version}` : ''}`);
}

function checkDiscordLog() {
  if (!existsSync(LOG_PATH)) {
    check('discord IPC clues', 'info', 'no daemon log yet',
      'start the daemon with the Discord desktop app running');
    return;
  }
  let text = '';
  try { text = readFileSync(LOG_PATH, 'utf8'); } catch { /* unreadable log */ }
  let state = 'unknown';
  for (const line of tailLines(text, 80)) {
    if (/discord (rpc )?connected|presence (updated|cleared)|set[_-]?activity|activity set/i.test(line)) state = 'up';
    else if (/retry in|disconnected|login failed|connect failed|ipc (error|unavailable)/i.test(line)) state = 'down';
  }
  let age = '';
  try { age = `${Math.round((Date.now() - statSync(LOG_PATH).mtimeMs) / 60_000)}m ago`; } catch { /* stat failed */ }
  if (state === 'up') {
    check('discord IPC clues', 'pass', `connected · log updated ${age}`);
  } else if (state === 'down') {
    check('discord IPC clues', 'warn', 'daemon is reconnecting',
      'open the Discord desktop app (browser Discord does not expose RPC)');
  } else {
    check('discord IPC clues', 'info', `no connection clues in the log${age ? ` · updated ${age}` : ''}`,
      'this is only a log heuristic; start Discord desktop if the card does not appear');
  }
}

// oc-proc.js is written by another part of the port; load it defensively so an
// older checkout still produces a useful doctor report.
async function detectOpenCodeProcess() {
  try {
    const module = await import('./oc-proc.js');
    const fn = module.detectOpenCodeProcess || module.default;
    if (typeof fn !== 'function') return { available: false, reason: 'no exported detector' };
    return { available: true, result: await fn() };
  } catch (error) {
    return { available: false, reason: error?.message || String(error) };
  }
}

function describeProcess(result) {
  if (typeof result === 'boolean') {
    return { running: result, detail: result ? 'detected' : 'none detected' };
  }
  if (result && typeof result === 'object') {
    const running = result.running ?? result.alive ?? result.found
      ?? (Array.isArray(result.processes) ? result.processes.length > 0 : false);
    const processes = Array.isArray(result.processes)
      ? result.processes.map((item) => (typeof item === 'string' ? item : (item?.name || item?.pid || 'process'))).join(', ')
      : '';
    return { running: Boolean(running), detail: result.detail || processes || (running ? 'detected' : 'none detected') };
  }
  return { running: false, detail: 'none detected' };
}

async function checkOpenCodeProcess() {
  const probe = await detectOpenCodeProcess();
  if (!probe.available) {
    check('OpenCode process', 'info', `detector unavailable (${probe.reason})`,
      'presence still works; this check only reports whether OpenCode is running');
    return;
  }
  const info = describeProcess(probe.result);
  check('OpenCode process', info.running ? 'pass' : 'info', info.detail,
    info.running ? '' : 'start OpenCode and send a prompt to generate session state');
}

function checkSessionState() {
  try {
    const states = listSessionStates();
    const active = readActiveState();
    const legacy = existsSync(STATE_PATH);
    if (!states.length && !legacy) {
      check('session state', 'info', 'no session files yet',
        'send a prompt in OpenCode; the plugin writes session state');
      return;
    }
    const last = Number(active?.lastActivity || 0);
    const ageMin = last ? Math.round((Date.now() - last) / 60_000) : null;
    let live = 0;
    try { live = findLiveSessions().length; } catch { /* unknown */ }
    const detail = `${states.length} session file${states.length === 1 ? '' : 's'} · status=${active?.status || 'unknown'} · last activity ${ageMin == null ? 'unknown' : `${ageMin}m ago`}`;
    if (ageMin != null && ageMin <= 5) {
      check('session state', 'pass', detail);
    } else if (live > 0) {
      check('session state', 'warn', `${detail} · ${live} live session(s)`,
        'the plugin is not refreshing state; check opencode plugin list');
    } else {
      check('session state', 'info', `${detail} · no live session`);
    }
  } catch (error) {
    check('session state', 'warn', `lookup failed: ${error?.message || error}`);
  }
}

function checkAggregate() {
  if (!existsSync(AGGREGATE_PATH)) {
    check('aggregate', 'warn', 'not built yet', 'run `clawstly-oc-rpc scan`');
    return;
  }
  try {
    const agg = readAggregate();
    if (!agg) throw new Error('empty aggregate');
    const hours = ((Number(agg.activeMs) || 0) / 3_600_000).toFixed(1);
    const age = Number(agg.generatedAt)
      ? ` · generated ${Math.round((Date.now() - Number(agg.generatedAt)) / 60_000)}m ago`
      : '';
    check('aggregate', 'pass', `${agg.sessions || 0} sessions · ${hours}h${age}`);
  } catch (error) {
    check('aggregate', 'warn', `unreadable: ${error?.message || error}`,
      'run `clawstly-oc-rpc scan --force` to rebuild it');
  }
}

function checkPrivacy(config) {
  try {
    const cwd = process.cwd();
    const result = resolveVisibility(cwd, config || {});
    const hidden = result.visibility === 'hidden' || result.visibility === 'name-only';
    check('current folder visibility', hidden ? 'info' : 'pass',
      `${result.visibility}${result.projectName ? ` · alias=${result.projectName}` : ''} · ${result.reason}`);
    const paths = listPrivateCwds();
    const overrides = Object.keys(listVisibility()).length;
    check('privacy settings', 'pass',
      `${paths.length} private path${paths.length === 1 ? '' : 's'} · ${overrides} visibility override${overrides === 1 ? '' : 's'}`);
    const pausedUntil = pauseUntil();
    if (pausedUntil) {
      check('presence pause', 'info', `paused until ${new Date(pausedUntil).toLocaleString()}`,
        'run `clawstly-oc-rpc pause off` to resume');
    }
  } catch (error) {
    check('privacy settings', 'warn', `lookup failed: ${error?.message || error}`);
  }
}

export async function doctor() {
  counters.pass = 0;
  counters.fail = 0;
  counters.warn = 0;

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ doctor${c.reset}  ${c.dim}— Clawstly OpenCode RPC v${VERSION}${c.reset}`);

  section('Runtime');
  checkNode();
  check('plugin directory', existsSync(PLUGIN_DIR) ? 'pass' : 'fail',
    PLUGIN_DIR, existsSync(PLUGIN_DIR) ? '' : 'the local plugin directory is missing from this install');

  section('Config');
  const config = checkConfig();

  section('OpenCode');
  checkPlugin();
  checkPluginRegistrations();
  await checkOpenCodeProcess();
  checkSessionState();

  section('Presence');
  checkDaemon();
  checkDiscordLog();
  checkAggregate();

  section('Privacy');
  checkPrivacy(config);

  const { pass, fail, warn } = counters;
  console.log('');
  console.log(`  ${c.bold}Summary:${c.reset}  ${c.green}${pass} pass${c.reset}` +
    (warn ? `  ${c.yellow}${warn} warn${c.reset}` : '') +
    (fail ? `  ${c.red}${fail} fail${c.reset}` : ''));
  if (fail === 0 && warn === 0) {
    console.log(`  ${c.dim}everything looks good. if the card is missing, restart Discord desktop.${c.reset}`);
  } else if (fail === 0) {
    console.log(`  ${c.dim}no failures — warnings are usually normal on a fresh install.${c.reset}`);
  }
  console.log('');
  return fail === 0 ? 0 : 1;
}

// Name used by the CLI; also exported as a default for direct imports.
export const runDoctor = doctor;
export default doctor;
