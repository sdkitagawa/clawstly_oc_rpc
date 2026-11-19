// Setup for Clawstly OpenCode RPC.
//
// This fork does not install command hooks. OpenCode V2 loads plugins directly,
// so setup seeds our own config.json and registers the local `plugin` directory
// in OpenCode's config. Both the user config (~/.config/opencode/opencode.jsonc
// on every platform, including Windows) and project configs are inspected;
// only the user config is written.
//
// No command-hook settings files are read or written, and no upstream client
// ID or CDN assets are used anywhere in this file.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  CONFIG_PATH,
  OPENCODE_CONFIG_DIR,
  PLUGIN_DIR,
  PLUGIN_SCRIPT,
  ROOT,
  USER_CONFIG_DIR,
  VERSION_STAMP,
} from './paths.js';
import { writeFileAtomic } from './atomic-rename.js';
import { isOurPluginEntry, sourceStatus } from './plugin-source.js';
import { APP_NAME, DEFAULT_DISPLAY_MODEL } from './branding.js';
import { c, SYM_OK, SYM_WARN, SYM_INFO, hintLine } from './ui.js';
import { VERSION } from './version.js';

export const PLUGIN_KEY = 'clawstly-oc-rpc';
export const PLUGIN_NAME = 'Clawstly OpenCode RPC';
export const DISCORD_PORTAL = 'https://discord.com/developers/applications';

// Placeholder written on first setup. Never replace with an upstream app ID.
export const PLACEHOLDER_CLIENT_ID = 'YOUR_DISCORD_CLIENT_ID';

// OpenCode V2 event names a presence plugin can observe. Kept as data so doctor
// and help can describe the wiring without referring to command-hook events.
export const EVENTS = [
  'session.created',
  'session.deleted',
  'session.idle',
  'session.status',
  'session.compaction.started',
  'session.compaction.ended',
  'session.execution.started',
  'session.execution.succeeded',
  'session.step.started',
  'session.step.ended',
  'session.tool.called',
  'session.tool.failed',
  'session.usage.updated',
  'session.inbox.delivered',
  'permission.asked',
  'permission.replied',
  'filesystem.changed',
  'location.shutdown',
];

const SEED_CONFIG = {
  clientId: PLACEHOLDER_CLIENT_ID,
  appName: APP_NAME,
  displayModel: DEFAULT_DISPLAY_MODEL,
  displayMetric: 'cost',
  community: { enabled: false },
  usage: { enabled: false },
  profile: { enabled: false },
};

// Doctor/help speak about "plugins"; this keeps the shared wording in one place.
export function hookWord() {
  return 'plugin';
}

// ── JSONC helpers ────────────────────────────────────────────────────────

