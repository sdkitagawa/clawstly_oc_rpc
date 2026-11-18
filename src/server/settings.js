// Settings API for the local Clawstly OpenCode RPC dashboard.
//
//   GET  /api/settings        effective config + daemon status + template vars
//   POST /api/settings        { base, edited } → write only what changed
//   GET  /api/log             tail of the daemon log
//   GET  /api/workspaces      known workspaces + visibility levels
//   POST /api/workspaces      { cwd, level } → privacy override
//   GET  /api/template-vars   variables available to status templates
//   POST /api/daemon          { action: start|stop|restart }
//
// Community / usage / profile settings and upstream promotional links are not
// surfaced here. The write routes are guarded by index.js (same-origin JSON).

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import * as paths from '../paths.js';
import { DEFAULT_CONFIG } from '../default-config.js';
import { loadConfig, mergeConfig } from '../config.js';
import { applyEdits } from '../config-edit.js';
import { writeFileAtomic } from '../atomic-rename.js';
import * as daemon from '../ensure-daemon.js';
import { readActiveState } from '../state.js';
import * as scanner from '../scanner.js';
import { buildVars, applyIdle } from '../format.js';
import { APP_NAME, MODEL_PROFILES, METRIC_MODES, normalizeMetric } from '../branding.js';
import * as privacy from '../privacy.js';
import { VERSION } from '../version.js';

export const STATUSES = ['working', 'thinking', 'compacting', 'shipped', 'notification', 'idle'];
export const ASSET_STATUSES = [...STATUSES, 'stale'];
export const VIS_LEVELS = ['public', 'name-only', 'hidden'];

const CONFIG_PATH = paths.CONFIG_PATH || '';
const LOG_PATH = paths.LOG_PATH || '';
const SCAN_CACHE_PATH = paths.SCAN_CACHE_PATH || '';
const MAX_CONFIG_BYTES = 256 * 1024;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A localhost server is reachable from unrelated browser tabs. Require an
// application/json body and, when a browser sends one, an exact same-origin
// Origin header.
export function writeAllowed(headers = {}) {
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = headers.origin;
  if (origin === undefined) return true; // curl / tests
  try { return new URL(origin).host === headers.host; }
  catch { return false; }
}

export function clientIdState(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'placeholder';
  if (/^(your[-_ ]?(discord[-_ ]?)?(client|application)[-_ ]?id|your[-_ ]?id|replace[-_ ]?me|change[-_ ]?me|changeme|todo|none|placeholder|x{8,}|0{8,})$/i.test(s)) {
    return 'placeholder';
  }
  if (/^\d{17,21}$/.test(s)) return 'ok';
  return 'invalid';
}

function tailLog(lines = 120) {
  try {
    if (!LOG_PATH || !existsSync(LOG_PATH)) return '';
    return readFileSync(LOG_PATH, 'utf8').split('\n').slice(-lines).join('\n').trimEnd();
  } catch { return ''; }
}

export function daemonStatus() {
  let pid = null;
  let stopped = false;
  try { pid = daemon.daemonAlive?.() || null; } catch { /* no process info */ }
  try { stopped = !!daemon.isStopped?.(); } catch { /* no marker info */ }
  return {
    running: !!pid,
    pid,
    stopped,
    ipc: pid ? 'unknown' : 'down',
  };
}

// Strip features deliberately outside this build. Sending a reduced view also
// means applyEdits() can't write those keys back while saving the form.
export function publicConfig(config) {
  if (!isPlainObject(config)) return {};
  const out = structuredClone(config);
  for (const key of ['community', 'usage', 'profile', 'leaderboard', 'badge', 'card', 'wrapped', 'worker']) {
    delete out[key];
  }
  return out;
}

function safeLiveSessions() {
  try {
    const live = scanner.findLiveSessions({ thresholdMs: 90_000 });
    return Array.isArray(live) ? live : [];
  } catch { return []; }
}

function safeAggregate() {
  try {
    const agg = scanner.readAggregate();
    return isPlainObject(agg) ? agg : {};
  } catch { return {}; }
}

function sample(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 80);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  } catch { return String(value).slice(0, 80); }
}

