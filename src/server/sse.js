// Server-Sent Events for the local dashboard. Watches the state directory,
// aggregate.json and config.json, and pushes a named `refresh` event to
// connected browsers.
// A small mtime poll backs up fs.watch (atomic renames are easy to miss).

import { watch, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import * as paths from '../paths.js';

const STATE_DIR = paths.STATE_DIR;
const AGGREGATE_PATH = paths.AGGREGATE_PATH;
const STATE_FILE_RE = /^state(?:-.+)?\.json$/;

const clients = new Set();
let heartbeat = null;
const HEARTBEAT_MS = 20_000;

export function broadcast(payload = {}) {
  const line = `event: refresh\ndata: ${JSON.stringify({ type: 'refresh', at: Date.now(), ...payload })}\n\n`;
  for (const res of clients) {
    try { res.write(line); }
    catch { clients.delete(res); }
  }
}

export function addClient(res) {
  clients.add(res);
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); }
      catch { clients.delete(res); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

export function removeClient(res) {
  clients.delete(res);
  if (clients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function watchDir(dir, matches, callback, onError) {
  try {
    const w = watch(dir, (_event, filename) => {
      if (!filename || matches(String(filename))) callback();
    });
    w.on('error', () => {
      try { w.close(); } catch { /* already closed */ }
      onError?.();
    });
    return w;
  } catch {
    return null;
  }
}

function newestMtime(dir, matches) {
  let max;
  let names;
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!matches(name)) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (max === undefined || m > max) max = m;
    } catch { /* vanished mid-rename */ }
  }
  return max;
}

export function watchSources({
  stateDir = STATE_DIR,
  aggregatePath = AGGREGATE_PATH,
  pollMs = 3_000,
  debounceMs = 150,
} = {}) {
  const aggName = basename(aggregatePath);
  const targets = [
    { name: 'state', dir: stateDir, matches: (f) => STATE_FILE_RE.test(f), watcher: null },
    { name: 'aggregate', dir: dirname(aggregatePath), matches: (f) => f === aggName, watcher: null },
    // CLI/launcher model + metric changes write config.json; refresh the open
    // dashboard so its model badge follows without a manual page reload.
    { name: 'config', dir: dirname(paths.CONFIG_PATH), matches: (f) => f === basename(paths.CONFIG_PATH), watcher: null },
  ];

  const lastMtime = new Map();
  const timers = new Map();
  const record = (t) => {
    const m = newestMtime(t.dir, t.matches);
    if (m !== undefined) lastMtime.set(t.name, m);
  };
  targets.forEach(record);

  const fire = (t) => {
    record(t);
    clearTimeout(timers.get(t.name));
    timers.set(t.name, setTimeout(() => broadcast({ source: t.name }), debounceMs));
  };

  const attach = (t) => {
    if (t.watcher || !t.dir) return;
    t.watcher = watchDir(t.dir, t.matches, () => fire(t), () => { t.watcher = null; });
  };
  targets.forEach(attach);

  const poll = setInterval(() => {
    for (const t of targets) {
      attach(t);
      const current = newestMtime(t.dir, t.matches);
      const previous = lastMtime.get(t.name);
      if (current === undefined) continue;
      if (previous === undefined) lastMtime.set(t.name, current);
      else if (current > previous) fire(t);
    }
  }, pollMs);
  poll.unref?.();

  return {
    close() {
      clearInterval(poll);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const t of targets) {
        try { t.watcher?.close(); } catch { /* already closed */ }
        t.watcher = null;
      }
    },
  };
}
