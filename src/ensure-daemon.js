// Daemon-lifecycle primitives shared by the CLI (`start`), the daemon itself
// (single-instance guard), and the OpenCode V2 plugin. Kept dependency-light so
// plugin setup can import the spawn recipe without pulling in the UI stack.
//
// The daemon comes up whenever an OpenCode session starts (the plugin checks
// daemonAlive() and calls spawnDaemonDetached() directly), and
// claimSingleInstance guarantees that no matter how many launchers fire at once
// — a manual `start` or several plugin setups from concurrent sessions — exactly
// one daemon survives.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  PID_PATH, DAEMON_SCRIPT, CANONICAL_EXE, IS_PACKAGED, DAEMON_INFO_PATH, STOPPED_PATH,
} from './paths.js';
import { renameSyncRetry } from './atomic-rename.js';

// require()d, not imported — on the plugin setup hot path; see plugin/index.ts.
const require = createRequire(import.meta.url);
const {
  openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync,
} = require('node:fs');

// The daemon rewrites its heartbeat (DAEMON_INFO_PATH.beatAt) this often (its
// lifecycle watchdog tick); a
// beat older than BEAT_STALE_MS means the pid in the pid file is not our daemon
// any more (it died without cleanup and the OS recycled the pid — common after a
// Windows/macOS reboot, where the tmp dir and its stale pid file survive) or the
// daemon is wedged. Generous on purpose: a laptop waking from sleep shows a stale
// beat for up to one interval, and the cost of a false "dead" is one duplicate
// spawn that the daemons' own pid-file check reaps within a watchdog tick.
export const BEAT_EVERY_MS = 30_000;
export const BEAT_STALE_MS = 5 * 60_000;

// True if `pid` names a live process. process.kill(pid,0) sends no signal — it
// just probes: ESRCH → gone, EPERM → exists but owned by someone else (still
// alive). 0/NaN is never alive.
export function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function readPid(pidPath = PID_PATH) {
  try { return Number(readFileSync(pidPath, 'utf8')) || 0; }
  catch { return 0; }
}

// { pid, version, startedAt, beatAt } written by daemons from 1.9.0 on, or null
// (missing, unreadable, or an older daemon that never wrote one).
export function readDaemonInfo(infoPath = DAEMON_INFO_PATH) {
  try {
    const j = JSON.parse(readFileSync(infoPath, 'utf8'));
    return j && typeof j === 'object' && Number.isFinite(j.pid) ? j : null;
  } catch { return null; }
}

