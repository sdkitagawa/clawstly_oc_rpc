// Time-aware record of the model label shown on Discord.
//
// `displayModel` in config.json is the CURRENT label used by the card. Applying
// it to dashboard session rows at render time would relabel every past session
// the moment the user switches profiles. Instead we keep an append-only list of
// { at, label } changes, and each session row resolves the label that was
// effective at its own lastActivity. Blank label means "use the real model".

import { existsSync, readFileSync, statSync } from 'node:fs';
import { MODEL_HISTORY_PATH, CONFIG_PATH } from './paths.js';
import { writeFileAtomic } from './atomic-rename.js';

const MAX_ENTRIES = 100;

export function normalizeEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      at: Number(entry?.at),
      label: typeof entry?.label === 'string' ? entry.label : '',
    }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_ENTRIES);
}

export function readHistory(path = MODEL_HISTORY_PATH) {
  try {
    if (!existsSync(path)) return [];
    return normalizeEntries(JSON.parse(readFileSync(path, 'utf8'))?.entries);
  } catch {
    return [];
  }
}

function writeHistory(entries, path) {
  writeFileAtomic(path, `${JSON.stringify({ entries }, null, 2)}\n`);
}

// When the current label took effect: the config file's last write, which is
// the best available timestamp for a label that predates this history file.
export function configEffectiveTime(path = CONFIG_PATH, now = Date.now()) {
  try {
    const mtime = statSync(path).mtimeMs;
    return Number.isFinite(mtime) && mtime > 0 ? mtime : now;
  } catch {
    return now;
  }
}

// Call BEFORE overwriting displayModel. Existing rows then keep the label that
// was in effect when they were last active instead of jumping to the new one.
export function seedHistory(currentLabel, path = MODEL_HISTORY_PATH, effectiveAt = configEffectiveTime()) {
  const existing = readHistory(path);
  if (existing.length) return existing;
  const seeded = normalizeEntries([{ at: effectiveAt, label: String(currentLabel || '') }]);
  writeHistory(seeded, path);
  return seeded;
}

export function recordModelChange(label, path = MODEL_HISTORY_PATH, at = Date.now()) {
  const entries = readHistory(path);
  const nextLabel = String(label || '');
  if (entries.length && entries[entries.length - 1].label === nextLabel) return entries;
  const next = normalizeEntries([...entries, { at, label: nextLabel }]);
  writeHistory(next, path);
  return next;
}

// Returns null when no history exists at all (caller falls back to the real
// model). Timestamps before the first entry resolve to the earliest label; a
// blank label means the row should display its real OpenCode model.
export function labelAt(entries, ts) {
  const list = normalizeEntries(entries);
  if (!list.length) return null;
  const when = Number(ts);
  if (!Number.isFinite(when)) return list[list.length - 1].label;
  let label = list[0].label;
  for (const entry of list) {
    if (entry.at > when) break;
    label = entry.label;
  }
  return label;
}
