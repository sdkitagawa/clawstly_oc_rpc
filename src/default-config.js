// Defaults for clawstly-oc-rpc. The user file only needs overrides.
// Forked from rar-file/claude-rpc (MIT); all Claude-specific hooks, assets,
// telemetry and hosted-service defaults have been removed.

import { APP_NAME, DEFAULT_DISPLAY_MODEL, DEFAULT_DISPLAY_METRIC } from './branding.js';

export const DEFAULT_CONFIG = {
  // Replace with your Discord application's client ID. See README.md.
  clientId: "YOUR_DISCORD_CLIENT_ID",
  appName: APP_NAME,
  // RPC-only display overrides. They change the Discord card text, never the
  // model OpenCode actually runs. Blank displayModel means "use the real one".
  displayModel: DEFAULT_DISPLAY_MODEL,
  displayMetric: DEFAULT_DISPLAY_METRIC,
  updateIntervalMs: 4000,
  rotationIntervalMs: 12000,
  autostart: true,
  minActivityGapMs: 4000,
  maxActivityWrites: 4,
  activityWindowMs: 20000,
  presenceKeepaliveSec: null,
  rescanIntervalSec: 300,
  idleThresholdSec: 60,
  staleSessionMin: 5,
  idleWhenOpen: true,
  processDetection: true,
  hideWhenStale: true,
  notificationWindowSec: 8,
  shippedFrameSec: 60,
  goals: { dailyHours: 0, dailyPrompts: 0, weeklyHours: 0 },
  budget: { monthly: 0, warnAtPct: 80 },
  webhook: { url: "", on: ["shipped", "notification"] },
  notify: { enabled: false, onNotification: true },
  triggers: [],
  triggerFrameSec: 20,

  // All network-facing community/profile/usage integrations are disabled and
  // intentionally absent from this fork.
  community: { enabled: false, instanceId: null, endpoint: "", flushIntervalMin: 30 },
  usage: { enabled: false, pollIntervalMin: 0 },
  profile: { enabled: false, handle: null, displayName: null, githubUser: null, heatmap: false },
  update: { auto: false, checkIntervalHours: 0 },

  showElapsed: true,
  activityType: 0,

  // Card art: either Discord Portal asset names, or public direct image/GIF
  // URLs (GitHub raw/Pages). Discord fetches URLs itself; we only pass them
  // through as large_image keys. No upstream clawd-* assets are used.
  statusAssets: {
    working: "oc_working",
    thinking: "oc_thinking",
    compacting: "oc_compacting",
    shipped: "oc_shipped",
    idle: "oc_idle",
    stale: "oc_idle",
    notification: "oc_notification",
  },
  presence: {
    largeImageKey: "oc_idle",
    largeImageText: "{modelPretty} · {allHours} in {appName} · {streakLabel}",
    smallImageKey: "{statusIcon}",
    smallImageText: "{statusVerbose}",
    byStatus: {
      working: {
        details: "Working in {project}",
        state: "{currentToolPretty} · {currentFilePretty} · {toolElapsed} · {metricLabel}",
        largeImageText: "Working on a {fileLang} file",
        rotation: [
          { details: "{sessionMilestoneLabel} · {project}", state: "{metricLabel} · {messagesLabel}", requires: ["sessionMilestoneHit"] },
          { details: "Daily goal", state: "{goalLabel}", requires: ["goalLabel"] },
          { details: "Monthly budget", state: "{budgetLabel}", requires: ["budgetLabel"] },
        ],
      },
      thinking: {
        details: "Thinking in {project}",
        state: "{modelPretty} · {messagesLabel} · {metricLabel}",
        largeImageText: "Reasoning with {modelPretty}",
      },
      compacting: {
        details: "Compacting context in {project}",
        state: "{modelPretty} · {messagesLabel}",
        largeImageText: "Compacting · {compactTriggerLabel}",
      },
      shipped: {
        details: "{justShippedLabel} · {project}",
        state: "{lastCommit}",
        largeImageText: "{justShippedLabel}",
      },
      notification: {
        details: "Waiting on you · {project}",
        state: "{modelPretty} · {messagesLabel}",
        largeImageText: "Permission needed",
      },
      idle: {
        details: "Idle in {project}",
        state: "{modelPretty} · {todayHours} today",
        largeImageText: "Idle · {modelPretty}",
        rotation: [
          { details: "This week · {weekHours}", state: "{weekPromptsLabel} · {weekMetricLabel}", requires: ["weekActiveMs"] },
          { details: "{streakLabel}", state: "{daysSinceFirstLabel} · {allSessionsLabel}", requires: ["streakIsMilestone"] },
          { details: "Hotspot · {sessionTopFile}", state: "{sessionTopEditedCountLabel} · {sessionTopEditedAgeLabel}", requires: ["sessionTopEditedCount"] },
          { details: "Model split", state: "{modelSplitLabel}", requires: ["modelSplitLabel"] },
          { details: "{allHours} in {appName} all-time", state: "{allSessionsLabel} · {allMessagesFmt} prompts", requires: ["allSessions"] },
          { details: "Lifetime · {allMetricLabel}", state: "{allToolsFmt} tool calls · {allFilesFmt} files", requires: ["allTools"] },
          { details: "{sessionFreshTokensFmt} fresh tokens", state: "{sessionCachePctLabel}", requires: ["sessionFreshTokens"] },
          { details: "Code churn · {sessionLinesAddedFmt} added", state: "{sessionLinesNetFmt} net · {sessionTopLanguage}", requires: ["sessionChurn"] },
          { details: "Cost · {todayCostFmt} today", state: "{allCostFmt} all-time", requires: ["allCost"] },
          { details: "Daily goal", state: "{goalLabel}", requires: ["goalLabel"] },
          { details: "Monthly budget", state: "{budgetLabel}", requires: ["budgetLabel"] },
        ],
      },
    },
    githubButton: true,
    buttons: [],
  },
  statusIcons: {
    working: "oc_working",
    thinking: "oc_thinking",
    compacting: "oc_compacting",
    shipped: "oc_shipped",
    idle: "oc_idle",
    notification: "oc_notification",
    stale: "oc_idle",
  },
};
