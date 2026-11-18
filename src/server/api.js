// Data helpers for the Clawstly OpenCode RPC dashboard.
//
// Everything here is a pure-ish snapshot over the core APIs (config, state,
// scanner, format, presence). No HTTP concerns, no badge/card/community/usage
// modules, and every read tolerates a missing or half-written aggregate file.

import { basename } from 'node:path';
import { loadConfig } from '../config.js';
import { readActiveState, listSessionStates } from '../state.js';
import * as scanner from '../scanner.js';
import { buildVars, fillTemplate, applyIdle, framePasses, humanModel } from '../format.js';
import { pickFrames, resolveLargeImageKey } from '../presence.js';

const LIVE_THRESHOLD_MS = 90_000;

export function emptyAggregate() {
  return {
    sessions: 0,
    userMessages: 0,
    toolCalls: 0,
    activeMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    byDay: {},
    byHour: {},
    byWeekday: {},
    projects: {},
    toolBreakdown: {},
    topEditedFiles: [],
  };
}

export function safeAggregate() {
  try {
    const agg = scanner.readAggregate();
    if (!agg || typeof agg !== 'object' || Array.isArray(agg)) return emptyAggregate();
    return agg;
  } catch {
    return emptyAggregate();
  }
}

export function safeLiveSessions() {
  try {
    const live = scanner.findLiveSessions({ thresholdMs: LIVE_THRESHOLD_MS });
    return Array.isArray(live) ? live : [];
  } catch {
    return [];
  }
}

export function safeSessionStates() {
  try {
    const states = listSessionStates();
    return Array.isArray(states) ? states : [];
  } catch {
    return [];
  }
}

export function safeConfig() {
  try { return loadConfig({ onError: () => {} }) || {}; }
  catch { return {}; }
}

function safeState() {
  let state;
  try { state = readActiveState() || {}; }
  catch { state = {}; }
  state = { ...state };
  state.liveSessions = safeLiveSessions();
  try { state = applyIdle(state, safeConfig()) || state; }
  catch { /* an odd config must not break the dashboard */ }
  return state;
}

function renderTemplate(value, vars) {
  if (typeof value !== 'string' || !value) return '';
  try { return String(fillTemplate(value, vars) ?? '').slice(0, 256); }
  catch { return value.slice(0, 256); }
}