// Live variable names for the {placeholder} picker in the settings page.
export function templateVariables() {
  try {
    const config = loadConfig({ onError: () => {} });
    let state = readActiveState() || {};
    state = { ...state, liveSessions: safeLiveSessions() };
    state = applyIdle(state, config) || state;
    const vars = buildVars(state, config, safeAggregate()) || {};
    return Object.keys(vars).sort().map((name) => ({ name, sample: sample(vars[name]) }));
  } catch {
    return [];
  }
}

export function getSettings() {
  let config = {};
  try { config = loadConfig({ onError: () => {} }) || {}; }
  catch { config = {}; }
  const safe = publicConfig(config);
  const vars = templateVariables();
  return {
    version: VERSION,
    configPath: CONFIG_PATH,
    config: safe,
    statuses: STATUSES,
    assetStatuses: ASSET_STATUSES,
    assetPlaceholders: {
      working: 'oc_working',
      thinking: 'oc_thinking',
      compacting: 'oc_compacting',
      shipped: 'oc_shipped',
      idle: 'oc_idle',
      notification: 'oc_notification',
      stale: 'oc_idle',
    },
    clientId: { value: String(safe.clientId ?? ''), state: clientIdState(safe.clientId) },
    defaultAppName: APP_NAME,
    modelProfiles: MODEL_PROFILES,
    metricModes: METRIC_MODES,
    daemon: daemonStatus(),
    vars: vars.map((v) => v.name),
  };
}

function readRawConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`couldn't read config (${e.message})`);
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error(`config isn't valid JSON (${e.message}) — fix or delete it first`); }
  if (!isPlainObject(raw)) throw new Error('config is not a JSON object');
  return raw;
}

// Keep the editor from producing a config the daemon can't use. A placeholder
// client ID is allowed: the dashboard just warns until a real one is set.
export function validateConfig(merged) {
  const idState = clientIdState(merged.clientId);
  if (idState === 'invalid') {
    return 'Discord application ID must be 17–21 digits, or leave the placeholder until you have one';
  }
  if (merged.displayModel !== undefined && merged.displayModel !== null
    && typeof merged.displayModel !== 'string') {
    return 'displayModel must be text (or blank to use the real model)';
  }
  if (merged.displayMetric !== undefined && merged.displayMetric !== null
    && !normalizeMetric(merged.displayMetric)) {
    return 'displayMetric must be tokens, cost or both';
  }
  for (const key of [
    'updateIntervalMs', 'rotationIntervalMs', 'idleThresholdSec', 'staleSessionMin',
    'shippedFrameSec', 'notificationWindowSec', 'rescanIntervalSec', 'triggerFrameSec',
  ]) {
    const value = merged[key];
    if (value !== undefined && value !== null
      && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      return `${key} must be a number, 0 or more`;
    }
  }
  for (const key of ['largeImageKey', 'smallImageKey', 'largeImageText', 'smallImageText']) {
    const value = merged.presence?.[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `presence.${key} must be text`;
    }
  }
  for (const [status, value] of Object.entries(merged.statusAssets || {})) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `statusAssets.${status} must be an asset key or URL`;
    }
  }
  return null;
}

export async function saveSettings(body, { path = CONFIG_PATH } = {}) {
  const base = body?.base;
  const edited = body?.edited;
  if (!isPlainObject(base) || !isPlainObject(edited)) return { error: 'Nothing to save' };
  const wasRunning = daemonStatus().running;
  let raw;
  try { raw = readRawConfig(path); }
  catch (e) { return { error: `Not saved: ${e.message}` }; }

  const cleanBase = publicConfig(base);
  const cleanEdited = publicConfig(edited);
  // Accept friendly aliases from API clients but persist a canonical value the
  // daemon's buildVars() understands without another translation layer.
  if (cleanEdited.displayMetric !== undefined && cleanEdited.displayMetric !== null) {
    const canonical = normalizeMetric(cleanEdited.displayMetric);
    if (canonical) cleanEdited.displayMetric = canonical;
  }
  const next = applyEdits(raw, cleanBase, cleanEdited);
  let problem;
  try { problem = validateConfig(mergeConfig(DEFAULT_CONFIG || {}, next)); }
  catch (e) { return { error: `Not saved: ${e.message}` }; }
  if (problem) return { error: problem };

  const text = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return { error: 'Config is too large to save' };
  try { writeFileAtomic(path, text); }
  catch (e) { return { error: `Not saved: ${e.message}` }; }

  const saved = loadConfig({ path, onError: () => {} });
  // The daemon loads config once at startup. Restart it after a save so the
  // Discord card immediately picks up displayModel / displayMetric / templates.
  let restarted = false;
  let restartError = '';
  if (wasRunning) {
    try {
      const result = await daemonAction('restart');
      restarted = !result?.error;
      restartError = result?.error || '';
    } catch (e) {
      restartError = e?.message || 'Could not restart daemon';
    }
  }
  return {
    ok: true,
    config: publicConfig(saved),
    daemon: daemonStatus(),
    restarted,
    restartError,
  };
}

