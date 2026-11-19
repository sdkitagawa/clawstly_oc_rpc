// OpenCode V2 plugin for clawstly-oc-rpc.
//
// The plugin is a thin, crash-proof bridge: it maps OpenCode hooks/events onto
// the per-session state files written by ../src/state.js and forwards notable
// moments to ../src/scanner.js. Nothing here may throw into OpenCode — every
// mutating path is wrapped, every API call is optional-chained.

import { Plugin } from '@opencode/plugin';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { resetState, updateState, readState, removeState, pushUnique, shortFile } from '../src/state.js';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { recordEvent } from '../src/scanner.js';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { spawnDaemonDetached, daemonAlive, isStopped } from '../src/ensure-daemon.js';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { humanModel } from '../src/format.js';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { loadConfig } from '../src/config.js';
// @ts-ignore - core modules are plain JS, shipped without .d.ts files
import { DAEMON_SCRIPT } from '../src/paths.js';

type Bag = Record<string, any>;
type EventKind = 'session' | 'prompt' | 'tool' | 'file' | 'usage' | 'notification' | 'shipped' | 'compaction';

interface SessionInfo {
  cwd: string | null;
  modelId: string | null;
  provider: string | null;
  display: string | null;
}

interface ToolSignal {
  toolName: string;
  filePath: string | null;
  command: string | null;
  callId: string | null;
  failed: boolean;
}

const G: any = globalThis as any;
const PROC: any = G.process;
const FALLBACK_CWD: string | null = (() => {
  try { return text(PROC?.cwd?.()) ?? null; } catch { return null; }
})();

// ---- tiny defensive helpers -------------------------------------------------

