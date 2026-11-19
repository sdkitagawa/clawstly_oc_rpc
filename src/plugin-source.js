// Cross-platform discovery and selection of the OpenCode plugin registration.
//
// OpenCode loads plugins from `opencode.json(c)`. The launcher's "Plugin source"
// action rewrites only the `plugins` array, leaving every other setting and all
// JSONC comments untouched. System-managed config directories are detected but
// never written.
//
// Resolution order for an editable config:
//   1. OPENCODE_CONFIG              (explicit file, highest priority)
//   2. $XDG_CONFIG_HOME/opencode    (macOS / Linux; honoured everywhere)
//   3. ~/.config/opencode           (OpenCode default on every platform)
//   4. %APPDATA%\opencode           (Windows fallback)
//   5. project-local opencode.json(c) / .opencode/opencode.json(c)
// The first config that already registers this plugin wins; otherwise the
// global user config is used (created if needed).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-rename.js';
import { ROOT } from './paths.js';

// ── presets ───────────────────────────────────────────────────────────────

const DEFAULT_MIRROR = process.platform === 'win32'
  ? 'D:\\Disk Utilities\\Programs\\Development\\github\\clawstly_oc_rpc\\plugin'
  : '';

export function sourcePresets() {
  const local = process.env.CLAWSTLY_PLUGIN_SOURCE || join(ROOT, 'plugin');
  const mirror = process.env.CLAWSTLY_PLUGIN_MIRROR || DEFAULT_MIRROR;
  // Drive-letter shortcuts only make sense on Windows. macOS/Linux users get
  // L (this install) and M (an optional mirror) instead — never a C:\ path.
  return process.platform === 'win32' ? { C: local, D: mirror } : { L: local, M: mirror };
}

export function resolveSource(input) {
  const raw = String(input || '').trim();
  if (!raw || raw === 'status') return null;
  const presets = sourcePresets();
  const key = raw.toUpperCase();
  if (key === 'C' || key === 'L' || key === 'LOCAL' || key === 'SOURCE') {
    return resolve(presets.C || presets.L);
  }
  if (key === 'D' || key === 'M' || key === 'MIRROR') {
    const mirror = presets.D || presets.M;
    if (!mirror) throw new Error('no mirror preset on this platform — pass an absolute path or set CLAWSTLY_PLUGIN_MIRROR');
    return resolve(mirror);
  }
  const value = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(value)) throw new Error('plugin source must be an absolute path (or C / D)');
  return resolve(value);
}

// ── config discovery ──────────────────────────────────────────────────────

function dirVariants(dir) {
  const jsonc = join(dir, 'opencode.jsonc');
  const json = join(dir, 'opencode.json');
  return existsSync(jsonc) || !existsSync(json) ? [jsonc, json] : [json, jsonc];
}

function systemDirs() {
  const dirs = [];
  if (process.platform === 'darwin') dirs.push('/Library/Application Support/opencode');
  if (process.platform === 'linux') dirs.push('/etc/opencode');
  if (process.platform === 'win32') {
    const pd = process.env.ProgramData || 'C:\\ProgramData';
    dirs.push(join(pd, 'opencode'));
  }
  return dirs.map((path) => ({ path, writable: false, system: true }));
}

export function discoverConfigs() {
  const out = [];
  const seen = new Set();
  const add = (path, group, writable = true) => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ path: abs, group, writable, exists: existsSync(abs) });
  };

  if (process.env.OPENCODE_CONFIG) add(process.env.OPENCODE_CONFIG, 'env');
  if (process.env.XDG_CONFIG_HOME) {
    for (const p of dirVariants(join(process.env.XDG_CONFIG_HOME, 'opencode'))) add(p, 'xdg');
  }
  for (const p of dirVariants(join(homedir(), '.config', 'opencode'))) add(p, 'global');
  if (process.platform === 'win32' && process.env.APPDATA) {
    for (const p of dirVariants(join(process.env.APPDATA, 'opencode'))) add(p, 'appdata');
  }
  for (const base of [resolve(process.cwd() || ROOT), ROOT]) {
    let dir = base;
    for (let depth = 0; depth < 6; depth++) {
      for (const p of dirVariants(join(dir, '.opencode'))) add(p, 'project');
      for (const p of dirVariants(dir)) add(p, 'project');
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const sys of systemDirs()) {
    for (const p of dirVariants(sys.path)) add(p, 'system', false);
  }
  return out;
}

// Only entries whose value looks like our local plugin directory. Both the
// source (clawstly_oc_rpc) and the mirror (same name) match, so a stale
// duplicate registration is detected and removed.
export function isOurPluginEntry(entry) {
  const value = typeof entry === 'string' ? entry
    : entry && typeof entry === 'object'
      ? (entry.package || entry.path || entry.dir || entry.location || '')
      : '';
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\//g, '\\');
  return /clawstly[-_]oc[-_]rpc/i.test(normalized)
    && /\\plugin(?:\\|$)/i.test(normalized);
}