// Strip // and /* */ comments plus trailing commas, respecting quoted strings.
function stripJsonc(text) {
  const src = String(text || '');
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i += 2; continue; }
      if (ch === quote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '}' || src[j] === ']') { i++; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonc(text, fallback = null) {
  try {
    const value = JSON.parse(stripJsonc(text));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readJsonFile(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    return parseJsonc(readFileSync(path, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, data) {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ── plugin registration ──────────────────────────────────────────────────

function normPath(value) {
  try {
    return resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
  } catch {
    return String(value || '').replace(/\\/g, '/').toLowerCase();
  }
}

function pluginValue(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.package || entry.path || entry.dir || entry.location || '';
  }
  return '';
}

function isPathLike(value) {
  return typeof value === 'string' && /[\\/]/.test(value);
}

// Any Clawstly copy counts as ours: the selected plugin source (option 5) is canonical.
function isClawstlyPluginsValue(entry) {
  return isOurPluginEntry(entry);
}

function isCurrentPluginValue(entry) {
  const value = pluginValue(entry);
  if (!isPathLike(value) || !isAbsolute(value)) return false;
  const active = sourceStatus().activeTarget || resolve(PLUGIN_DIR);
  return normPath(value) === normPath(active);
}

function pluginEntryIn(config) {
  const plugins = config?.plugins;
  if (!plugins) return { found: false, current: false, entry: null, shape: null };
  if (Array.isArray(plugins)) {
    const index = plugins.findIndex(isClawstlyPluginsValue);
    return index === -1
      ? { found: false, current: false, entry: null, shape: 'array' }
      : { found: true, current: isCurrentPluginValue(plugins[index]), entry: plugins[index], shape: 'array', index };
  }
  if (typeof plugins === 'object') {
    const ownKey = Object.prototype.hasOwnProperty.call(plugins, PLUGIN_KEY);
    if (ownKey) {
      return { found: true, current: isCurrentPluginValue(plugins[PLUGIN_KEY]), entry: plugins[PLUGIN_KEY], shape: 'object', key: PLUGIN_KEY };
    }
    for (const [key, value] of Object.entries(plugins)) {
      if (isClawstlyPluginsValue(value)) {
        return { found: true, current: isCurrentPluginValue(value), entry: value, shape: 'object', key };
      }
    }
  }
  return { found: false, current: false, entry: null, shape: typeof plugins };
}

export const OPENCODE_USER_CONFIG = join(OPENCODE_CONFIG_DIR, 'opencode.jsonc');

function projectConfigPaths() {
  const paths = [];
  let dir = resolve(process.cwd() || ROOT);
  for (let depth = 0; depth < 6; depth++) {
    paths.push(join(dir, '.opencode', 'opencode.jsonc'));
    paths.push(join(dir, 'opencode.jsonc'));
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  if (process.env.OPENCODE_CONFIG) paths.push(resolve(process.env.OPENCODE_CONFIG));
  return [...new Set(paths)];
}

export function configPaths() {
  return [OPENCODE_USER_CONFIG, ...projectConfigPaths()];
}

// Read all OpenCode configs and report where our plugin is (or isn't).
export function pluginStatus() {
  const locations = [];
  for (const path of configPaths()) {
    if (!existsSync(path)) continue;
    const config = readJsonFile(path, {});
    const found = pluginEntryIn(config);
    if (found.found || path === OPENCODE_USER_CONFIG) {
      locations.push({ path, config, ...found });
    }
  }
  const found = locations.filter((location) => location.found);
  return {
    locations,
    found: found.length > 0,
    current: found.some((location) => location.current),
    pluginPath: resolve(PLUGIN_DIR),
  };
}

// Flexible so doctor can pass an entry, a config object, or nothing at all.
// With no argument it answers "is our plugin registered in any OpenCode config?"
export function isOurHook(target) {
  if (target === undefined || target === null) return pluginStatus().found;
  if (typeof target !== 'object') return false;
  if (Array.isArray(target)) return target.some(isClawstlyPluginsValue);
  if (pluginValue(target) || typeof target.package === 'string') return isClawstlyPluginsValue(target);
  return pluginEntryIn(target).found;
}

export function pluginSnippet() {
  return JSON.stringify({ plugins: [resolve(PLUGIN_DIR)] }, null, 2);
}

// V2 accepts only an array of plugin entries. Older object form is migrated
// entry by entry so unrelated plugins/settings are preserved.
function entryToV2(key, value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const pkg = pluginValue(value);
    if (typeof value.package === 'string' || value.options !== undefined) {
      return {
        ...(pkg ? { package: pkg } : { package: key }),
        ...(value.options !== undefined ? { options: value.options } : {}),
      };
    }
    if (pkg) return pkg;
  }
  return key;
}

function toV2Plugins(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, entry]) => entryToV2(key, entry));
  }
  return [];
}

// Add/refresh the local plugin registration in the user's OpenCode config.
// Returns { changed, path }; never throws on a missing config file.
function ensurePluginRegistration({ silent = false } = {}) {
  const path = OPENCODE_USER_CONFIG;
  const config = readJsonFile(path, {});
  const before = JSON.stringify(config);
  const target = resolve(PLUGIN_DIR);
  const current = pluginEntryIn(config);
  const plugins = toV2Plugins(config.plugins);

  if (current.found && current.current && Array.isArray(config.plugins)) {
    if (!silent) console.log(`  ${SYM_INFO}  ${'plugin registered'.padEnd(18)}${c.dim}${path}${c.reset}`);
    return { changed: false, path };
  }

  const ownIndices = plugins
    .map((entry, index) => (isClawstlyPluginsValue(entry) ? index : -1))
    .filter((index) => index >= 0);
  if (ownIndices.length) {
    plugins[ownIndices[0]] = target;
    for (const index of ownIndices.slice(1).reverse()) plugins.splice(index, 1);
  } else {
    plugins.push(target);
  }
  config.plugins = plugins;

  if (JSON.stringify(config) === before) return { changed: false, path };
  writeJsonFile(path, config);
  if (!silent) {
    console.log(`  ${SYM_OK}  ${'plugin registered'.padEnd(18)}${c.dim}${PLUGIN_KEY} → ${target}${c.reset}`);
    console.log(`         ${c.gray}↳ ${path}${c.reset}`);
  }
  return { changed: true, path };
}

// ── our config.json ──────────────────────────────────────────────────────

function migrateConfigObject(raw) {
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  let changed = false;
  const ensure = (key, value) => {
    if (config[key] !== value) { config[key] = value; changed = true; }
  };
  // Preserve a real user clientId; only fill in a missing/blank one.
  if (typeof config.clientId !== 'string' || !config.clientId.trim()) {
    ensure('clientId', PLACEHOLDER_CLIENT_ID);
  }
  // Preserve a user-chosen name, but migrate the old OpenCode default.
  if (typeof config.appName !== 'string' || !config.appName.trim() || config.appName === 'OpenCode') {
    ensure('appName', APP_NAME);
  }
  if (typeof config.displayModel !== 'string') ensure('displayModel', DEFAULT_DISPLAY_MODEL);
  if (!new Set(['tokens', 'cost', 'both']).has(config.displayMetric)) ensure('displayMetric', 'cost');
  for (const key of ['community', 'usage', 'profile']) {
    const block = config[key] && typeof config[key] === 'object' && !Array.isArray(config[key]) ? config[key] : {};
    if (block.enabled !== false) {
      config[key] = { ...block, enabled: false };
      changed = true;
    }
  }
  return { config, changed };
}

function seedConfig({ silent = false } = {}) {
  const exists = existsSync(CONFIG_PATH);
  const raw = exists ? readJsonFile(CONFIG_PATH, null) : null;
  if (exists && raw === null) {
    throw new Error(`${CONFIG_PATH} is not valid JSON — fix it or move it aside, then run setup again`);
  }
  const { config, changed } = migrateConfigObject(raw || {});
  if (changed || !exists) {
    writeJsonFile(CONFIG_PATH, config);
    if (!silent) {
      console.log(`  ${SYM_OK}  ${'config seeded'.padEnd(18)}${c.dim}${CONFIG_PATH}${c.reset}`);
    }
  } else if (!silent) {
    console.log(`  ${SYM_INFO}  ${'config current'.padEnd(18)}${c.dim}${CONFIG_PATH}${c.reset}`);
  }
  return changed || !exists;
}

function readOwnConfig() {
  return readJsonFile(CONFIG_PATH, {});
}

function nextSteps() {
  const point = (label, value, note = '') => {
    console.log(`     ${c.dim}→${c.reset}  ${c.dim}${label.padEnd(18)}${c.reset} ${c.cyan}${value}${c.reset}${note ? `  ${c.dim}${note}${c.reset}` : ''}`);
  };
  console.log('');
  console.log(`  ${SYM_OK}  ${c.bold}setup complete${c.reset} — OpenCode reloads its config automatically.`);
  point('discord portal', DISCORD_PORTAL, 'create an application to get an Application ID');
  point('your id', `clawstly-oc-rpc config set clientId "<id>"`, 'paste the Application ID from that page');
  point('card art', 'statusAssets in config.json', 'Portal asset keys or public direct GIF URLs');
  point('plugin', 'opencode plugin list', 'run this if the plugin did not reload automatically');
  point('start daemon', 'clawstly-oc-rpc start', 'then send a prompt in OpenCode');
  point('check wiring', 'clawstly-oc-rpc doctor', 'reports config, plugin, daemon and session state');
  console.log('');
}

export async function setup({ yes = false, printPlugin = false } = {}) {
  if (printPlugin) {
    process.stdout.write(`${pluginSnippet()}\n`);
    return { printPlugin: true, pluginPath: resolve(PLUGIN_DIR) };
  }

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ ${PLUGIN_NAME} setup${c.reset}  ${c.dim}v${VERSION}${c.reset}${yes ? `  ${c.gray}(non-interactive)${c.reset}` : ''}`);
  console.log('');

  let configChanged = false;
  let pluginChanged = false;
  try {
    configChanged = seedConfig();
  } catch (error) {
    console.log(`  ${SYM_WARN}  ${'config'.padEnd(18)}${c.dim}${error.message}${c.reset}`);
    hintLine(`move the file aside and run \`clawstly-oc-rpc setup\` again`);
  }
  try {
    pluginChanged = ensurePluginRegistration({ silent: false }).changed;
  } catch (error) {
    console.log(`  ${SYM_WARN}  ${'plugin'.padEnd(18)}${c.dim}${error.message}${c.reset}`);
    hintLine(`add ${pluginSnippet().replace(/\n\s*/g, ' ')} to ${OPENCODE_USER_CONFIG}`);
  }

  if (!configChanged && !pluginChanged) {
    console.log(`  ${SYM_OK}  ${c.bold}already set up${c.reset}  ${c.dim}config and plugin registration are current.${c.reset}`);
  }
  nextSteps();
  return {
    changed: configChanged || pluginChanged,
    configChanged,
    pluginChanged,
    configPath: CONFIG_PATH,
    pluginPath: resolve(PLUGIN_DIR),
  };
}

