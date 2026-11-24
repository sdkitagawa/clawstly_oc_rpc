// Pure helpers for current-session presence statistics.
//
// These helpers are intentionally dependency-free so both the OpenCode plugin
// (TypeScript, hot path) and the Node daemon/tests can import them. They parse
// the tool inputs OpenCode actually sends and normalize OpenCode's usage
// payloads without mutating anything.

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Parse JSON string inputs, but keep raw strings (patch/diff payloads) intact.
export function parseToolInput(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { /* keep the raw string */ }
  }
  return value;
}

// Count textual lines, tolerating CRLF and one trailing newline. Blank lines
// inside the text count; an empty string counts as zero.
export function countLines(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : String(value);
  const normalized = text.replace(/\r\n?/g, '\n');
  const withoutFinalBreak = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return withoutFinalBreak === '' ? 0 : withoutFinalBreak.split('\n').length;
}

function isDiffText(text) {
  return /(?:^|\n)(?:@@|@@@|\+\+\+|---|\*\*\* (?:Update|Add|Delete) File)/.test(String(text));
}

// Count unified-diff / apply_patch style + and - lines. Header lines such as
// `+++ b/file`, `--- a/file`, `*** Update File: ...`, and `\ No newline ...`
// are metadata, not churn.
export function countDiffLines(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : String(value);
  let added = 0;
  let removed = 0;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function patchText(input, parsed) {
  if (isObject(parsed)) {
    return firstString(parsed.patch, parsed.diff, parsed.patchText, parsed.rawInput, parsed.text, parsed.input);
  }
  if (typeof parsed === 'string') return parsed;
  if (isObject(input)) return firstString(input.patch, input.diff, input.patchText, input.text);
  if (typeof input === 'string') return input;
  return null;
}

// Best-effort path extraction for patch payloads that don't include a separate
// file_path field. Regular write/edit tools should already carry one.
export function filePathFromTool(toolName, input) {
  const parsed = parseToolInput(input);
  if (isObject(parsed)) {
    const direct = firstString(parsed.file_path, parsed.filePath, parsed.path, parsed.notebook_path);
    if (direct) return direct;
  }
  const text = patchText(input, parsed);
  if (!text) return null;
  const update = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/i.exec(text);
  if (update) return update[1].trim();
  const header = /^\+\+\+ (?:[ab]\/)?(.+?)(?:\t|$)/m.exec(text.replace(/\r\n?/g, '\n'));
  return header ? header[1].trim() : null;
}

// Count real added/removed lines from a write/edit/patch tool input.
export function lineDeltaFromTool(toolName, input) {
  const name = String(toolName || '').toLowerCase();
  const parsed = parseToolInput(input);
  const obj = isObject(parsed) ? parsed : {};
  const text = patchText(input, parsed);
  const empty = { added: 0, removed: 0 };

  if (/patch|apply_patch/.test(name)) {
    return text ? countDiffLines(text) : empty;
  }

  if (/write|create|save/.test(name)) {
    const content = firstString(obj.content, obj.text, obj.newContent, obj.new_content, obj.newString, text);
    const oldContent = firstString(obj.oldContent, obj.old_content, obj.oldString, obj.old_string);
    if (content == null && oldContent == null) return empty;
    return { added: countLines(content), removed: countLines(oldContent) };
  }

  if (/multiedit|multi_edit|batch_edit|edit/.test(name)) {
    const edits = Array.isArray(obj.edits)
      ? obj.edits
      : Array.isArray(obj.replacements)
        ? obj.replacements
        : [parsed];
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      if (typeof edit === 'string') {
        const delta = isDiffText(edit) ? countDiffLines(edit) : { added: countLines(edit), removed: 0 };
        added += delta.added;
        removed += delta.removed;
        continue;
      }
      if (!isObject(edit)) continue;
      const oldText = firstDefined(edit.oldString, edit.old_string, edit.oldText, edit.old_text, edit.before);
      const newText = firstDefined(edit.newString, edit.new_string, edit.newText, edit.new_text, edit.after);
      if (oldText !== undefined || newText !== undefined) {
        removed += countLines(oldText);
        added += countLines(newText);
        continue;
      }
      const diff = firstString(edit.patch, edit.diff, edit.patchText);
      if (diff) {
        const delta = countDiffLines(diff);
        added += delta.added;
        removed += delta.removed;
      }
    }
    return { added, removed };
  }

  // Unknown tools: only count when the payload is unmistakably a diff.
  if (text && isDiffText(text)) return countDiffLines(text);
  return empty;
}

// Normalize OpenCode usage payloads. Canonical fields win over legacy aliases;
// `input_tokens` from Anthropic-style payloads is already the fresh portion,
// while canonical `inputTokens` is inclusive and must have cache subtracted.
export function normalizeUsage(payload) {
  const o = isObject(payload) ? payload : {};
  const p = isObject(o.properties) ? o.properties : {};
  const candidates = [
    o.usage, o.tokens, o.message?.usage, o.message?.tokens,
    p.usage, p.tokens, p.message?.usage, p.message?.tokens,
    o.delta?.tokens, p.delta?.tokens,
  ];

  for (const candidate of candidates) {
    const u = isObject(candidate) ? candidate : {};
    if (!Object.keys(u).length) continue;
    const cache = isObject(firstDefined(u.cache, u.cached, u.cacheTokens)) ? firstDefined(u.cache, u.cached, u.cacheTokens) : {};
    const cacheRead = firstNumber(
      u.cacheReadInputTokens, u.cache_read_input_tokens,
      u.cacheRead, u.cache_read, u.cachedRead, u.readCacheTokens,
      cache.read, cache.input,
    );
    const cacheWrite = firstNumber(
      u.cacheWriteInputTokens, u.cache_write_input_tokens,
      u.cacheWrite, u.cache_write, u.cachedWrite, u.writeCacheTokens,
      cache.write, cache.output,
    );
    const inclusiveInput = firstNumber(u.inputTokens, u.promptTokens, u.prompt_tokens, u.input);
    const freshInput = firstNumber(
      u.nonCachedInputTokens, u.non_cached_input_tokens,
      u.uncachedInputTokens, u.freshInputTokens, u.input_tokens,
    );
    const output = firstNumber(u.outputTokens, u.output_tokens, u.completionTokens, u.completion_tokens, u.output);
    if (inclusiveInput == null && freshInput == null && output == null && cacheRead == null && cacheWrite == null) continue;

    let input = freshInput;
    if (input == null && inclusiveInput != null) {
      input = Math.max(0, inclusiveInput - (cacheRead || 0) - (cacheWrite || 0));
    }
    input = nonNegative(input ?? 0);
    const inclusive = inclusiveInput != null
      ? nonNegative(inclusiveInput)
      : input + nonNegative(cacheRead) + nonNegative(cacheWrite);
    const cost = firstNumber(o.cost, p.cost, u.cost, o.message?.cost, p.message?.cost, o.totalCost, p.totalCost);
    return {
      tokens: {
        input,
        output: nonNegative(output ?? 0),
        cacheRead: nonNegative(cacheRead ?? 0),
        cacheWrite: nonNegative(cacheWrite ?? 0),
      },
      inclusiveInput: inclusive,
      cost,
    };
  }

  return { tokens: null, inclusiveInput: 0, cost: firstNumber(o.cost, p.cost, o.message?.cost, p.message?.cost) };
}