// One small Discord-card preview: the same frame set the daemon renders, with
// the same variable substitution and gating. Large-image keys are shown as
// text only — the local UI never loads remote Discord assets itself.
export function presencePreview(config, state, vars) {
  const p = config.presence || {};
  let frames = [];
  try {
    const picked = pickFrames(p, state.status || 'idle');
    frames = Array.isArray(picked?.frames) ? picked.frames : [];
  } catch { frames = []; }

  const shown = frames.slice(0, 12).map((frame) => {
    let passes = true;
    try { passes = framePasses(frame, vars) !== false; } catch { passes = true; }
    return {
      details: renderTemplate(frame.details, vars),
      state: renderTemplate(frame.state, vars),
      largeImageText: renderTemplate(frame.largeImageText || p.largeImageText, vars),
      passes,
      requires: Array.isArray(frame.requires) ? frame.requires : null,
    };
  });
  if (shown.length && !shown.some((f) => f.passes)) shown[0].passes = true;

  let largeImage = null;
  try {
    const key = resolveLargeImageKey(config, p, state.status, state.model);
    if (typeof key === 'string' && key) largeImage = renderTemplate(key, vars);
  } catch { largeImage = null; }

  return {
    status: state.status || 'idle',
    frames: shown,
    active: shown.find((f) => f.passes) || shown[0] || null,
    largeImage,
    smallImage: typeof p.smallImageKey === 'string' ? renderTemplate(p.smallImageKey, vars) : '',
    largeImageText: renderTemplate(p.largeImageText, vars),
    smallImageText: renderTemplate(p.smallImageText, vars),
  };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function topEntries(map, limit = 8) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map)
    .map(([name, value]) => {
      const v = value && typeof value === 'object'
        ? number(value.activeMs || value.sessions || value.tokens || value.count || value.edits || 0)
        : number(value);
      const sessions = value && typeof value === 'object' ? number(value.sessions) : 0;
      return { name, value: v, sessions };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// Compact, dashboard-shaped aggregate. Missing keys become zeros/empty maps so
// the browser never has to guess whether aggregate.json exists.
export function aggregateSummary(agg = safeAggregate()) {
  const a = agg && typeof agg === 'object' ? agg : emptyAggregate();
  const tokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .reduce((sum, key) => sum + number(a[key]), 0);
  const byDay = (a.byDay && typeof a.byDay === 'object' && !Array.isArray(a.byDay)) ? a.byDay : {};
  const byHour = (a.byHour && typeof a.byHour === 'object' && !Array.isArray(a.byHour)) ? a.byHour : {};
  return {
    sessions: number(a.sessions),
    prompts: number(a.userMessages),
    toolCalls: number(a.toolCalls),
    activeMs: number(a.activeMs),
    tokens,
    tokenParts: {
      input: number(a.inputTokens),
      output: number(a.outputTokens),
      cacheRead: number(a.cacheReadTokens),
      cacheWrite: number(a.cacheWriteTokens),
    },
    projects: topEntries(a.projects),
    tools: topEntries(a.toolBreakdown),
    byDay,
    byHour,
    topEditedFiles: Array.isArray(a.topEditedFiles)
      ? a.topEditedFiles.slice(0, 8).map((e) => ({
          name: basename(String(e?.path || '')),
          count: number(e?.count),
        }))
      : [],
    estimatedCost: number(a.estimatedCost),
  };
}

// Per-session rows for the "live OpenCode sessions" panel. Transcript-only
// sessions (no hook state file yet) are included as live rows too.
export function sessionList() {
  const states = safeSessionStates();
  const live = safeLiveSessions();
  const config = safeConfig();
  const displayModel = typeof config.displayModel === 'string' ? config.displayModel.trim() : '';
  const liveByKey = new Map();
  for (const s of live) liveByKey.set(s.cwd || s.project, s);

  const rows = states.map((s) => {
    const cwd = typeof s.cwd === 'string' ? s.cwd : '';
    const match = liveByKey.get(cwd);
    const input = number(s.tokens?.input) + number(s.tokens?.cacheRead) + number(s.tokens?.cacheWrite);
    return {
      sessionId: s.sessionId || '',
      project: basename(cwd) || s.project || 'OpenCode',
      cwd,
      status: s.status || 'idle',
      model: displayModel || humanModel(s.model) || s.model || '',
      lastActivity: number(s.lastActivity),
      tokens: input + number(s.tokens?.output),
      live: !!match,
      currentTool: s.currentTool || '',
    };
  });

  const known = new Set(rows.map((r) => r.cwd).filter(Boolean));
  for (const s of live) {
    const key = s.cwd || s.project;
    if (known.has(key)) continue;
    rows.push({
      sessionId: '',
      project: s.project || (s.cwd ? basename(s.cwd) : 'OpenCode'),
      cwd: s.cwd || '',
      status: 'live',
      model: '',
      lastActivity: number(s.mtime),
      tokens: 0,
      live: true,
      currentTool: '',
    });
    known.add(key);
  }

  return rows.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 40);
}

// GET /api/state — everything the dashboard needs for one first paint.
export function snapshot() {
  const config = safeConfig();
  const state = safeState();
  const aggregate = safeAggregate();
  let vars = {};
  try { vars = buildVars(state, config, aggregate) || {}; }
  catch { vars = {}; }

  return {
    now: Date.now(),
    status: state.status || 'idle',
    state: {
      status: state.status || 'idle',
      cwd: state.cwd || '',
      model: vars.modelPretty || humanModel(state.model) || state.model || '',
      lastActivity: number(state.lastActivity),
      sessionStart: number(state.sessionStart),
      currentTool: state.currentTool || '',
    },
    liveSessions: state.liveSessions,
    sessions: sessionList(),
    presence: presencePreview(config, state, vars),
    aggregate: aggregateSummary(aggregate),
    statusText: String(state.status || 'idle').replace(/^./, (c) => c.toUpperCase()),
  };
}
