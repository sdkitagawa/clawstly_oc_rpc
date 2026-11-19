import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_NAME, modelLabelFor, normalizeMetric } from '../src/branding.js';
import { DEFAULT_CONFIG } from '../src/default-config.js';
import { buildVars, humanModel } from '../src/format.js';
import { EVENTS, pluginSnippet } from '../src/install.js';
import { pickActiveSession, resolveLargeImageKey, throttleDecision } from '../src/presence.js';
import { dayKeyAt, weekKey, cleanProjectName, emptyAggregate } from '../src/scanner.js';
import { validateConfig } from '../src/server/settings.js';
import {
  isOurPluginEntry, pluginRegistrationIssues, readPluginsArray, replacePluginsArray, sourceStatus,
} from '../src/plugin-source.js';
import { classifyCommand, stopAll } from '../src/process-control.js';
import {
  labelAt, normalizeEntries, readHistory, recordModelChange, seedHistory,
} from '../src/display-model-history.js';
import { statePathFor } from '../src/state.js';

export async function run({ test, assert }) {
  test('default config contains no upstream client ID or clawd assets', () => {
    const json = JSON.stringify(DEFAULT_CONFIG);
    assert(!json.includes('1506443909406920948'));
    assert(!json.includes('clawd-'));
    assert(!json.includes('claude-rpc.com'));
    assert.equal(DEFAULT_CONFIG.clientId, 'YOUR_DISCORD_CLIENT_ID');
    assert.equal(DEFAULT_CONFIG.appName, APP_NAME);
    assert.equal(DEFAULT_CONFIG.community.enabled, false);
    assert.equal(DEFAULT_CONFIG.usage.enabled, false);
    assert.equal(DEFAULT_CONFIG.profile.enabled, false);
  });

  test('display identity defaults to Clawstly and estimated cost', () => {
    assert.equal(APP_NAME, 'Clawstly');
    assert.equal(DEFAULT_CONFIG.appName, APP_NAME);
    assert.equal(DEFAULT_CONFIG.displayModel, 'Claude Opus');
    assert.equal(DEFAULT_CONFIG.displayMetric, 'cost');
    assert.match(DEFAULT_CONFIG.presence.largeImageText, /in \{appName\}/);
    assert.equal(modelLabelFor('astra').label, 'GPT Astra');
    assert.equal(modelLabelFor('opus').label, 'Claude Opus');
    assert.equal(modelLabelFor('sonnet').label, 'Claude Sonnet');
    assert.equal(modelLabelFor('haiku').label, 'Claude Haiku');
    assert.equal(modelLabelFor('fable').label, 'Claude Fable');
    assert.equal(modelLabelFor('real').cleared, true);
    assert.equal(normalizeMetric('money'), 'cost');
  });

  test('display overrides rewrite card model and metric vars', () => {
    const state = {
      status: 'thinking',
      model: 'anthropic/claude-sonnet-4-5',
      tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionStart: Date.now(),
    };
    const base = { appName: APP_NAME, statusAssets: {}, presence: {} };
    const costVars = buildVars(state, { ...base, displayModel: 'GPT Sol', displayMetric: 'cost' }, {});
    assert.equal(costVars.modelPretty, 'GPT Sol');
    assert.equal(costVars.model, 'GPT Sol');
    assert.match(costVars.metricLabel, /^≈\$/);

    const tokenVars = buildVars(state, { ...base, displayModel: '', displayMetric: 'tokens' }, {});
    assert.equal(tokenVars.modelPretty, 'Sonnet 4.5');
    assert.match(tokenVars.metricLabel, /tokens$/);
  });

  test('plugin snippet uses the V2 plugins array', () => {
    const snippet = JSON.parse(pluginSnippet());
    assert(Array.isArray(snippet.plugins));
    assert.equal(snippet.plugins.length, 1);
    assert.match(snippet.plugins[0], /[\\/]plugin$/);
    assert(EVENTS.includes('session.created'));
    assert(!EVENTS.includes('session.closed'));
  });

  test('status art accepts asset keys and remote GIF URLs', () => {
    const gif = 'https://raw.githubusercontent.com/example/assets/main/oc_working.gif';
    assert.equal(validateConfig({ clientId: 'YOUR_DISCORD_CLIENT_ID', statusAssets: { working: 'oc_working' } }), null);
    assert.equal(validateConfig({ clientId: 'YOUR_DISCORD_CLIENT_ID', statusAssets: { working: gif } }), null);
    assert.match(
      validateConfig({ clientId: 'YOUR_DISCORD_CLIENT_ID', statusAssets: { working: 42 } }),
      /asset key or URL/,
    );
    assert.equal(resolveLargeImageKey({ statusAssets: { working: gif } }, {}, 'working', null), gif);
  });

  test('humanModel handles OpenCode provider/model ids', () => {
    assert.equal(humanModel('anthropic/claude-sonnet-4-5'), 'Sonnet 4.5');
    assert.equal(humanModel('openai/gpt-5'), 'GPT 5');
    assert.equal(humanModel(null), 'OpenCode');
    assert.equal(humanModel('opencode'), 'OpenCode');
  });

  test('pickActiveSession ignores closed sessions', () => {
    const now = 1_000_000;
    const states = [
      { sessionId: 'closed', lastActivity: now, opencodeClosed: true },
      { sessionId: 'live', lastActivity: now - 1_000, cwd: '/repo', opencodeClosed: false },
    ];
    const picked = pickActiveSession(states, null, now, 60_000);
    assert.equal(picked.sessionId, 'live');
    assert.equal(picked.liveCount, 1);
  });

  test('throttleDecision honors a sliding window cap', () => {
    const now = 100_000;
    const d = throttleDecision({
      hash: 'new', lastSentHash: 'old', lastSentAt: now - 1_000, now,
      gapMs: 4_000, flushPending: false,
      recentSends: [now - 1_000, now - 2_000, now - 3_000, now - 4_000],
      windowMs: 20_000, maxPerWindow: 4,
    });
    assert.equal(d.action, 'defer');
    assert(d.waitMs > 0);
  });

  test('scanner date helpers and aggregate shape', () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    assert.equal(dayKeyAt(now, 1), '2026-01-14');
    assert.match(weekKey(now), /^2026-W0[23]$/);
    assert.equal(cleanProjectName('my-app-2026-04-25'), 'my-app');
    const agg = emptyAggregate();
    assert.equal(agg.sessions, 0);
    assert.equal(agg.byDay && typeof agg.byDay, 'object');
  });

  test('state paths sanitize session IDs', () => {
    const p = statePathFor('abc/def:123');
    assert(/state-abcdef123\.json$/.test(p.replace(/\\/g, '/')));
  });

  test('plugin source replacement preserves JSONC comments and other keys', () => {
    const raw = '{\n  // keep this comment\n  "model": "anthropic/claude-sonnet-4-5",\n  "plugins": [\n    "old\\plugin",\n    "other-plugin"\n  ]\n}\n';
    assert.equal(isOurPluginEntry('C:\\work\\clawstly_oc_rpc\\plugin'), true);
    assert.equal(isOurPluginEntry('D:/mirror/clawstly_oc_rpc/plugin'), true);
    assert.equal(isOurPluginEntry('some-other-plugin'), false);
    const out = replacePluginsArray(raw, ['other-plugin', 'D:\\mirror\\clawstly_oc_rpc\\plugin']);
    assert(out.includes('// keep this comment'));
    assert(out.includes('"model": "anthropic/claude-sonnet-4-5"'));
    assert.deepEqual(readPluginsArray(out), ['other-plugin', 'D:\\mirror\\clawstly_oc_rpc\\plugin']);
  });

  test('source status discovers configs without a registration', () => {
    const status = sourceStatus();
    assert(Array.isArray(status.configs));
    assert(status.configs.some((cfg) => cfg.group === 'global'));
    assert(typeof status.activeTarget === 'string');
    assert((status.presets.C || status.presets.L).endsWith('plugin'));
  });

  test('plugin registration issues detect duplicates and stale mappings', () => {
    const entry = 'D:\\mirror\\clawstly_oc_rpc\\plugin';
    const clean = pluginRegistrationIssues({
      configs: [{ path: '/cfg/opencode.jsonc', exists: true, system: false, ours: [entry], raw: '' }],
    });
    assert.equal(clean.length, 0);
    const duplicated = pluginRegistrationIssues({
      configs: [{ path: '/cfg/opencode.jsonc', exists: true, system: false, ours: [entry, entry], raw: '' }],
    });
    assert(duplicated.some((issue) => issue.includes('2 clawstly entries')));
    const split = pluginRegistrationIssues({
      configs: [
        { path: '/a/opencode.jsonc', exists: true, system: false, ours: [entry], raw: '' },
        { path: '/b/opencode.jsonc', exists: true, system: false, ours: [entry], raw: '' },
      ],
    });
    assert(split.some((issue) => issue.includes('split across 2 configs')));
    const stale = pluginRegistrationIssues({
      configs: [{
        path: '/cfg/opencode.jsonc', exists: true, system: false, ours: [],
        raw: '{"plugins":{"clawstly-oc-rpc":"C:\\work\\clawstly_oc_rpc\\plugin"}}',
      }],
    });
    assert(stale.some((issue) => issue.includes('stale object-format')));
  });

  test('process classifier only matches our daemon and dashboard', () => {
    assert.equal(classifyCommand('node "D:\\mirror\\clawstly_oc_rpc\\src\\daemon.js"'), 'daemon');
    assert.equal(classifyCommand('node /work/clawstly_oc_rpc/src/daemon.js'), 'daemon');
    assert.equal(classifyCommand('node "C:\\work\\bin\\clawstly-oc-rpc.js" serve'), 'dashboard');
    assert.equal(classifyCommand('node other-project.js'), null);
    assert.equal(classifyCommand('opencode.exe serve --service'), null);
  });

  const stopAllCalls = [];
  let stopAllFinds = 0;
  const stopAllResult = await stopAll({
    mark: () => { stopAllCalls.push('plugin'); return true; },
    stopDaemon: async (options) => {
      stopAllCalls.push(`daemon:${options.mark}`);
      return { stopped: true, killed: [] };
    },
    stopDashboard: async () => { stopAllCalls.push('dashboard'); return { stopped: true, killed: [] }; },
    sweep: async (processes) => {
      stopAllCalls.push('sweep');
      return processes.map((proc) => proc.pid);
    },
    find: () => {
      stopAllFinds += 1;
      return stopAllFinds === 1 ? [{ pid: 42, kind: 'daemon' }] : [];
    },
    up: async () => { stopAllCalls.push('verify'); return false; },
  });
  test('stop all disables the plug-in first, then stops and verifies every component', () => {
    assert.deepEqual(stopAllCalls, ['plugin', 'daemon:false', 'dashboard', 'sweep', 'verify']);
    assert.deepEqual(stopAllResult.killed, [42]);
    assert.equal(stopAllResult.plugin.disabled, true);
    assert.equal(stopAllResult.stopped.daemon, true);
    assert.equal(stopAllResult.stopped.dashboard, true);
    assert.equal(stopAllResult.stopped.plugin, true);
    assert.equal(stopAllResult.stopped.leftovers, true);
  });

  test('display model history resolves the label active at each point in time', () => {
    const entries = normalizeEntries([
      { at: 2000, label: 'GPT Sol' },
      { at: 1000, label: 'Claude Opus' },
      { at: 3000, label: '' },
      { at: 'bad', label: 'ignored' },
    ]);
    assert.deepEqual(entries.map((e) => e.at), [1000, 2000, 3000]);
    assert.equal(labelAt(entries, 999), 'Claude Opus');
    assert.equal(labelAt(entries, 1500), 'Claude Opus');
    assert.equal(labelAt(entries, 2000), 'GPT Sol');
    assert.equal(labelAt(entries, 2500), 'GPT Sol');
    assert.equal(labelAt(entries, 3500), '');
    assert.equal(labelAt(entries), '');
    assert.equal(labelAt([], 1000), null);
    assert.equal(normalizeEntries(Array.from({ length: 150 }, (_, i) => ({ at: i, label: 'x' }))).length, 100);
  });

  test('display model history round-trips from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawstly-hist-test-'));
    const path = join(dir, 'model-history.json');
    try {
      seedHistory('Claude Opus', path, 1000);
      recordModelChange('GPT Sol', path, 2000);
      const history = readHistory(path);
      assert.equal(history.length, 2);
      assert.equal(labelAt(history, 1500), 'Claude Opus');
      assert.equal(labelAt(history, 2500), 'GPT Sol');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
