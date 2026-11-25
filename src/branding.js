// Shared display constants for Clawstly OpenCode RPC.
//
// These are RPC-facing labels only. Changing APP_NAME or a model profile never
// changes what OpenCode actually does — it only changes the Discord card text.

export const APP_NAME = 'Clawstly';
export const DEFAULT_DISPLAY_MODEL = 'Claude Opus';
export const DEFAULT_DISPLAY_METRIC = 'cost';

// Privacy-friendly model labels. The menu and CLI accept the alias or the
// exact label; anything else is passed through verbatim as a custom label.
export const MODEL_PROFILES = [
  { alias: 'sol', label: 'GPT Sol' },
  { alias: 'luna', label: 'GPT Luna' },
  { alias: 'astra', label: 'GPT Astra' },
  { alias: 'opus', label: 'Claude Opus' },
  { alias: 'sonnet', label: 'Claude Sonnet' },
  { alias: 'haiku', label: 'Claude Haiku' },
  { alias: 'fable', label: 'Claude Fable' },
];

// What Discord shows in the metric slot of each status frame.
export const METRIC_MODES = [
  { value: 'tokens', label: 'Tokens', example: '46.63M tokens' },
  { value: 'cost', label: 'Estimated cost', example: '≈$0.42' },
  { value: 'both', label: 'Both', example: '46.63M tokens · ≈$0.42' },
];

const CLEAR_ALIASES = new Set(['real', 'off', 'clear', 'none', 'default', 'auto', 'actual']);

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MODEL_ALIASES = new Map();
for (const profile of MODEL_PROFILES) {
  MODEL_ALIASES.set(profile.alias.toLowerCase(), profile.label);
  MODEL_ALIASES.set(normalize(profile.label), profile.label);
}

export function modelLabelFor(value) {
  const raw = String(value ?? '').trim();
  if (!raw || CLEAR_ALIASES.has(raw.toLowerCase())) return { label: '', cleared: true };
  const matched = MODEL_ALIASES.get(raw.toLowerCase()) || MODEL_ALIASES.get(normalize(raw));
  if (matched) return { label: matched, cleared: false };
  return { label: raw.slice(0, 64), cleared: false };
}

const METRIC_ALIASES = {
  tokens: 'tokens',
  token: 'tokens',
  count: 'tokens',
  cost: 'cost',
  money: 'cost',
  usd: 'cost',
  dollars: 'cost',
  both: 'both',
  all: 'both',
};

export function normalizeMetric(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return METRIC_ALIASES[raw] || null;
}