function readConfig(path) {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{\n}\n';
  const entries = readPluginsArray(raw);
  return { raw, entries };
}

// ── minimal JSONC scanning (strings + comments aware) ─────────────────────

function skipTrivia(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

function readString(text, i) {
  const quote = text[i];
  let value = '';
  i++;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { value += text.slice(i, i + 2); i += 2; continue; }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return { value, end: i };
}

function findArrayEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = readString(text, i).end; continue; }
    if (ch === '/' && text[i + 1] === '/') { i = skipTrivia(text, i); continue; }
    if (ch === '/' && text[i + 1] === '*') { i = skipTrivia(text, i); continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function findTopLevelArray(text, key) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    i = skipTrivia(text, i);
    if (i >= text.length) break;
    const ch = text[i];
    if (ch === '"') {
      const str = readString(text, i);
      if (depth === 1 && str.value === key) {
        let j = skipTrivia(text, str.end);
        if (text[j] === ':') {
          j = skipTrivia(text, j + 1);
          if (text[j] === '[') {
            const end = findArrayEnd(text, j);
            if (end > 0) return { start: j, end };
          }
        }
      }
      i = str.end;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return null;
}

function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') { const s = readString(text, i); out += text.slice(i, s.end); i = s.end; continue; }
    if (text[i] === '/' && text[i + 1] === '/') { i = skipTrivia(text, i); out += ' '; continue; }
    if (text[i] === '/' && text[i + 1] === '*') { i = skipTrivia(text, i); out += ' '; continue; }
    if (text[i] === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
    }
    out += text[i];
    i++;
  }
  return out;
}

export function readPluginsArray(raw) {
  const span = findTopLevelArray(raw || '', 'plugins');
  if (!span) return [];
  try {
    const value = JSON.parse(stripJsonc(raw.slice(span.start, span.end)));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Replace just the plugins array. All other keys and comments stay byte-for-byte.
export function replacePluginsArray(raw, entries) {
  const serialized = JSON.stringify(entries, null, 2).split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
  const span = findTopLevelArray(raw || '', 'plugins');
  if (span) return raw.slice(0, span.start) + serialized + raw.slice(span.end);

  let text = raw || '{\n}\n';
  const close = text.lastIndexOf('}');
  if (close === -1) return `${text.trim()}\n{\n  "plugins": ${serialized}\n}\n`;
  const before = text.slice(0, close).replace(/,\s*$/, '');
  const needsComma = /\S/.test(before.replace(/\{\s*$/, ''));
  return `${before}${needsComma ? ',' : ''}\n  "plugins": ${serialized}\n${text.slice(close)}`;
}

// ── public actions ────────────────────────────────────────────────────────

export function sourceStatus() {
  const configs = discoverConfigs().map((cfg) => {
    const read = cfg.exists ? readConfig(cfg.path) : { raw: '', entries: [] };
    const ours = read.entries.filter(isOurPluginEntry);
    return { ...cfg, entries: read.entries, ours };
  });
  const active = configs.find((cfg) => cfg.writable && cfg.ours.length) || null;
  return {
    configs,
    active,
    activeTarget: active?.ours[0]
      ? (typeof active.ours[0] === 'string' ? active.ours[0] : (active.ours[0].package || active.ours[0].path || ''))
      : '',
    systemDirs: configs.filter((cfg) => cfg.system).map((cfg) => cfg.path),
    presets: sourcePresets(),
  };
}

export function setPluginSource(input) {
  const target = resolveSource(input);
  const all = sourceStatus();
  const cfg = all.active
    || all.configs.find((c) => c.writable && c.group !== 'system' && c.group !== 'project' && c.exists)
    || all.configs.find((c) => c.writable && c.group !== 'system' && c.group !== 'project')
    || null;

  if (!cfg || !cfg.writable) throw new Error('no writable OpenCode config found — set OPENCODE_CONFIG');
  const path = cfg.path;
  const { raw, entries } = readConfig(path);
  const kept = entries.filter((entry) => !isOurPluginEntry(entry));
  kept.push(target);
  const next = replacePluginsArray(raw, kept);
  if (next !== raw || !existsSync(path)) {
    if (cfg.exists === false) {
      try { mkdirSync(dirname(path), { recursive: true }); } catch { /* best-effort */ }
    }
    writeFileAtomic(path, next.endsWith('\n') ? next : `${next}\n`);
    return { changed: true, path, target };
  }
  return { changed: false, path, target };
}

export default { sourcePresets, resolveSource, discoverConfigs, isOurPluginEntry, readPluginsArray, replacePluginsArray, sourceStatus, setPluginSource };
