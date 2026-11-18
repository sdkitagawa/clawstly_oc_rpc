// "Is OpenCode actually running?" — fast, cached, best-effort process detection.
//
// The daemon uses this as a liveness signal: hook/state freshness goes quiet as
// soon as the user stops typing, so asking the OS directly is the only way to
// tell an idle-but-open session from a closed one. A query failure returns
// `null` (unknown), never an exception — callers fall back to state-file based
// staleness in that case.
//
// The result (including `null`) is cached for 10s so the daemon's slow poll
// timer never turns into repeated process-table dumps on a busy machine.

import { execFileSync } from 'node:child_process';

const CACHE_MS = 10_000;
const EXEC_TIMEOUT_MS = 1_500;
const MAX_BUFFER = 4 * 1024 * 1024;
const WINDOWS_HOST_NAMES = new Set(['node.exe', 'bun.exe', 'deno.exe']);

// { at, value } — `value` may be null ("unknown"). `null` cache means "no
// sample yet" so a genuine unknown is still cached for the full window.
let cached = null;

function readOutput(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// Does this (image name, command line) pair look like an OpenCode process?
// Exported for tests. Slashes are normalized before matching so Windows paths
// and POSIX paths use the same rules. The token boundary keeps unrelated names
// (e.g. `opencode.jsonc` in an editor command line, or clawstly-oc-rpc itself)
// from matching.
export function looksLikeOpenCode(name, cmdline) {
  const n = String(name || '').replace(/\\/g, '/').toLowerCase();
  const base = n.slice(n.lastIndexOf('/') + 1);
  if (/^opencode2?(?:\.exe|\.cmd|\.bat)?$/.test(base)) return true;

  const c = String(cmdline || '').replace(/\\/g, '/').toLowerCase();
  if (!c) return false;
  // npm/npx global install: .../@opencode/cli/bin/opencode.exe
  if (c.includes('@opencode/')) return true;
  // Bare command or path tail: `opencode`, `opencode.exe`, `bin/opencode`,
  // `npx opencode@latest`. Extensions stop at a word boundary so config files
  // like `opencode.jsonc` are not mistaken for the binary.
  if (/(^|[\s"'(/])opencode2?(?:\.exe|\.cmd|\.bat|\.js|\.mjs|\.cjs)?(?=$|[\s"')])/.test(c)) return true;
  return false;
}

function firstCsvField(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(',')[0].trim();
}

function detectWindows() {
  // tasklist is the cheap first pass: image names only, no command lines.
  const list = readOutput('tasklist', ['/FO', 'CSV', '/NH']);
  if (list === null) return null;

  let hasHost = false;
  for (const line of list.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const name = firstCsvField(line);
    if (looksLikeOpenCode(name, '')) return true;
    if (WINDOWS_HOST_NAMES.has(name.toLowerCase())) hasHost = true;
  }
  if (!hasHost) return false;

  // node.exe/bun.exe/deno.exe can host OpenCode. tasklist can't show their
  // command lines, so do one narrow CIM query; if that tool is unavailable the
  // honest answer is "unknown" rather than a guess.
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe' OR Name='deno.exe'\" | ForEach-Object { $_.CommandLine }";
  const commands = readOutput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (commands === null) return null;
  for (const line of commands.split(/\r?\n/)) {
    if (looksLikeOpenCode('', line)) return true;
  }
  return false;
}

function detectPosix() {
  // comm is the executable name (or a path on some ps builds); args is the
  // full command line. A single query covers both native and npm installs.
  const listing = readOutput('ps', ['-eo', 'comm=,args=']);
  if (listing === null) return null;
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.search(/\s/);
    const comm = space === -1 ? trimmed : trimmed.slice(0, space);
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
    if (looksLikeOpenCode(comm, args)) return true;
  }
  return false;
}

// true = OpenCode looks live, false = no matching process, null = unknown.
export function detectOpenCodeProcess() {
  try {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_MS) return cached.value;
    const value = process.platform === 'win32' ? detectWindows() : detectPosix();
    cached = { at: now, value: value === true || value === false ? value : null };
    return cached.value;
  } catch {
    return null;
  }
}

// Test helper — forces the next call to query the OS again.
export function clearOpenCodeProcessCache() {
  cached = null;
}
