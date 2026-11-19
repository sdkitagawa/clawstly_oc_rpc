// Cross-platform process control for the RPC daemon and the dashboard server.
//
// The launchers expose "all" (daemon + dashboard) and per-component actions.
// The stop marker is written first: it keeps the OpenCode plugin inert (no
// state writes, no daemon respawn) while OpenCode itself stays running. Clean
// stops follow (pid files for the daemon and dashboard), then a command-line
// sweep force-stops any leftover node.exe / node process still running OUR
// daemon or dashboard script. Unrelated Node processes are never touched.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_PID_PATH, DASHBOARD_PORT, ROOT, STOPPED_PATH } from './paths.js';
import {
  clearStopped, daemonAlive, markStopped, spawnDaemonDetached, stopDaemonAndWait,
} from './ensure-daemon.js';

const CLI_SCRIPT = join(ROOT, 'bin', 'clawstly-oc-rpc.js');

// ── process enumeration / classification (pure enough to test) ────────────

export function classifyCommand(commandLine) {
  const s = String(commandLine || '').replace(/\//g, '\\');
  if (/clawstly[-_]oc[-_]rpc\\(?:.*\\)?src\\daemon\.js/i.test(s)) return 'daemon';
  if (/clawstly-oc-rpc(?:\.exe)?"?\s+daemon(?:\s|$)/i.test(s)) return 'daemon';
  if (/clawstly-oc-rpc\.js"?\s+serve(?:\s|$)/i.test(s)) return 'dashboard';
  if (/clawstly-oc-rpc(?:\.exe)?"?\s+serve(?:\s|$)/i.test(s)) return 'dashboard';
  return null;
}

export function listProcesses() {
  if (process.platform === 'win32') {
    const ps = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'clawstly-oc-rpc.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
    try {
      const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
      }).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .filter((row) => row && row.pid)
        .map((row) => ({ pid: Number(row.pid), commandLine: String(row.cmd || '') }));
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 20000 });
    return out.split('\n').map((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), commandLine: m[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function findRpcProcesses() {
  return listProcesses()
    .filter((proc) => proc.pid && proc.pid !== process.pid)
    .map((proc) => ({ ...proc, kind: classifyCommand(proc.commandLine) }))
    .filter((proc) => proc.kind);
}

// ── dashboard health ──────────────────────────────────────────────────────

export async function dashboardUp(port = DASHBOARD_PORT) {
  try {
    const signal = AbortSignal.timeout?.(1200);
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

function readDashboardPid() {
  try {
    const pid = Number(String(readFileSync(DASHBOARD_PID_PATH, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

// ── force-stop helpers ────────────────────────────────────────────────────

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

export async function forceKill(processes, { graceMs = 1500, killMs = 1000 } = {}) {
  const killed = [];
  for (const proc of processes) {
    if (!proc.pid || proc.pid === process.pid || !alive(proc.pid)) continue;
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    let gone = await waitGone(proc.pid, graceMs);
    if (!gone) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      gone = await waitGone(proc.pid, killMs);
    }
    if (gone) killed.push(proc.pid);
  }
  return killed;
}

// ── component actions ─────────────────────────────────────────────────────

export function startDaemonOnly() {
  clearStopped();
  const existing = daemonAlive();
  if (existing) return { started: false, pid: existing };
  const child = spawnDaemonDetached();
  return { started: Boolean(child?.pid), pid: child?.pid || 0 };
}

export async function stopDaemonOnly({ mark = true } = {}) {
  if (mark) markStopped(); // sticky: plugin stays inert until start
  const pid = daemonAlive();
  let clean = true;
  if (pid) clean = await stopDaemonAndWait();
  const leftovers = findRpcProcesses().filter((proc) => proc.kind === 'daemon');
  const killed = await forceKill(leftovers);
  return { clean, pid, killed, stopped: !findRpcProcesses().some((p) => p.kind === 'daemon') };
}

export function restartDaemonOnly() {
  clearStopped();
  const child = spawnDaemonDetached();
  return { started: Boolean(child?.pid), pid: child?.pid || 0 };
}

export async function startDashboardOnly({ openBrowser = false, port = DASHBOARD_PORT } = {}) {
  if (await dashboardUp(port)) return { started: false, up: true, port };
  const env = { ...process.env, CLAWSTLY_RPC_PORT: String(port) };
  if (openBrowser) delete env.CLAWSTLY_RPC_NO_OPEN;
  else env.CLAWSTLY_RPC_NO_OPEN = '1';
  let child;
  try {
    child = spawn(process.execPath, [CLI_SCRIPT, 'serve'], {
      cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref?.();
  } catch {
    return { started: false, up: false, port };
  }
  for (let i = 0; i < 24; i++) {
    if (await dashboardUp(port)) return { started: true, up: true, pid: child.pid || 0, port };
    await new Promise((done) => setTimeout(done, 250));
  }
  return { started: Boolean(child.pid), up: false, pid: child.pid || 0, port };
}

export async function stopDashboardOnly() {
  const pid = readDashboardPid();
  let clean = false;
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    clean = await waitGone(pid, 1500);
    if (!clean) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      clean = await waitGone(pid, 1000);
    }
  }
  try {
    const cur = readDashboardPid();
    if (cur && !alive(cur)) unlinkSync(DASHBOARD_PID_PATH);
  } catch { /* best-effort */ }
  const leftovers = findRpcProcesses().filter((proc) => proc.kind === 'dashboard');
  const killed = await forceKill(leftovers);
  return { clean, pid, killed, stopped: !(await dashboardUp()) };
}

// ── combined actions (no browser) ─────────────────────────────────────────

export async function startAll() {
  const daemon = startDaemonOnly();
  const dashboard = await startDashboardOnly({ openBrowser: false });
  return { daemon, dashboard };
}

export async function stopAll({
  mark = markStopped,
  stopDaemon = stopDaemonOnly,
  stopDashboard = stopDashboardOnly,
  sweep = forceKill,
  find = findRpcProcesses,
  up = dashboardUp,
} = {}) {
  // Disable the plug-in before anything else: a running OpenCode process must
  // not observe a half-stopped daemon and spawn a replacement.
  const pluginDisabled = Boolean(mark());
  const daemon = await stopDaemon({ mark: false });
  const dashboard = await stopDashboard();
  // Final sweep catches a process that appeared between the two clean stops.
  const killed = await sweep(find());
  const dashboardStopped = !(await up());
  const leftovers = find();
  return {
    daemon,
    dashboard: { ...dashboard, stopped: dashboardStopped },
    killed,
    plugin: { disabled: pluginDisabled, marker: STOPPED_PATH },
    leftovers,
    stopped: {
      daemon: Boolean(daemon.stopped),
      dashboard: dashboardStopped,
      plugin: pluginDisabled,
      leftovers: leftovers.length === 0,
    },
  };
}

export async function restartAll() {
  await stopAll();
  return startAll();
}

export async function rpcReport() {
  const procs = findRpcProcesses();
  return {
    daemonPid: daemonAlive() || 0,
    dashboardUp: await dashboardUp(),
    dashboardPid: readDashboardPid(),
    processes: procs,
    daemonProcesses: procs.filter((proc) => proc.kind === 'daemon'),
    dashboardProcesses: procs.filter((proc) => proc.kind === 'dashboard'),
    pluginDisabled: existsSync(STOPPED_PATH),
    stoppedMarker: existsSync(STOPPED_PATH),
  };
}

export default {
  classifyCommand, listProcesses, findRpcProcesses, dashboardUp,
  startDaemonOnly, stopDaemonOnly, restartDaemonOnly,
  startDashboardOnly, stopDashboardOnly,
  startAll, stopAll, restartAll, rpcReport, forceKill,
};