function text(value: any): string | null {
  if (typeof value === 'string') return value.length ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function first(...values: any[]): any {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function obj(value: any): Bag {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
}

function number(value: any): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function projectOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function shortFilePath(path: any): string | null {
  const value = text(path);
  if (!value) return null;
  try {
    const short = shortFile(value);
    return text(short) ?? projectOf(value);
  } catch {
    return projectOf(value);
  }
}

function pushUniqueSafe(list: any, value: string): string[] {
  try { return pushUnique(Array.isArray(list) ? list : [], value); } catch { return [value]; }
}

function sessionIdFrom(...sources: any[]): string | null {
  // Explicit session keys first. V2 event envelopes carry the real session ID
  // in `data.sessionID` while their top-level `id` is only the event ID — using
  // that would silently write state under the wrong key.
  for (const source of sources) {
    const o = obj(source);
    const candidates = [
      o.sessionID, o.sessionId, o.session_id,
      o.info?.sessionID, o.info?.sessionId,
      o.session?.id, o.session?.sessionID,
      o.properties?.sessionID, o.properties?.sessionId, o.properties?.session_id,
      o.properties?.info?.id, o.properties?.session?.id,
      o.data?.sessionID, o.data?.sessionId, o.data?.session_id,
      o.data?.info?.id, o.data?.session?.id,
      o.call?.sessionID, o.event?.sessionID,
    ];
    for (const candidate of candidates) {
      const id = text(candidate);
      if (id) return id;
    }
  }
  // Fall back to bare `id` only on payload-like objects (session info, tool
  // results), never on an event envelope.
  for (const source of sources) {
    const o = obj(source);
    if (o.type && (o.data || o.durable)) continue;
    const id = text(first(o.id, o.info?.id, o.properties?.id, o.data?.id));
    if (id) return id;
  }
  return null;
}

function promptIdFrom(...sources: any[]): string | null {
  // V2 delivers user prompts as inbox events. The message/inbox ID is the only
  // stable key we have to avoid counting one prompt more than once.
  for (const source of sources) {
    const o = obj(source);
    const candidates = [
      o.inboxID, o.inboxId, o.messageID, o.messageId,
      o.properties?.inboxID, o.properties?.inboxId,
      o.properties?.messageID, o.properties?.messageId,
      o.data?.inboxID, o.data?.inboxId,
      o.data?.messageID, o.data?.messageId,
      o.data?.item?.id, o.data?.message?.id,
    ];
    for (const candidate of candidates) {
      const id = text(candidate);
      if (id) return id;
    }
  }
  return null;
}

function humanModelSafe(id: string | null): string | null {
  if (!id) return null;
  try { return text(humanModel(id)) ?? null; } catch { return null; }
}

// `stop all` writes the shared no-respawn marker. The plugin reads it on every
// side effect so it becomes inert immediately, without stopping OpenCode.
function pluginDisabled(): boolean {
  try { return !!isStopped(); } catch { return false; }
}

// Every filesystem mutation goes through here. Never let a state error reach
// an OpenCode hook or event consumer.
function mutate(sessionId: string | null, fn: (state: Bag) => Bag | void): void {
  if (pluginDisabled()) return;
  try {
    updateState((state: Bag) => {
      const next = fn(state);
      return next ?? state;
    }, sessionId ?? undefined);
  } catch {
    /* presence is best-effort */
  }
}

function touch(state: Bag, status?: string): Bag {
  const ts = Date.now();
  state.lastActivity = ts;
  state.opencodeClosed = false;
  if (!state.sessionStart) state.sessionStart = ts;
  if (status) state.status = status;
  return state;
}

function emit(kind: EventKind, fields: Bag = {}): void {
  if (pluginDisabled()) return;
  try {
    const cwd = text(fields.cwd) ?? FALLBACK_CWD;
    const ts = number(fields.ts) ?? Date.now();
    const source = obj(fields.tokens);
    const result: any = recordEvent({
      sessionId: text(fields.sessionId) ?? null,
      cwd: cwd ?? null,
      model: text(fields.model) ?? null,
      kind,
      toolName: text(fields.toolName) ?? null,
      command: text(fields.command) ?? null,
      filePath: text(fields.filePath) ?? null,
      tokens: {
        input: number(source.input) ?? 0,
        output: number(source.output) ?? 0,
        cacheRead: number(source.cacheRead) ?? 0,
        cacheWrite: number(source.cacheWrite) ?? 0,
      },
      cost: number(fields.cost) ?? 0,
      ts,
      project: text(fields.project) ?? projectOf(cwd),
    });
    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
      result.catch(() => { /* best-effort */ });
    }
  } catch {
    /* scanner is best-effort */
  }
}

// ---- model display names ----------------------------------------------------

let modelNames = new Map<string, string>();

function addModelName(provider: string | null, id: string | null, label: any): void {
  const name = text(label);
  if (!name || !id) return;
  const keys = [id, id.toLowerCase()];
  if (provider) {
    keys.push(`${provider}/${id}`, `${provider}:${id}`, `${provider}/${id}`.toLowerCase(), `${provider}:${id}`.toLowerCase());
  }
  for (const key of keys) if (!modelNames.has(key)) modelNames.set(key, name);
}

function collectModels(value: any, providerHint: string | null = null, depth = 0): void {
  if (value == null || depth > 3) return;
  if (Array.isArray(value)) {
    for (const item of value) collectModels(item, providerHint, depth + 1);
    return;
  }
  const o = obj(value);
  const provider = text(first(o.providerID, o.providerId, o.provider?.id, o.provider, providerHint, obj(o.provider).id));
  const id = text(first(o.modelID, o.modelId, o.id, o.model?.id));
  const name = text(first(o.name, o.displayName, o.title, o.label, o.model?.name));
  if (id && name) addModelName(provider, id, name);

  for (const key of ['models', 'data', 'result']) {
    if (Array.isArray(o[key])) collectModels(o[key], provider, depth + 1);
  }
  // Also tolerate maps like { providerID: { modelID: { name } } }.
  const skip = new Set(['models', 'data', 'result', 'name', 'displayName', 'title', 'label', 'id', 'modelID', 'modelId', 'provider', 'providerID', 'providerId', 'model']);
  for (const [key, child] of Object.entries(o)) {
    if (skip.has(key)) continue;
    const c = obj(child);
    const childName = text(first(c.name, c.displayName, c.title, c.label));
    if (childName) addModelName(provider, key, childName);
    if (Object.keys(c).length) collectModels(c, provider ?? key, depth + 1);
  }
}

function modelDisplay(id: string | null, provider: string | null): string | null {
  if (!id) return null;
  const keys = provider
    ? [`${provider}/${id}`, `${provider}:${id}`, id]
    : [id];
  for (const key of keys) {
    const found = modelNames.get(key) ?? modelNames.get(key.toLowerCase());
    if (found) return found;
  }
  return humanModelSafe(id);
}

function modelOf(...sources: any[]): { id: string | null; provider: string | null } {
  for (const source of sources) {
    const o = obj(source);
    const p = obj(o.properties);
    const raw = first(o.model, o.modelID, o.modelId, p.model, p.modelID, p.modelId, o.session?.model, o.info?.model);
    const rawObj = obj(raw);
    const id = text(first(rawObj.id, rawObj.modelID, rawObj.modelId, rawObj.model, raw));
    const provider = text(first(rawObj.providerID, rawObj.providerId, rawObj.provider?.id, rawObj.provider, o.providerID, o.providerId, o.provider, p.providerID, p.providerId));
    if (id) return { id, provider };
  }
  return { id: null, provider: null };
}

function infoFrom(source: any): SessionInfo {
  const o = obj(source);
  const p = obj(o.properties);
  const model = modelOf(source, p, o.session, o.info);
  const cwd = text(first(o.cwd, p.cwd, o.session?.cwd, o.info?.cwd, o.workdir, o.directory, p.workdir,
    o.location?.directory, p.location?.directory, o.data?.location?.directory));
  return { cwd, modelId: model.id, provider: model.provider, display: modelDisplay(model.id, model.provider) };
}

function mergeInfo(a: SessionInfo, b: SessionInfo): SessionInfo {
  return {
    cwd: a.cwd ?? b.cwd,
    modelId: a.modelId ?? b.modelId,
    provider: a.provider ?? b.provider,
    display: a.display ?? b.display,
  };
}

// ---- payload normalizers ----------------------------------------------------

function toolSignal(payload: any): ToolSignal {
  const o = obj(payload);
  const p = obj(o.properties);
  const rawTool = first(o.tool, o.toolName, o.name, o.tool?.name, o.tool?.id, p.tool, p.toolName, p.tool?.name, p.tool?.id, o.call?.tool);
  const toolObj = obj(rawTool);
  const toolName = text(first(toolObj.name, toolObj.id, rawTool)) ?? 'tool';

  const input = first(o.input, o.args, o.arguments, o.parameters, o.toolInput, p.input, p.args, p.arguments, p.parameters, o.tool?.input, p.tool?.input, toolObj.input);
  const io = obj(input);
  const argsText = Array.isArray(input)
    ? input.map((part: any) => text(part) ?? String(part)).join(' ')
    : text(input);
  const filePath = text(first(io.file_path, io.filePath, io.path, io.notebook_path, o.filePath, o.file, p.filePath, p.file));
  const command = text(first(io.command, io.cmd, argsText, o.command, p.command));
  const callId = text(first(o.callID, o.callId, o.toolCallID, o.toolCallId, o.id, p.callID, p.callId, p.id, o.call?.id));
  const failed = o.error != null || o.isError === true || o.ok === false || o.success === false ||
    o.status === 'error' || obj(o.result).isError === true ||
    p.error != null || p.isError === true || p.ok === false || p.success === false;

  return { toolName, filePath, command, callId, failed };
}

function shellSignal(payload: any): ToolSignal {
  const o = obj(payload);
  const p = obj(o.properties);
  const commandText = text(first(o.command, p.command, o.cmd, p.cmd));
  const rawArgs = first(o.args, p.args, o.arguments, p.arguments);
  const argsText = Array.isArray(rawArgs)
    ? rawArgs.map((part: any) => text(part) ?? String(part)).join(' ')
    : text(rawArgs);
  let command = text(first(commandText, argsText));
  if (commandText && argsText && commandText.indexOf(argsText) === -1) {
    command = `${commandText} ${argsText}`.trim();
  }
  return {
    toolName: 'Bash',
    filePath: text(first(o.filePath, p.filePath)) ?? null,
    command: command || null,
    callId: text(first(o.callID, o.callId, p.callID, p.callId)) ?? null,
    failed: o.error != null || p.error != null || o.ok === false || p.ok === false,
  };
}

const WRITE_TOOL_RE = /(write|edit|patch|apply|save|create|notebook)/i;
const READ_TOOL_RE = /(read|view|cat|inspect|open|search|grep|glob|list)/i;
const SHELL_TOOL_RE = /(bash|shell|terminal|exec)/i;

// Local implementation of ships.classifyShip: push > commit > pr > issue > tag.
// Kept local so the plugin has no extra module dependency on the hook hot path.
function classifyShipCommand(command: string | null): string | null {
  if (!command) return null;
  const blanked = String(command)
    .replace(/'[^']*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
  const rank: Record<string, number> = { push: 5, commit: 4, pr: 3, issue: 2, tag: 1 };
  let best: string | null = null;
  const offer = (kind: string): void => {
    if (!best || rank[kind] > rank[best]) best = kind;
  };
  for (const segment of blanked.split(/[;&|\n]+/)) {
    let tokens = segment.trim()
      .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
      .split(/\s+/)
      .filter(Boolean);
    while (tokens.length && /^(sudo|time)$/i.test(tokens[0])) tokens = tokens.slice(1);
    if (!tokens.length) continue;
    const bin = (tokens[0].split(/[\\/]/).pop() || '').toLowerCase();
    if (bin === 'git') {
      let sub: string | null = null;
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '-C' || token === '-c') { i++; continue; }
        if (token.startsWith('-')) continue;
        sub = token.toLowerCase();
        break;
      }
      if (sub === 'push') offer('push');
      else if (sub === 'commit') offer('commit');
    } else if (bin === 'gh') {
      const positional: string[] = [];
      for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '-R' || token === '--repo') { i++; continue; }
        if (token.startsWith('-')) continue;
        positional.push(token.toLowerCase());
        if (positional.length === 2) break;
      }
      if (positional[0] === 'pr' && positional[1] === 'create') offer('pr');
      else if (positional[0] === 'issue' && positional[1] === 'create') offer('issue');
      else if (positional[0] === 'release' && positional[1] === 'create') offer('tag');
    }
  }
  return best;
}

