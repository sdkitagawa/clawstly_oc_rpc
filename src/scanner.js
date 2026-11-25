// OpenCode session aggregate + live-session reader.
//
// Upstream claude-rpc parsed Claude Code JSONL transcripts. This fork replaces
// that layer with OpenCode plugin state files:
// the OpenCode V2 plugin writes per-session state files, and this module rolls
// those events into aggregate.json and exposes the same read API the daemon,
// CLI and local dashboard expect.

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import {
  AGGREGATE_PATH,
  DATA_DIR,
  SCAN_CACHE_PATH,
} from './paths.js';
import { languageOf } from './languages.js';
import { costFor } from './pricing.js';
import { localDateStamp } from './fmt.js';
import { listSessionStates, statePathFor } from './state.js';
import { writeFileAtomic } from './atomic-rename.js';

export const CACHE_VERSION = 1;
const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;
const TS_FLOOR = Date.UTC(2020, 0, 1);
const TS_SKEW_MS = 48 * 60 * 60 * 1000;

export function dayKey(ts) {
  return localDateStamp(new Date(ts));
}

export function dayKeyAt(now, offsetDays) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return dayKey(d.getTime());
}

export function weekKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function hourKey(ts) {
  return new Date(ts).getHours();
}

export const DATE_SUFFIX_RE = /[-_.]\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[Tt._-]?\d{0,6})?Z?$/;
export function cleanProjectName(name) {
  if (!name) return name;
  return name.replace(DATE_SUFFIX_RE, '') || name;
}

function blankDay() {
  return {
    activeMs: 0,
    userMessages: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessions: 0,
    linesAdded: 0,
    linesRemoved: 0,
    cost: 0,
    notifications: 0,
    ships: 0,
    shipKinds: {},
    firstTs: null,
    lastTs: null,
    projects: {},
  };
}

export function emptyAggregate() {
  return {
    sessions: 0,
    subagentRuns: 0,
    subagentActiveMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    toolCalls: 0,
    toolBreakdown: {},
    projects: {},
    activeMs: 0,
    wallMs: 0,
    uniqueFiles: 0,
    firstTs: null,
    lastTs: null,
    byDay: {},
    byWeek: {},
    byHour: {},
    byWeekday: {},
    fileEdits: {},
    fileEditTs: {},
    streak: 0,
    longestStreak: 0,
    daysSinceFirst: 0,
    bestDay: null,
    peakHour: null,
    topEditedFiles: [],
    linesAdded: 0,
    linesRemoved: 0,
    linesNet: 0,
    ships: 0,
    shipKinds: {},
    bashCommands: {},
    webDomains: {},
    subagents: {},
    languages: {},
    mcpToolCalls: 0,
    builtinToolCalls: 0,
    estimatedCost: 0,
    costByModel: {},
    modelsUsed: {},
    byModel: {},
    modelSplit: [],
    notifications: 0,
    generatedAt: Date.now(),
    _v: CACHE_VERSION,
    _sessionIds: {},
    _lastEventAt: null,
  };
}

function ensureDataDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }
}

export function writeAggregate(agg) {
  ensureDataDir();
  writeFileAtomic(AGGREGATE_PATH, JSON.stringify(agg, null, 2));
}