// Called by the daemon at startup. Best-effort, quiet, and idempotent: seed or
// migrate our config, and re-add the plugin registration if it drifted.
export function selfHealOnUpdate({ silent = true } = {}) {
  let from = null;
  try {
    from = readFileSync(VERSION_STAMP, 'utf8').trim().split('\n')[0] || null;
  } catch {
    from = null;
  }

  let configChanged = false;
  try {
    configChanged = seedConfig({ silent });
  } catch {
    // A broken user config must never stop the daemon.
  }

  let rewired = false;
  try {
    rewired = ensurePluginRegistration({ silent }).changed;
  } catch {
    // Same: a locked OpenCode config must never stop presence.
  }

  let autostart = true;
  try {
    autostart = readOwnConfig().autostart !== false;
  } catch {
    autostart = true;
  }

  const changed = Boolean(configChanged || rewired || from !== VERSION);
  if (changed) {
    try { writeFileAtomic(VERSION_STAMP, `${VERSION}\n`); } catch { /* best-effort */ }
  }
  return { changed, from, rewired, autostart };
}

// Diagnostics-friendly summary used by doctor.
export function pluginInfo() {
  const status = pluginStatus();
  return {
    ...status,
    pluginDir: resolve(PLUGIN_DIR),
    pluginScript: resolve(PLUGIN_SCRIPT),
    configDir: USER_CONFIG_DIR,
  };
}

// Backwards-compatible named export: some callers still look for `install`.
export const install = setup;
