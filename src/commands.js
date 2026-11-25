// The one table of CLI commands. `help`, `help <command>`, tab completion
// (`__complete`) and the unknown-command hint all read from here, so a command,
// flag or sub-command added here shows up in all four places at once.
//
// Pure data + pure helpers: no fs, no imports from the core graph. Completion
// loads this module on every <Tab>, so it must stay cheap.

export const GROUPS = [
  ['start', 'Get started'],
  ['stats', 'Your stats'],
  ['daemon', 'Daemon & dashboard'],
  ['config', 'Configure'],
  ['fix', 'Troubleshoot'],
  ['other', 'Other'],
];

export const COMMANDS = [
  // ── Get started ──
  {
    name: 'setup', group: 'start',
    summary: 'Seed config and register the OpenCode plugin — run once',
    aliases: ['install'],
    flags: [
      ['--yes', 'Skip interactive confirmations'],
      ['--print-plugin', 'Print only the plugin JSONC snippet'],
    ],
    examples: ['clawstly-oc-rpc setup', 'clawstly-oc-rpc setup --print-plugin'],
  },

  // ── Your stats ──
  { name: 'status', group: 'stats', summary: 'One-shot daemon, session and stats snapshot' },
  { name: 'today', group: 'stats', summary: 'Today at a glance, plus your peak hour' },
  { name: 'stats', group: 'stats', summary: 'Lifetime totals from the local aggregate' },
  { name: 'streak', group: 'stats', summary: 'Current and longest active-day streak' },
  { name: 'insights', group: 'stats', summary: 'Patterns spotted in your OpenCode history' },

  // ── Daemon & dashboard ──
  {
    name: 'start-all', group: 'daemon',
    summary: 'Start daemon + dashboard server (no browser)',
    examples: ['clawstly-oc-rpc start-all'],
  },
  {
    name: 'stop-all', group: 'daemon',
    summary: 'Disable plug-in, stop daemon + server, force-stop leftovers',
    examples: ['clawstly-oc-rpc stop-all'],
  },
  {
    name: 'restart-all', group: 'daemon',
    summary: 'Restart daemon + dashboard server',
    examples: ['clawstly-oc-rpc restart-all'],
  },
  { name: 'start', group: 'daemon', summary: 'Start only the Discord presence daemon' },
  { name: 'stop', group: 'daemon', summary: 'Stop only the daemon and keep it off until start' },
  { name: 'restart', group: 'daemon', summary: 'Restart only the daemon' },
  { name: 'daemon-start', group: 'daemon', summary: 'Alias: start only the daemon' },
  { name: 'daemon-stop', group: 'daemon', summary: 'Alias: stop only the daemon' },
  {
    name: 'serve', group: 'daemon', summary: 'Start the local dashboard server (opens browser)',
    flags: [['--port', 'Port to listen on (default 47474)', 'any']],
    examples: ['clawstly-oc-rpc serve', 'clawstly-oc-rpc serve --port 5000'],
  },
  { name: 'dashboard-start', group: 'daemon', summary: 'Start the dashboard server without a browser' },
  { name: 'dashboard-stop', group: 'daemon', summary: 'Stop the dashboard server' },
  { name: 'dashboard-status', group: 'daemon', summary: 'Report dashboard server status' },
  { name: 'processes', group: 'daemon', summary: 'List daemon/dashboard Node processes (JSON)' },

  // ── Configure ──
  {
    name: 'source', group: 'config', summary: 'Show or set which OpenCode plugin copy is loaded',
    usage: '[C|D|L|M|<absolute path>|status]',
    subs: [
      ['status', 'Show the active registration and config path'],
      ['C / L', 'Use this install\'s plugin directory (Windows / macOS-Linux)'],
      ['D / M', 'Use the optional mirror plugin directory'],
    ],
    examples: [
      'clawstly-oc-rpc source status',
      'clawstly-oc-rpc source C',
      'clawstly-oc-rpc source L',
      'clawstly-oc-rpc source /opt/clawstly/plugin',
    ],
  },
  {
    name: 'model', group: 'config', summary: 'Set the model name Discord sees (RPC only)',
    usage: '[alias|custom label]',
    subs: [
      ['sol', 'Show GPT Sol'], ['luna', 'Show GPT Luna'], ['astra', 'Show GPT Astra'],
      ['opus', 'Show Claude Opus'], ['sonnet', 'Show Claude Sonnet'], ['haiku', 'Show Claude Haiku'],
      ['fable', 'Show Claude Fable'], ['real', 'Show the real model'],
    ],
    examples: ['clawstly-oc-rpc model sol', 'clawstly-oc-rpc model real', 'clawstly-oc-rpc model'],
  },
  {
    name: 'metric', group: 'config', summary: 'Show tokens, estimated cost, or both on the card',
    usage: '<tokens|cost|both>',
    subs: [
      ['tokens', 'Show token counts'], ['cost', 'Show estimated money'], ['both', 'Show both'],
    ],
    examples: ['clawstly-oc-rpc metric cost', 'clawstly-oc-rpc metric tokens', 'clawstly-oc-rpc metric'],
  },
  {
    name: 'config', group: 'config', summary: 'Read, write or edit config.json',
    usage: '<get|set|edit> [key] [json-value]',
    subs: [
      ['get', 'Print a value (or the whole config)'],
      ['set', 'Set a dotted key to a JSON value'],
      ['edit', 'Open config.json in $EDITOR'],
    ],
    examples: ['clawstly-oc-rpc config get clientId', 'clawstly-oc-rpc model sol'],
  },
  {
    name: 'private', group: 'config', summary: 'Control which folders Discord sees',
    usage: '<add|remove|list|set> [cwd] [level]',
    subs: [
      ['add', 'Hide a folder completely'],
      ['remove', 'Stop hiding a folder'],
      ['list', 'List hidden folders and visibility overrides'],
      ['set', 'Set hidden | name | public for a folder'],
    ],
    args: 'cwd',
    examples: ['clawstly-oc-rpc private add .', 'clawstly-oc-rpc private set . name', 'clawstly-oc-rpc private list'],
  },
  {
    name: 'pause', group: 'config', summary: 'Hide the card for a while (default 1h)',
    usage: '<duration|off>',
    subs: [['off', 'Show the card again']],
    aliases: ['resume', 'unpause'],
    examples: ['clawstly-oc-rpc pause 30m', 'clawstly-oc-rpc pause 2h', 'clawstly-oc-rpc pause off'],
  },

  // ── Troubleshoot ──
  { name: 'scan', group: 'fix', summary: 'Rebuild the stats aggregate',
    flags: [['--force', 'Rebuild from scratch']], aliases: ['rescan'] },
  { name: 'doctor', group: 'fix', summary: 'Check the local install and report problems' },

  // ── Other ──
  { name: 'help', group: 'other', summary: 'This screen, or one command in detail',
    usage: '[command]', args: 'command' },
];