function commitSubject(command: string | null): string | null {
  if (!command) return null;
  const match = /(?:^|\s)-m(?:\s+|=)(\"((?:\\.|[^\"\\])*)\"|'([^']*)')/.exec(command);
  const subject = match?.[2] ?? match?.[3] ?? null;
  return subject ? subject.slice(0, 120) : null;
}

function markShipped(state: Bag, kind: string, command: string | null): void {
  const ts = Date.now();
  state.justShipped = ts;
  state.justShippedKind = kind;
  state.justShippedSubject = (kind === 'commit' || kind === 'push') ? commitSubject(command) : null;
}

function usageFrom(payload: any): { tokens: Bag | null; cost: number | null } {
  const o = obj(payload);
  const p = obj(o.properties);
  const candidates = [
    o.usage, o.tokens, o.message?.tokens, o.message?.usage,
    p.usage, p.tokens, p.message?.tokens, p.message?.usage,
    obj(o.delta).tokens, obj(p.delta).tokens,
  ];
  for (const candidate of candidates) {
    const u = obj(candidate);
    if (!Object.keys(u).length) continue;
    const cache = obj(first(u.cache, u.cached, u.cacheTokens));
    const input = number(first(u.input, u.inputTokens, u.promptTokens, u.input_tokens, u.prompt_tokens));
    const output = number(first(u.output, u.outputTokens, u.completionTokens, u.output_tokens, u.completion_tokens));
    const cacheRead = number(first(u.cacheRead, u.cache_read, u.cachedRead, u.readCacheTokens, cache.read, cache.input));
    const cacheWrite = number(first(u.cacheWrite, u.cache_write, u.cachedWrite, u.writeCacheTokens, cache.write, cache.output));
    if (input == null && output == null && cacheRead == null && cacheWrite == null) continue;
    const cost = number(first(o.cost, p.cost, u.cost, o.message?.cost, p.message?.cost, o.totalCost, p.totalCost));
    return {
      tokens: { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 },
      cost,
    };
  }
  return { tokens: null, cost: number(first(o.cost, p.cost, o.message?.cost, p.message?.cost)) };
}

// ---- plugin definition ------------------------------------------------------

export default Plugin.define({
  id: 'clawstly-oc-rpc',
  async setup(ctx: any) {
    const controller = new AbortController();
    const seenSessions = new Set<string>();
    const seenPromptIds = new Set<string>();
    const toolCache = new Map<string, { at: number; signal: ToolSignal }>();
    const sessionInfoCache = new Map<string, { at: number; info: SessionInfo }>();
    const signalHandlers = new Map<string, () => void>();
    const registrations: Array<{ dispose?: () => void | Promise<void> }> = [];
    let modelListPromise: Promise<void> | null = null;
    let exitHandler: (() => void) | null = null;

    const rememberSeen = (sessionId: string | null): void => {
      if (!sessionId) return;
      seenSessions.add(sessionId);
      if (seenSessions.size > 300) {
        const oldest = seenSessions.values().next().value as string | undefined;
        if (oldest) seenSessions.delete(oldest);
      }
    };

    // ---- startup (best effort, never throws) ----
    try {
      let autostart = true;
      try {
        const cfg = loadConfig();
        if (cfg && cfg.autostart === false) autostart = false;
      } catch { /* unreadable config — default on */ }
      const env = PROC?.env ?? {};
      if (env.CLAWSTLY_OC_RPC_NO_AUTOSTART === '1') autostart = false;

      if (autostart && !pluginDisabled()) {
        let alive = false;
        try { alive = !!daemonAlive(); } catch { /* unknown */ }
        if (!alive) {
          try { spawnDaemonDetached(); } catch { /* no daemon this run */ }
        }
      }

      let hadState = false;
      try { hadState = !!readState()?.lastActivity; } catch { /* no state yet */ }
      mutate(null, (s) => {
        touch(s, 'idle');
        s.opencodeClosed = false;
        s.cwd = s.cwd ?? FALLBACK_CWD ?? null;
        s.model = s.model ?? 'opencode';
        s.daemonScript = text(DAEMON_SCRIPT) ?? null;
        s.startupResumed = hadState;
        s.lastStartup = Date.now();
        // The global state.json is the daemon's fallback when no per-session
        // file exists yet. touch() only sets sessionStart when missing, so a
        // preserved state file would otherwise anchor Discord's elapsed timer
        // to a previous OpenCode run (hours/days ago). Per-session files keep
        // their own accurate sessionStart; only this fallback is re-anchored.
        s.sessionStart = s.lastStartup;
        return s;
      });
    } catch { /* setup must never break OpenCode */ }

    const ensureModelNames = (): Promise<void> => {
      if (!modelListPromise) {
        modelListPromise = Promise.resolve()
          .then(() => ctx?.model?.list?.())
          .then((list: any) => { collectModels(list); })
          .catch(() => { /* fall back to humanModel() */ });
      }
      return modelListPromise;
    };
    void ensureModelNames();

    const sessionInfo = async (sessionId: string | null, hint?: any): Promise<SessionInfo> => {
      const fromHint = infoFrom(hint);
      if (fromHint.cwd && fromHint.modelId) return mergeInfo(fromHint, modelDisplayGeneric(fromHint));
      if (!sessionId) return fromHint;

      const cached = sessionInfoCache.get(sessionId);
      if (cached && Date.now() - cached.at < 10_000) return mergeInfo(cached.info, fromHint);

      let info = fromHint;
      try {
        const data = await ctx?.session?.get?.({ sessionID: sessionId });
        info = mergeInfo(infoFrom(data), info);
      } catch { /* session may be gone already */ }
      if (!info.cwd && typeof ctx?.session?.list === 'function') {
        try {
          const list = await ctx.session.list();
          const found = Array.isArray(list)
            ? list.find((entry: any) => text(first(obj(entry).id, obj(entry).sessionID)) === sessionId)
            : null;
          if (found) info = mergeInfo(infoFrom(found), info);
        } catch { /* ignore */ }
      }
      if (!info.modelId && typeof ctx?.session?.context === 'function') {
        try {
          const context = await ctx.session.context({ sessionID: sessionId });
          info = mergeInfo(infoFrom(context), info);
        } catch { /* ignore */ }
      }
      info = mergeInfo(info, modelDisplayGeneric(info));
      sessionInfoCache.set(sessionId, { at: Date.now(), info });
      if (sessionInfoCache.size > 300) {
        const oldest = sessionInfoCache.keys().next().value as string | undefined;
        if (oldest) sessionInfoCache.delete(oldest);
      }
      return info;
    };

    function modelDisplayGeneric(info: SessionInfo): SessionInfo {
      return { ...info, display: info.display ?? modelDisplay(info.modelId, info.provider) };
    }

    function rememberTool(signal: ToolSignal): void {
      if (!signal.callId) return;
      toolCache.set(signal.callId, { at: Date.now(), signal });
      if (toolCache.size > 300) {
        const oldest = toolCache.keys().next().value as string | undefined;
        if (oldest) toolCache.delete(oldest);
      }
    }

    function recallTool(signal: ToolSignal): ToolSignal {
      if (!signal.callId) return signal;
      const hit = toolCache.get(signal.callId);
      if (!hit || Date.now() - hit.at > 5 * 60_000) return signal;
      toolCache.delete(signal.callId);
      return {
        toolName: signal.toolName !== 'tool' ? signal.toolName : hit.signal.toolName,
        filePath: signal.filePath ?? hit.signal.filePath,
        command: signal.command ?? hit.signal.command,
        callId: signal.callId,
        failed: signal.failed || hit.signal.failed,
      };
    }

    function markClosed(sessionId: string | null, reason: string, all = false): void {
      const targets: Array<string | null> = all ? [null, ...seenSessions] : [sessionId, null];
      for (const target of targets) {
        mutate(target, (s) => {
          const ts = Date.now();
          s.opencodeClosed = true;
          s.status = 'stale';
          s.lastActivity = ts;
          s.currentTool = null;
          s.toolStartedAt = null;
          s.currentFile = null;
          s.closeReason = reason;
          return s;
        });
      }
    }

    // ---- signal handlers ----
    try {
      for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        try {
          if (typeof PROC?.once !== 'function') break;
          const handler = (): void => {
            markClosed(null, `signal:${signalName}`, true);
            try {
              PROC.removeListener?.(signalName, handler);
              if ((PROC.listenerCount?.(signalName) ?? 1) === 0) PROC.kill?.(PROC.pid, signalName);
            } catch { /* never interfere with shutdown */ }
          };
          PROC.once(signalName, handler);
          signalHandlers.set(signalName, handler);
        } catch { /* unsupported signal */ }
      }
      if (typeof PROC?.once === 'function') {
        exitHandler = () => markClosed(null, 'exit', true);
        PROC.once('exit', exitHandler);
      }
    } catch { /* process unavailable */ }

    // ---- hook registrations ----
    const hook = async (scope: any, name: string, handler: (payload: any) => any): Promise<void> => {
      try {
        const registration = await scope?.hook?.(name, handler);
        if (registration && typeof registration.dispose === 'function') registrations.push(registration);
      } catch { /* hook unsupported by this version */ }
    };

    // The admission hook sets the early "thinking" state but does not count the
    // message: V2 delivers the canonical user prompt as session.inbox.delivered,
    // and counting both would double every prompt. The event path passes
    // countMessage: true and de-duplicates by inbox/message ID.
    const onPrompt = async (payload: any, options: { countMessage?: boolean } = {}): Promise<void> => {
      try {
        const countMessage = options.countMessage === true;
        const promptId = promptIdFrom(payload);
        if (countMessage && promptId) {
          if (seenPromptIds.has(promptId)) return;
          seenPromptIds.add(promptId);
          if (seenPromptIds.size > 500) {
            const oldest = seenPromptIds.values().next().value as string | undefined;
            if (oldest) seenPromptIds.delete(oldest);
          }
        }
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        void ensureModelNames();
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId) ?? 'opencode';
        const ts = Date.now();
        mutate(sessionId, (s) => {
          touch(s, 'thinking');
          if (countMessage) {
            s.messages = (Number(s.messages) || 0) + 1;
            s.lastUserPrompt = ts;
          }
          s.cwd = cwd ?? s.cwd ?? null;
          s.model = model;
          if (info.provider) s.modelProvider = info.provider;
          return s;
        });
        emit('prompt', { sessionId, cwd, model, ts });
      } catch { /* hooks never throw */ }
    };

    const onToolBefore = async (payload: any): Promise<void> => {
      try {
        const signal = toolSignal(payload);
        rememberTool(signal);
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId);
        const ts = Date.now();
        mutate(sessionId, (s) => {
          touch(s, 'working');
          s.tools = (Number(s.tools) || 0) + 1;
          if (!s.toolBreakdown || typeof s.toolBreakdown !== 'object') s.toolBreakdown = {};
          s.toolBreakdown[signal.toolName] = (Number(s.toolBreakdown[signal.toolName]) || 0) + 1;
          s.currentTool = signal.toolName;
          s.currentFile = shortFilePath(signal.filePath);
          s.toolStartedAt = ts;
          if (SHELL_TOOL_RE.test(signal.toolName) && signal.command) {
            s.lastBashCommand = String(signal.command).slice(0, 500);
            s.lastBashAt = ts;
          }
          if (signal.filePath && READ_TOOL_RE.test(signal.toolName)) {
            s.filesOpened = pushUniqueSafe(s.filesOpened, signal.filePath);
            if (/read/i.test(signal.toolName)) s.filesRead = pushUniqueSafe(s.filesRead, signal.filePath);
          }
          return s;
        });
        emit('tool', { sessionId, cwd, model, toolName: signal.toolName, command: signal.command, filePath: signal.filePath, ts });
      } catch { /* hooks never throw */ }
    };

    const onToolAfter = async (payload: any): Promise<void> => {
      try {
        const signal = recallTool(toolSignal(payload));
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId);
        const ts = Date.now();
        const wroteFile = !!signal.filePath && WRITE_TOOL_RE.test(signal.toolName);
        const shipped = !signal.failed && SHELL_TOOL_RE.test(signal.toolName)
          ? classifyShipCommand(signal.command)
          : null;

        mutate(sessionId, (s) => {
          touch(s);
          s.currentTool = null;
          s.toolStartedAt = null;
          s.currentFile = null;
          if (wroteFile && signal.filePath) {
            s.currentFile = shortFilePath(signal.filePath);
            s.filesEdited = pushUniqueSafe(s.filesEdited, signal.filePath);
            s.filesOpened = pushUniqueSafe(s.filesOpened, signal.filePath);
            s.filesRead = pushUniqueSafe(s.filesRead, signal.filePath);
          }
          if (shipped) markShipped(s, shipped, signal.command);
          return s;
        });
        emit('tool', { sessionId, cwd, model, toolName: signal.toolName, command: signal.command, filePath: signal.filePath, ts });
        if (wroteFile) emit('file', { sessionId, cwd, model, toolName: signal.toolName, filePath: signal.filePath, ts });
        if (shipped) emit('shipped', { sessionId, cwd, model, command: signal.command, ts });
      } catch { /* hooks never throw */ }
    };

    const onShellBefore = async (payload: any): Promise<void> => {
      try {
        const signal = shellSignal(payload);
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId);
        const ts = Date.now();
        const shipped = classifyShipCommand(signal.command);
        mutate(sessionId, (s) => {
          touch(s, 'working');
          s.tools = (Number(s.tools) || 0) + 1;
          if (!s.toolBreakdown || typeof s.toolBreakdown !== 'object') s.toolBreakdown = {};
          s.toolBreakdown.Bash = (Number(s.toolBreakdown.Bash) || 0) + 1;
          s.currentTool = 'Bash';
          s.toolStartedAt = ts;
          if (signal.command) {
            s.lastBashCommand = String(signal.command).slice(0, 500);
            s.lastBashAt = ts;
          }
          if (shipped) markShipped(s, shipped, signal.command);
          return s;
        });
        emit('tool', { sessionId, cwd, model, toolName: 'Bash', command: signal.command, ts });
        if (shipped) emit('shipped', { sessionId, cwd, model, command: signal.command, ts });
      } catch { /* hooks never throw */ }
    };

    const onNotification = async (payload: any): Promise<void> => {
      try {
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId);
        const ts = Date.now();
        const message = text(first(obj(payload).message, obj(payload).title, obj(obj(payload).properties).message, obj(obj(payload).properties).title));
        mutate(sessionId, (s) => {
          touch(s, 'notification');
          s.lastNotification = ts;
          s.currentTool = null;
          s.currentFile = null;
          if (message) s.lastNotificationMessage = String(message).slice(0, 300);
          return s;
        });
        emit('notification', { sessionId, cwd, model, ts });
      } catch { /* hooks never throw */ }
    };

    const onPermission = async (payload: any, replied: boolean): Promise<void> => {
      try {
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const o = obj(payload);
        const p = obj(o.properties);
        const permission = text(first(o.permission, o.type, o.name, p.permission, p.type, p.name));
        const ts = Date.now();
        if (replied) {
          mutate(sessionId, (s) => {
            touch(s, s.currentTool ? 'working' : 'thinking');
            s.currentPermission = null;
            return s;
          });
          return;
        }
        mutate(sessionId, (s) => {
          touch(s, 'notification');
          s.lastNotification = ts;
          s.currentPermission = permission ?? 'permission';
          return s;
        });
        const info = await sessionInfo(sessionId, payload);
        emit('notification', { sessionId, cwd: info.cwd ?? FALLBACK_CWD, model: info.display ?? humanModelSafe(info.modelId), ts });
      } catch { /* hooks never throw */ }
    };

    const onCompaction = async (payload: any, ended: boolean): Promise<void> => {
      try {
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const o = obj(payload);
        const p = obj(o.properties);
        const trigger = text(first(o.trigger, o.matcher, o.source, p.trigger, p.matcher, p.source));
        const manual = /manual/i.test(trigger ?? '');
        const ts = Date.now();
        mutate(sessionId, (s) => {
          if (ended) {
            delete s.compactStartedAt;
            delete s.compactTrigger;
            touch(s, manual ? 'idle' : 'working');
          } else {
            touch(s, 'compacting');
            s.compactStartedAt = ts;
            s.compactTrigger = trigger ?? null;
            s.currentTool = null;
            s.currentFile = null;
          }
          return s;
        });
        const info = await sessionInfo(sessionId, payload);
        emit('compaction', { sessionId, cwd: info.cwd ?? FALLBACK_CWD, model: info.display ?? humanModelSafe(info.modelId), ts });
      } catch { /* hooks never throw */ }
    };

    const onIdle = async (payload: any): Promise<void> => {
      try {
        const sessionId = sessionIdFrom(payload);
        mutate(sessionId, (s) => {
          touch(s, 'idle');
          s.currentTool = null;
          s.toolStartedAt = null;
          s.currentFile = null;
          delete s.compactStartedAt;
          delete s.compactTrigger;
          return s;
        });
      } catch { /* events never throw */ }
    };

    const onUsage = async (payload: any): Promise<void> => {
      try {
        const sessionId = sessionIdFrom(payload);
        rememberSeen(sessionId);
        const { tokens, cost } = usageFrom(payload);
        if (!tokens && cost == null) return;
        const o = obj(payload);
        const p = obj(o.properties);
        const isDelta = o.delta === true || p.delta === true || o.accumulate === false;
        mutate(sessionId, (s) => {
          touch(s);
          const previous = obj(s.tokens);
          if (tokens) {
            const keys = ['input', 'output', 'cacheRead', 'cacheWrite'];
            if (isDelta) {
              const next: Bag = {};
              for (const key of keys) next[key] = (Number(previous[key]) || 0) + (Number(tokens[key]) || 0);
              s.tokens = next;
            } else {
              const next: Bag = {};
              for (const key of keys) next[key] = number(tokens[key]) ?? Number(previous[key]) ?? 0;
              s.tokens = next;
            }
          }
          if (cost != null) s.cost = isDelta ? (Number(s.cost) || 0) + cost : cost;
          return s;
        });
        const info = await sessionInfo(sessionId, payload);
        emit('usage', { sessionId, cwd: info.cwd ?? FALLBACK_CWD, model: info.display ?? humanModelSafe(info.modelId), tokens, cost });
      } catch { /* events never throw */ }
    };

    await hook(ctx?.session, 'prompt', onPrompt);
    await hook(ctx?.tool, 'execute.before', onToolBefore);
    await hook(ctx?.tool, 'execute.after', onToolAfter);
    await hook(ctx?.shell, 'create.before', onShellBefore);
    await hook(ctx?.permission, 'evaluate', (payload: any) => {
      const o = obj(payload);
      const p = obj(o.properties);
      const replied = o.replied === true || o.answered === true || o.decision != null ||
        o.approved != null || o.granted != null || p.replied === true || p.decision != null ||
        /replied|answered|decided/.test(String(first(o.type, o.phase, p.type, p.phase) ?? '').toLowerCase());
      return onPermission(payload, replied);
    });
    await hook(ctx?.session, 'compaction', (payload: any) => {
      const o = obj(payload);
      const p = obj(o.properties);
      const phase = text(first(o.phase, o.status, p.phase, p.status));
      return onCompaction(payload, /end|done|complete|finish|after|post/i.test(phase ?? ''));
    });

    // ---- event subscription ----
    void (async () => {
      try {
        const stream = ctx?.event?.subscribe?.({ signal: controller.signal });
        if (!stream) return;
        for await (const event of stream) {
          try {
            await handleEvent(event);
          } catch { /* one bad event must not kill the subscription */ }
        }
      } catch { /* aborted, unsupported, or subscription closed */ }
    })();

    async function handleEvent(event: any): Promise<void> {
      const type = String(first(obj(event).type, obj(event).event, obj(event).kind) ?? '').toLowerCase();
      if (!type || pluginDisabled()) return;
      const payload = first(obj(event).properties, obj(event).data, event) ?? {};
      const sessionId = sessionIdFrom(event, payload);
      rememberSeen(sessionId);

      if (type === 'session.created') {
        const info = await sessionInfo(sessionId, payload);
        const cwd = info.cwd ?? FALLBACK_CWD;
        const model = info.display ?? humanModelSafe(info.modelId) ?? 'opencode';
        const ts = Date.now();
        try {
          if (!pluginDisabled()) {
            resetState({
              cwd: cwd ?? null,
              model,
              project: projectOf(cwd),
              status: 'idle',
              lastActivity: ts,
              lastEventAt: ts,
              opencodeClosed: false,
              sessionStart: ts,
            }, sessionId ?? undefined);
          }
        } catch { /* best effort */ }
        emit('session', { sessionId, cwd, model, ts });
        return;
      }

      if (type.startsWith('session.deleted') || type.startsWith('session.removed')) {
        try { if (!pluginDisabled()) removeState(sessionId ?? undefined); } catch { /* best effort */ }
        if (sessionId) seenSessions.delete(sessionId);
        return;
      }

      // In V2 a delivered inbox item is the user's prompt, not a notification.
      // Counting it here is what keeps the dashboard's message counter honest.
      if (type === 'session.inbox.delivered') {
        await onPrompt(payload, { countMessage: true });
        return;
      }

      if (type.startsWith('form.') || type.includes('notification')) {
        await onNotification(payload);
        return;
      }

      if (type.startsWith('session.tool')) {
        if (/before|start|begin|call/.test(type)) await onToolBefore(payload);
        else if (/after|end|finish|complete|error|fail/.test(type)) await onToolAfter(payload);
        else {
          const signal = toolSignal(payload);
          mutate(sessionId, (s) => {
            touch(s, s.status === 'idle' ? 'working' : s.status);
            if (signal.toolName !== 'tool') s.currentTool = signal.toolName;
            return s;
          });
        }
        return;
      }

      if (type.startsWith('session.step')) {
        mutate(sessionId, (s) => touch(s, /start|begin/.test(type) ? 'thinking' : undefined));
        return;
      }

      if (type.startsWith('session.execution')) {
        // An "execution" is one agent turn, not the whole session: finishing one
        // means the card goes idle, not stale. Real shutdown is handled below.
        if (/end|complete|stop|cancel|fail|error|interrupt|succeed/.test(type)) await onIdle(payload);
        else mutate(sessionId, (s) => touch(s, 'working'));
        return;
      }

      if (type.startsWith('session.compaction')) {
        const p = obj(payload);
        const phase = text(first(p.phase, p.status, p.state, p.type));
        await onCompaction(payload, /end|done|complete|finish|after|post/.test(`${type} ${phase ?? ''}`.toLowerCase()));
        return;
      }

      if (type.startsWith('permission')) {
        await onPermission(payload, /replied|answered|decided|resolved/.test(type));
        return;
      }

      if (type.startsWith('session.usage')) {
        await onUsage(payload);
        return;
      }

      if (type.startsWith('session.idle')) {
        await onIdle(payload);
        return;
      }

      // No session.closed event exists in V2 — use execution/shutdown signals.
      if (/(^|\.)(shutdown|terminate|quit|exit|closed)($|\.)/.test(type) || type.includes('app.shutdown') || type.includes('server.shutdown')) {
        markClosed(null, type, true);
      }
    }

    // ---- cleanup ----
    return () => {
      try { controller.abort(); } catch { /* already aborted */ }
      for (const registration of registrations) {
        try { void Promise.resolve(registration.dispose?.()).catch(() => { /* best effort */ }); } catch { /* ignore */ }
      }
      registrations.length = 0;
      for (const [signalName, handler] of signalHandlers) {
        try { PROC?.removeListener?.(signalName, handler); } catch { /* ignore */ }
      }
      signalHandlers.clear();
      if (exitHandler) {
        try { PROC?.removeListener?.('exit', exitHandler); } catch { /* ignore */ }
        exitHandler = null;
      }
    };
  },
});