async function waitDaemon(want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive = false;
    try { alive = !!daemon.daemonAlive?.(); } catch { alive = false; }
    if (alive === want) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

async function stop({ mark = true } = {}) {
  if (mark) { try { daemon.markStopped?.(); } catch { /* best effort */ } }
  try { return await daemon.stopDaemonAndWait?.() !== false; }
  catch { return false; }
}

async function start() {
  try { daemon.clearStopped?.(); } catch { /* best effort */ }
  if (daemon.daemonAlive?.()) return true;
  let child;
  try { child = daemon.spawnDaemonDetached?.(); }
  catch { child = null; }
  if (!child?.pid) return false;
  return waitDaemon(true, 3000);
}

export async function daemonAction(action) {
  let ok;
  if (action === 'start') ok = await start();
  else if (action === 'stop') ok = await stop();
  else if (action === 'restart') ok = (await stop({ mark: false })) && (await start());
  else return { error: 'Unknown daemon action' };

  const status = daemonStatus();
  if (ok) return { ok: true, daemon: status };
  return {
    error: action === 'stop' ? "The daemon didn't stop — see the log below" : "The daemon didn't come up — see the log below",
    daemon: status,
  };
}

export function getLog() {
  return { path: LOG_PATH, content: tailLog(120) };
}

// Workspaces come from the scan cache (each session summary has its cwd).
// Legacy private paths are shown too, so nothing is silently hidden.
export function listWorkspaces() {
  const seen = new Map();
  try {
    if (SCAN_CACHE_PATH && existsSync(SCAN_CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(SCAN_CACHE_PATH, 'utf8'));
      for (const f of Object.values(cache?.files || {})) {
        if (!f || typeof f.cwd !== 'string' || !f.cwd) continue;
        const cwd = resolvePath(f.cwd);
        const lastTs = Number(f.lastTs) || 0;
        const prev = seen.get(cwd);
        if (!prev || lastTs > prev.lastTs) {
          seen.set(cwd, { name: basename(cwd) || cwd, cwd, lastTs, level: 'default' });
        }
      }
    }
  } catch { /* no scan cache yet — empty list */ }

  let visibility = {};
  let privateCwds = [];
  try { visibility = privacy.listVisibility?.() || {}; } catch { visibility = {}; }
  try { privateCwds = privacy.listPrivateCwds?.() || []; } catch { privateCwds = []; }

  const isPrivate = (cwd) => privateCwds.some((p) => {
    const abs = resolvePath(String(p));
    return cwd === abs || cwd.startsWith(abs + '/') || cwd.startsWith(abs + '\\');
  });

  for (const [cwd, row] of seen) {
    row.level = visibility[cwd] || (isPrivate(cwd) ? 'hidden' : 'default');
  }
  for (const p of privateCwds) {
    if (!p) continue;
    const cwd = resolvePath(String(p));
    if (!seen.has(cwd)) {
      seen.set(cwd, { name: basename(cwd) || cwd, cwd, lastTs: 0, level: visibility[cwd] || 'hidden' });
    }
  }

  return {
    workspaces: [...seen.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 100),
    visibility,
    levels: VIS_LEVELS,
  };
}

export function setWorkspaceVisibility(body) {
  const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null;
  if (!cwd) return { error: 'No workspace given' };
  const raw = body.level;
  const level = raw === 'default' || raw === '' || raw === null || raw === undefined ? null : raw;
  if (level !== null && !VIS_LEVELS.includes(level)) return { error: 'Unknown visibility level' };
  try {
    const visibility = privacy.setCwdVisibility?.(cwd, level) || {};
    return { ok: true, visibility, workspaces: listWorkspaces().workspaces };
  } catch (e) {
    return { error: e?.message || 'Could not save visibility' };
  }
}