const BY_NAME = new Map();
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd);
  for (const alias of cmd.aliases || []) BY_NAME.set(alias, cmd);
}

export const ALIAS_HINT = {
  install: 'setup',
  rescan: 'scan --force',
  resume: 'pause off',
  unpause: 'pause off',
};

export function findCommand(name) {
  return BY_NAME.get(String(name || '')) || null;
}

export function visibleCommands() {
  return COMMANDS.filter((cmd) => cmd.group);
}

// Levenshtein over small strings, for "did you mean" hints.
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function suggestCommand(input) {
  const s = String(input || '').toLowerCase();
  if (!s) return null;
  const names = [...BY_NAME.keys()];
  const prefixed = names.filter((name) => name.startsWith(s));
  if (prefixed.length && new Set(prefixed.map((name) => BY_NAME.get(name).name)).size === 1) {
    return prefixed.sort((a, b) => a.length - b.length)[0];
  }
  let best = null;
  let bestDistance = 3;
  for (const name of names) {
    const d = distance(s, name);
    if (d < bestDistance) { bestDistance = d; best = name; }
  }
  return best;
}

// ── completion ───────────────────────────────────────────────────────────
// complete(words, ctx) → lines of "value" or "value\tdescription". A lone
// '__files__' line asks the shell to fall back to file-name completion.

export const FILES = '__files__';

function matching(pairs, cur) {
  return pairs.filter(([value]) => value.startsWith(cur))
    .map(([value, description]) => (description ? `${value}\t${description}` : value));
}

function valueCandidates(kind, cur, ctx) {
  if (kind === 'file' || kind === 'cwd') return [FILES];
  if (kind === 'command') return matching(visibleCommands().map((cmd) => [cmd.name, cmd.summary]), cur);
  if (Array.isArray(kind)) return matching(kind.map((value) => [value, '']), cur);
  return [];
}

export function complete(words, ctx = {}) {
  const w = words.length ? words : [''];
  const cur = w[w.length - 1];
  if (w.length === 1) return matching(visibleCommands().map((cmd) => [cmd.name, cmd.summary]), cur);

  const cmd = findCommand(w[0]);
  if (!cmd) return [];
  const flags = cmd.flags || [];
  const prev = w[w.length - 2];

  const flag = flags.find(([name]) => name === prev);
  if (flag && flag[2] && !cur.startsWith('-')) return valueCandidates(flag[2], cur, ctx);

  if (cur.startsWith('-')) {
    const used = new Set(w.slice(1, -1));
    return matching(flags.filter(([name]) => !used.has(name)).map(([name, description]) => [name, description]), cur);
  }

  const positionals = w.slice(1, -1).filter((token, i, arr) => {
    if (token.startsWith('-')) return false;
    const before = i > 0 ? arr[i - 1] : w[0];
    const f = flags.find(([name]) => name === before);
    return !(f && f[2]);
  });
  if (positionals.length === 0) {
    if (cmd.subs) return matching(cmd.subs, cur);
    if (cmd.args) return valueCandidates(cmd.args, cur, ctx);
  }
  return [];
}