export function writeDaemonInfo(info, infoPath = DAEMON_INFO_PATH) {
  try {
    mkdirSync(dirname(infoPath), { recursive: true });
    const tmp = `${infoPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSyncRetry(tmp, infoPath);
  } catch { /* advisory — liveness falls back to the bare pid probe */ }
}

// Pure: is `pid` our live daemon? A live pid is only trusted when the heartbeat
// written for THAT pid is fresh; with no heartbeat for it (a pre-1.9 daemon, or
// the info file belongs to someone else) the bare probe is all we have.
export function pidIsDaemon(pid, { info = null, alive = isAlive, now = Date.now(), staleMs = BEAT_STALE_MS } = {}) {
  if (!pid || !alive(pid)) return false;
  if (info && info.pid === pid && Number.isFinite(info.beatAt) && now - info.beatAt > staleMs) return false;
  return true;
}

// The pid of the live daemon, or 0 if none is running.
export function daemonAlive(pidPath = PID_PATH, infoPath = DAEMON_INFO_PATH) {
  const pid = readPid(pidPath);
  return pidIsDaemon(pid, { info: pid ? readDaemonInfo(infoPath) : null }) ? pid : 0;
}

// ── stop intent ──────────────────────────────────────────────────────────
// `stop` sends one signal AND records intent, so the next plugin setup cannot
// immediately respawn the daemon. The marker makes a stop stick until
// start/restart/setup clears it.
export function isStopped(path = STOPPED_PATH) {
  return existsSync(path);
}
export function markStopped(path = STOPPED_PATH) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(Date.now())); return true; }
  catch { return false; }
}
export function clearStopped(path = STOPPED_PATH) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
}

// Stop the daemon and wait until it is really gone. SIGTERM, then SIGKILL if it
// ignored that for `graceMs` (on Windows process.kill is always a hard kill).
// A hard kill skips the daemon's own cleanup, so a pid file still naming the
// dead pid is removed here — otherwise a recycled pid reads as "running".
// Resolves true when no daemon is left. `kill`/`sleep` are injectable for tests.
export async function stopDaemonAndWait({
  pidPath = PID_PATH, infoPath = DAEMON_INFO_PATH, graceMs = 3000, killMs = 1500,
  kill = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const pid = daemonAlive(pidPath, infoPath);
  if (!pid) { cleanupPidFile(0, pidPath); return true; }
  const gone = async (ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (!isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  };
  try { kill(pid, 'SIGTERM'); } catch { /* already gone / not ours */ }
  let ok = await gone(graceMs);
  if (!ok) {
    try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    ok = await gone(killMs);
  }
  if (ok) cleanupPidFile(pid, pidPath);
  return ok;
}

// Remove the pid file if it still names `pid` (or a dead process when pid=0).
function cleanupPidFile(pid, pidPath = PID_PATH) {
  try {
    const cur = readPid(pidPath);
    if (cur && (cur === pid || (!pid && !isAlive(cur)))) unlinkSync(pidPath);
  } catch { /* gone already */ }
}

// The single source of truth for HOW to launch the daemon, shared by every
// launcher so the CLI and the hook spawn it identically:
//   packaged → "<canonical exe>" daemon   (prefer the canonical install over a
//              transient Downloads copy so we don't keep that file locked open)
//   dev/npm  → "<node>" "<abs daemon.js>" (PATH-independent — process.execPath
//              is the very node already running us)
// Always detached + windowless + stdio-ignored so it outlives the launcher and
// never pops a console. Returns the child (caller reads .pid) or null on a
// synchronous spawn failure.
export function spawnDaemonDetached() {
  const exe = (IS_PACKAGED && existsSync(CANONICAL_EXE)) ? CANONICAL_EXE : process.execPath;
  const args = IS_PACKAGED ? ['daemon'] : [DAEMON_SCRIPT];
  try {
    // Required here, not imported: node:child_process (plus dgram and the
    // spawn bindings it pulls in) costs the hook a few ms on every event,
    // although it only spawns when the daemon is down.
    const { spawn } = require('node:child_process');
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // An async spawn failure (ENOENT on the exe) emits 'error'; with no listener
    // Node rethrows it as an unhandled exception that can take down the launcher.
    // Swallow — the caller verifies liveness via the pid file, not the child.
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// Atomic single-instance claim, called once by the daemon at startup. Returns
// the pid of an already-running daemon (caller should exit), or null when WE
// now own the pid file. The exclusive-create ('wx') makes the pid file itself
// the mutex: only one of N simultaneously-starting daemons can create it; the
// losers read the winner's live pid and step aside. A stale file (dead owner,
// empty, or our own recycled pid) is reclaimed and the create retried — so a
// crashed daemon never blocks its successor.
export function claimSingleInstance({ pidPath = PID_PATH, pid = process.pid, alive = (p) => pidIsDaemon(p, { info: readDaemonInfo() }) } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let fd;
    try {
      fd = openSync(pidPath, 'wx'); // atomic: throws EEXIST if the file already exists
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Unexpected (perms, missing dir). Best-effort write and take ownership
        // rather than refusing to start.
        try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable — run lockless */ }
        return null;
      }
      let owner = 0;
      try { owner = Number(readFileSync(pidPath, 'utf8')) || 0; } catch { /* mid-write — reclaim */ }
      if (owner && owner !== pid && alive(owner)) return owner; // a live daemon already owns it
      try { unlinkSync(pidPath); } catch { /* a racer reclaimed it first */ }
      continue; // retry the exclusive create
    }
    try { writeFileSync(fd, String(pid)); } finally { try { closeSync(fd); } catch { /* already closed */ } }
    return null; // we created the file → we are THE daemon
  }
  // Repeatedly lost the reclaim race (extreme contention) — proceed best-effort.
  try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable */ }
  return null;
}
