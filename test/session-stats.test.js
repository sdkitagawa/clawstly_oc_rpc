import {
  countDiffLines,
  countLines,
  filePathFromTool,
  lineDeltaFromTool,
  normalizeUsage,
  parseToolInput,
} from '../src/session-stats.js';

export async function run({ test, assert }) {
  test('line counting tolerates CRLF and a trailing newline', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('one'), 1);
    assert.equal(countLines('one\ntwo'), 2);
    assert.equal(countLines('one\r\ntwo\r\n'), 2);
    assert.equal(countLines('one\n\n'), 2);
  });

  test('parseToolInput keeps raw patch strings', () => {
    assert.deepEqual(parseToolInput('{"a":1}'), { a: 1 });
    assert.equal(parseToolInput('@@ -1 +1 @@'), '@@ -1 +1 @@');
    assert.equal(parseToolInput(null), null);
  });

  test('lineDeltaFromTool counts write, edit, and multiedit diffs', () => {
    assert.deepEqual(
      lineDeltaFromTool('write', { filePath: 'a.js', content: 'a\nb\nc\n' }),
      { added: 3, removed: 0 },
    );
    assert.deepEqual(
      lineDeltaFromTool('write', { filePath: 'a.js', content: 'new\n', oldContent: 'old1\nold2\n' }),
      { added: 1, removed: 2 },
    );
    assert.deepEqual(
      lineDeltaFromTool('edit', { filePath: 'a.js', oldString: 'a\nb', newString: 'a\nc\nd' }),
      { added: 3, removed: 2 },
    );
    assert.deepEqual(
      lineDeltaFromTool('multiedit', {
        edits: [
          { oldString: 'one', newString: 'ONE' },
          { oldString: 'a\nb', newString: 'a\nb\nc' },
        ],
      }),
      { added: 4, removed: 3 },
    );
  });

  test('lineDeltaFromTool parses unified patches and apply_patch text', () => {
    const patch = [
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-old line',
      '+new line',
      '+another line',
    ].join('\n');
    assert.deepEqual(countDiffLines(patch), { added: 2, removed: 1 });
    assert.deepEqual(lineDeltaFromTool('patch', { patch }), { added: 2, removed: 1 });
    assert.deepEqual(
      lineDeltaFromTool('apply_patch', { input: '*** Update File: src/app.js\n-old\n+new\n' }),
      { added: 1, removed: 1 },
    );
    assert.equal(filePathFromTool('patch', { patch }), 'src/app.js');
  });

  test('unknown tools with no diff do not report churn', () => {
    assert.deepEqual(lineDeltaFromTool('read', { filePath: 'a.js' }), { added: 0, removed: 0 });
    assert.deepEqual(lineDeltaFromTool('write', {}), { added: 0, removed: 0 });
  });

  test('normalizeUsage prefers canonical OpenCode fields', () => {
    const canonical = normalizeUsage({
      properties: {
        usage: {
          inputTokens: 10_000,
          outputTokens: 2_000,
          nonCachedInputTokens: 1_200,
          cacheReadInputTokens: 8_000,
          cacheWriteInputTokens: 800,
        },
      },
    });
    assert.deepEqual(canonical.tokens, {
      input: 1_200, output: 2_000, cacheRead: 8_000, cacheWrite: 800,
    });
    assert.equal(canonical.inclusiveInput, 10_000);
  });

  test('normalizeUsage derives fresh input from inclusive input when needed', () => {
    const legacy = normalizeUsage({
      usage: { inputTokens: 5_000, outputTokens: 500, cacheRead: 4_000, cacheWrite: 200 },
    });
    assert.deepEqual(legacy.tokens, {
      input: 800, output: 500, cacheRead: 4_000, cacheWrite: 200,
    });
  });

  test('normalizeUsage treats Anthropic input_tokens as already fresh', () => {
    const anthropic = normalizeUsage({
      usage: { input_tokens: 1_500, output_tokens: 300, cache_read_input_tokens: 9_000 },
    });
    assert.deepEqual(anthropic.tokens, {
      input: 1_500, output: 300, cacheRead: 9_000, cacheWrite: 0,
    });
    assert.equal(anthropic.inclusiveInput, 10_500);
  });
}