export function readAggregate() {
  try {
    if (!existsSync(AGGREGATE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(AGGREGATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function validTs(value, fallback = Date.now()) {
  const t = Number(value) || fallback;
  if (!Number.isFinite(t) || t < TS_FLOOR || t > Date.now() + TS_SKEW_MS) return fallback;
  return t;
}

function add(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function mergeBucket(target, src) {
  if (!target || !src) return target;
  for (const key of [
    'activeMs', 'userMessages', 'toolCalls', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'sessions', 'linesAdded',
    'linesRemoved', 'cost', 'notifications', 'ships',
  ]) {
    target[key] = (target[key] || 0) + (src[key] || 0);
  }
  for (const [k, v] of Object.entries(src.shipKinds || {})) add(target.shipKinds ||= {}, k, v);
  for (const [k, v] of Object.entries(src.projects || {})) {
    const p = (target.projects ||= {})[k] ||= { activeMs: 0, tokens: 0 };
    p.activeMs = (p.activeMs || 0) + (v.activeMs || 0);
    p.tokens = (p.tokens || 0) + (v.tokens || 0);
  }
  if (src.firstTs) target.firstTs = target.firstTs ? Math.min(target.firstTs, src.firstTs) : src.firstTs;
  if (src.lastTs) target.lastTs = target.lastTs ? Math.max(target.lastTs, src.lastTs) : src.lastTs;
  return target;
}

function bucketFor(agg, ts, project) {
  const day = dayKey(ts);
  const week = weekKey(ts);
  const hour = hourKey(ts);
  const weekday = new Date(ts).getDay();
  const dayBucket = mergeBucket((agg.byDay[day] ||= blankDay()), blankDay());
  const weekBucket = mergeBucket((agg.byWeek[week] ||= blankDay()), blankDay());
  const hourBucket = mergeBucket((agg.byHour[hour] ||= blankDay()), blankDay());
  const weekdayBucket = mergeBucket((agg.byWeekday[weekday] ||= blankDay()), blankDay());
  if (project) {
    for (const bucket of [dayBucket, weekBucket, hourBucket, weekdayBucket]) {
      const p = (bucket.projects ||= {})[project] ||= { activeMs: 0, tokens: 0 };
      p.activeMs = p.activeMs || 0;
      p.tokens = p.tokens || 0;
    }
  }
  return [dayBucket, weekBucket, hourBucket, weekdayBucket];
}

function applyToBuckets(agg, ts, project, fn) {
  // bucketFor() ensures the per-project sub-map exists; the caller owns the
  // deltas and applies them to both the bucket and its projects map below.
  for (const bucket of bucketFor(agg, ts, project)) fn(bucket);
}

function derive(agg) {
  const days = Object.keys(agg.byDay).sort();
  if (days.length) {
    let best = null;
    for (const k of days) {
      const d = agg.byDay[k];
      if (!best || (d.activeMs || 0) > (best.activeMs || 0)) best = { day: k, ...d };
    }
    agg.bestDay = best;
  }

  let peak = null;
  for (const [hour, d] of Object.entries(agg.byHour)) {
    if (!peak || (d.activeMs || 0) > (peak.activeMs || 0)) peak = { hour: Number(hour), activeMs: d.activeMs || 0 };
  }
  agg.peakHour = peak;

  const has = (offset) => !!agg.byDay[dayKeyAt(Date.now(), offset)];
  let streak = 0;
  if (has(0) || has(1)) {
    for (let i = has(0) ? 0 : 1; has(i); i++) streak++;
  }
  agg.streak = streak;
  agg.longestStreak = Math.max(agg.longestStreak || 0, streak);

  if (days.length) {
    const [y, m, d] = days[0].split('-').map(Number);
    const first = Math.floor(Date.UTC(y, m - 1, d, 12) / 86_400_000);
    const now = new Date();
    const today = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12) / 86_400_000);
    agg.daysSinceFirst = Math.max(1, today - first + 1);
  }

  agg.topEditedFiles = Object.entries(agg.fileEdits || {})
    .map(([path, count]) => ({ path, count, name: basename(path) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  agg.linesNet = (agg.linesAdded || 0) - (agg.linesRemoved || 0);
  agg.uniqueFiles = Math.max(agg.uniqueFiles || 0, Object.keys(agg.fileEdits || {}).length);

  const modelCosts = agg.costByModel || {};
  const costOf = (model) => Math.max(0, Number(modelCosts[model]) || 0);
  const totalModelCost = Object.values(modelCosts)
    .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
    || Math.max(0, Number(agg.estimatedCost) || 0);
  const modelSplit = Object.entries(agg.modelsUsed || {})
    .sort((a, b) => (costOf(b[0]) - costOf(a[0])) || (b[1] - a[1]))
    .slice(0, 8)
    .map(([model, count]) => ({
      model,
      count,
      costPct: totalModelCost > 0 ? Math.min(1, costOf(model) / totalModelCost) : 0,
    }));
  agg.modelSplit = modelSplit;

  agg.generatedAt = Date.now();
  return agg;
}

function advanceActive(agg, ts) {
  const prev = agg._lastEventAt;
  agg._lastEventAt = ts;
  if (!prev) return 0;
  const delta = Math.max(0, Math.min(ts - prev, ACTIVE_GAP_CAP_MS));
  return delta;
}

// Called by the OpenCode plugin for every meaningful session signal.
export function recordEvent(payload = {}) {
  const agg = readAggregate() || emptyAggregate();
  const ts = validTs(payload.ts || Date.now());
  const sessionId = payload.sessionId ? String(payload.sessionId) : null;
  const project = payload.project
    ? cleanProjectName(String(payload.project))
    : payload.cwd
      ? cleanProjectName(basename(String(payload.cwd)))
      : null;
  const kind = payload.kind || 'event';
  const activeMs = advanceActive(agg, ts);
  const activeKind = ['prompt', 'tool', 'file', 'usage'].includes(kind);
  const addActive = activeKind ? activeMs : 0;
  const tokens = payload.tokens || {};
  const inputTokens = Math.max(0, Number(tokens.input) || 0);
  const outputTokens = Math.max(0, Number(tokens.output) || 0);
  const cacheReadTokens = Math.max(0, Number(tokens.cacheRead) || 0);
  const cacheWriteTokens = Math.max(0, Number(tokens.cacheWrite) || 0);
  const model = payload.model ? String(payload.model) : null;

  agg.firstTs = agg.firstTs ? Math.min(agg.firstTs, ts) : ts;
  agg.lastTs = agg.lastTs ? Math.max(agg.lastTs, ts) : ts;

  if (kind === 'session' && sessionId && !agg._sessionIds[sessionId]) {
    agg._sessionIds[sessionId] = ts;
    agg.sessions += 1;
    applyToBuckets(agg, ts, project, (b) => { b.sessions += 1; });
  } else if (kind === 'session' && !sessionId && !agg._lastAnonymousSession) {
    agg._lastAnonymousSession = ts;
    agg.sessions += 1;
  }

  if (kind === 'prompt') agg.userMessages += 1;
  if (kind === 'tool') {
    agg.toolCalls += 1;
    add(agg.toolBreakdown, payload.toolName || payload.command?.split(/\s+/)[0] || 'tool');
    if (/bash|shell|terminal/i.test(String(payload.toolName || ''))) {
      add(agg.bashCommands, String(payload.command || '').slice(0, 120));
      agg.builtinToolCalls += 1;
    }
  }
  if (kind === 'file' && payload.filePath) {
    add(agg.fileEdits, String(payload.filePath));
    agg.fileEditTs[payload.filePath] = Math.max(agg.fileEditTs[payload.filePath] || 0, ts);
    const lang = languageOf(String(payload.filePath));
    if (lang) add(agg.languages, lang);
    agg.linesAdded += Math.max(0, Number(payload.linesAdded) || 0);
    agg.linesRemoved += Math.max(0, Number(payload.linesRemoved) || 0);
  }
  if (kind === 'usage') {
    const cost = Number(payload.cost) || costFor({ model, usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: cacheWriteTokens, cache_read_input_tokens: cacheReadTokens } });
    if (Number.isFinite(cost)) {
      agg.estimatedCost += cost;
      if (model) add(agg.costByModel, model, cost);
    }
  }
  if (kind === 'notification') agg.notifications += 1;
  if (kind === 'shipped') {
    agg.ships += 1;
    add(agg.shipKinds, payload.shipKind || 'commit');
  }

  agg.inputTokens += inputTokens;
  agg.outputTokens += outputTokens;
  agg.cacheReadTokens += cacheReadTokens;
  agg.cacheWriteTokens += cacheWriteTokens;
  agg.activeMs += addActive;
  if (model) {
    add(agg.modelsUsed, model);
    const m = (agg.byModel[model] ||= { turns: 0, tokens: 0, cost: 0 });
    m.turns += 1;
    m.tokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  }

  if (project) {
    const p = (agg.projects[project] ||= {
      sessions: 0, activeMs: 0, inputTokens: 0, outputTokens: 0,
      userMessages: 0, toolCalls: 0, linesAdded: 0, linesRemoved: 0, cost: 0,
    });
    p.activeMs += addActive;
    p.inputTokens += inputTokens;
    p.outputTokens += outputTokens;
    p.userMessages += kind === 'prompt' ? 1 : 0;
    p.toolCalls += kind === 'tool' ? 1 : 0;
    p.linesAdded += Math.max(0, Number(payload.linesAdded) || 0);
    p.linesRemoved += Math.max(0, Number(payload.linesRemoved) || 0);
  }

  applyToBuckets(agg, ts, project, (b) => {
    b.activeMs += addActive;
    b.userMessages += kind === 'prompt' ? 1 : 0;
    b.toolCalls += kind === 'tool' ? 1 : 0;
    b.inputTokens += inputTokens;
    b.outputTokens += outputTokens;
    b.cacheReadTokens += cacheReadTokens;
    b.cacheWriteTokens += cacheWriteTokens;
    b.linesAdded += Math.max(0, Number(payload.linesAdded) || 0);
    b.linesRemoved += Math.max(0, Number(payload.linesRemoved) || 0);
    b.notifications += kind === 'notification' ? 1 : 0;
    b.ships += kind === 'shipped' ? 1 : 0;
    if (kind === 'shipped') add(b.shipKinds, payload.shipKind || 'commit');
    b.firstTs = b.firstTs ? Math.min(b.firstTs, ts) : ts;
    b.lastTs = Math.max(b.lastTs || 0, ts);
    if (project) {
      const p = b.projects[project];
      p.activeMs += addActive;
      p.tokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    }
  });

  derive(agg);
  writeAggregate(agg);
  return agg;
}

export function scan({ force = false, onProgress } = {}) {
  if (onProgress) onProgress('reading OpenCode session state');
  const agg = readAggregate() || emptyAggregate();
  const states = listSessionStates();
  if (!existsSync(AGGREGATE_PATH) || force) writeAggregate(agg);
  if (onProgress) onProgress(`done · ${agg.sessions || 0} sessions · ${states.length} live state files`);
  return { aggregate: agg, files: states.length, cache: SCAN_CACHE_PATH };
}

export function findLiveSessions({ thresholdMs = 90_000, now = Date.now() } = {}) {
  const out = [];
  for (const state of listSessionStates()) {
    if (state.opencodeClosed) continue;
    const lastActivity = Number(state.lastActivity) || 0;
    if (now - lastActivity > thresholdMs) continue;
    out.push({
      sessionId: state.sessionId,
      path: statePathFor(state.sessionId),
      cwd: state.cwd,
      model: state.model,
      status: state.status,
      tokens: state.tokens,
      lastActivity,
      mtime: lastActivity,
    });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

function readStateFile(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function readSessionTokens(path) {
  const state = readStateFile(path);
  if (!state?.tokens) return null;
  const t = state.tokens;
  return {
    input: Number(t.input) || 0,
    output: Number(t.output) || 0,
    cacheRead: Number(t.cacheRead) || 0,
    cacheWrite: Number(t.cacheWrite) || 0,
  };
}

export function readSessionModel(path) {
  const state = readStateFile(path);
  return state?.model || null;
}

export { writeFileAtomic };
