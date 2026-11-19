import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

function detectSea() {
  try {
    const sea = createRequire(import.meta.url)('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

export const IS_PACKAGED = typeof process.pkg !== 'undefined' || detectSea();
export const ROOT = resolve(__dirname, '..');
export const IS_NPM_INSTALL = !IS_PACKAGED && /[\\/]node_modules[\\/]/i.test(ROOT);
export const IS_NPX = IS_NPM_INSTALL && /[\\/]_npx[\\/]/i.test(ROOT);
export const IS_INSTALLED = IS_PACKAGED || IS_NPM_INSTALL;

function userConfigDir() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'clawstly-oc-rpc');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'clawstly-oc-rpc');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'clawstly-oc-rpc');
}

export const USER_CONFIG_DIR = userConfigDir();
export const CONFIG_PATH = IS_INSTALLED
  ? join(USER_CONFIG_DIR, 'config.json')
  : join(ROOT, 'config.json');

export const CANONICAL_EXE_NAME = process.platform === 'win32' ? 'clawstly-oc-rpc.exe' : 'clawstly-oc-rpc';
export const CANONICAL_INSTALL_DIR = join(USER_CONFIG_DIR, 'bin');
export const CANONICAL_EXE = join(CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME);

export const PLUGIN_DIR = join(ROOT, 'plugin');
export const PLUGIN_SCRIPT = join(PLUGIN_DIR, 'index.ts');
// Kept for compatibility with code that still calls this concept a "hook".
export const HOOK_SCRIPT = PLUGIN_SCRIPT;
export const DAEMON_SCRIPT = IS_PACKAGED ? process.execPath : join(ROOT, 'src', 'daemon.js');
export const EXE_PATH = IS_PACKAGED ? process.execPath : null;

export const STATE_DIR = join(tmpdir(), 'clawstly-oc-rpc');
export const STATE_PATH = join(STATE_DIR, 'state.json');
export const PID_PATH = join(STATE_DIR, 'daemon.pid');
export const LOG_PATH = join(STATE_DIR, 'daemon.log');
export const DASHBOARD_PID_PATH = join(STATE_DIR, 'dashboard.pid');
export const DAEMON_INFO_PATH = join(STATE_DIR, 'daemon.json');
export const PAUSE_PATH = join(STATE_DIR, 'pause.json');
export const USAGE_CACHE_PATH = join(STATE_DIR, 'usage.json');
export const SPAWN_MARKER_PATH = join(STATE_DIR, 'daemon-spawn.ts');

export const DATA_DIR = join(homedir(), '.clawstly-oc-rpc');
export const AGGREGATE_PATH = join(DATA_DIR, 'aggregate.json');
export const SCAN_CACHE_PATH = join(DATA_DIR, 'scan-cache.json');
export const EVENTS_LOG_PATH = join(DATA_DIR, 'events.jsonl');
export const VERSION_STAMP = join(DATA_DIR, 'version');
export const STOPPED_PATH = join(DATA_DIR, 'stopped');

// OpenCode locations. V2 uses ~/.config/opencode on every platform (including
// Windows); %APPDATA%\opencode is a legacy fallback. See src/plugin-source.js
// for the full cross-platform discovery used by `source` / the launchers.
export const OPENCODE_HOME = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
export const OPENCODE_CONFIG_DIR = OPENCODE_HOME;
export const OPENCODE_CONFIG_PATH = join(OPENCODE_CONFIG_DIR, 'opencode.jsonc');
export const OPENCODE_PROJECTS = join(OPENCODE_HOME, 'projects');

export const DASHBOARD_PORT = 47474;
