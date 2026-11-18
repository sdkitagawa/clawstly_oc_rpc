#!/usr/bin/env node
import './safe-stdio.js';
import { existsSync, unlinkSync, watch, appendFileSync, mkdirSync, statSync, renameSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Client, isBridgeUser } from './discord-ipc.js';
import { readState, sweepStaleStateTmp, listSessionStates, sweepStaleSessionStates } from './state.js';
import { makeRotationCursor, pickFrames, selectFrame, resolveLargeImageKey, shouldShowGithubButton, pickActiveSession, throttleDecision, reconnectPlan, RECONNECT_BASE_MS } from './presence.js';
import { buildVars, fillTemplate, framePasses, applyIdle, applyShipped, applyTrigger, humanProject } from './format.js';
import { scan, readAggregate, findLiveSessions, readSessionTokens, readSessionModel } from './scanner.js';
import { detectOpenCodeProcess } from './oc-proc.js';
import { detectGithubUrl } from './git.js';
import { applyPrivacy } from './privacy.js';
import { pauseUntil } from './pause.js';
import { loadConfig } from './config.js';
import { APP_NAME } from './branding.js';
import { selfHealOnUpdate } from './install.js';
import { VERSION } from './version.js';
import { desktopNotify, postWebhook, shouldWebhook, shouldNotify, sanitizeLabel } from './notify.js';
import { CONFIG_PATH, STATE_PATH, PID_PATH, LOG_PATH, STATE_DIR, AGGREGATE_PATH, PAUSE_PATH, DAEMON_INFO_PATH, ROOT, IS_PACKAGED, CANONICAL_EXE } from './paths.js';
import { readUsageCache } from './usage.js';
import { pollDecision, pollIntervalMs } from './watch-poll.js';
import { claimSingleInstance, spawnDaemonDetached, isStopped, readPid, isAlive, readDaemonInfo, writeDaemonInfo, BEAT_EVERY_MS, BEAT_STALE_MS } from './ensure-daemon.js';


if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Daemon log capped at 5MB. Same policy events.jsonl uses (see plugin/index.ts).
// On rotation we move the existing log aside as `daemon.log.1` so the
// last rotation's content is still available for `clawstly-oc-rpc tail`.
// One file's worth of history is enough — older logs have never been
// useful in practice, and the daemon runs for weeks.
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function maybeRotateLog() {
  try {
    const st = statSync(LOG_PATH);
    if (st.size <= LOG_ROTATE_BYTES) return;
    renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch {
    // No log file yet, or rename failed (another daemon is rotating
    // simultaneously). Either case is safe to ignore — we'll just keep
    // appending and try rotation again on the next write.
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  maybeRotateLog();
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // Disk full, permission denied, or LOG_PATH became invalid mid-run.
    // The daemon must keep running regardless — Discord presence is more
    // important than file logging.
  }
  process.stdout.write(line);
}

// Last-resort resilience. A presence daemon is best-effort and long-lived — it
// must never die from an unexpected error in a non-critical path (a scan edge
// case, a transient IPC oddity, a stray rejection). Log and keep running:
// staying up is the entire point, and the periodic ticks/watchdog re-converge
// from almost anything. Installed before any other startup work so even a boot
// error is captured rather than killing us silently.
process.on('uncaughtException', (e) => {
  try { log('uncaughtException (continuing):', e?.stack || e?.message || String(e)); } catch { /* logging itself failed — nothing more we can do */ }
});
process.on('unhandledRejection', (e) => {
  try { log('unhandledRejection (continuing):', e?.stack || e?.message || String(e)); } catch { /* see above */ }
});

// Signal handlers go in before the pid-file claim below: a SIGTERM that lands
// between the claim and a late handler install killed the daemon the default
// way and stranded its pid file. (shutdown is hoisted; it tolerates the
// not-yet-initialised IPC client.)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// `clawstly-oc-rpc stop` is durable — it holds across sessions and reboots. A login
// autostart entry (or anything else) that launches us while stopped exits
// cleanly (code 0, so systemd's Restart=on-failure leaves it be).
if (isStopped()) {
  log('Stopped by `clawstly-oc-rpc stop` — not starting. Run `clawstly-oc-rpc start` to resume.');
  process.exit(0);
}

// Single-instance guard — an ATOMIC claim (see ensure-daemon.claimSingleInstance).
// Many launchers can fire at once now that the plugin self-heals the daemon: a
// manual `start` and several concurrent plugin setups could all spawn a daemon
// in the same instant. A second daemon would fight over setActivity every ~4s.
// The exclusive-create claim makes exactly one survive; a live owner → we exit;
// a stale pid (dead, or recycled with a stale heartbeat) → we reclaim. Claimed
// BEFORE the update self-heal below so a losing duplicate never touches config.
const ownerPid = claimSingleInstance();
if (ownerPid) {
  log(`Another daemon (pid ${ownerPid}) is already running — exiting.`);
  process.exit(0);
}
const STARTED_AT = Date.now();
function beat() {
  writeDaemonInfo({ pid: process.pid, version: VERSION, startedAt: STARTED_AT, beatAt: Date.now() });
}
beat();

// Wrap loadConfig so a parse/IO failure logs once and the daemon keeps
// running on baked-in defaults. The Electron settings GUI saves the file
// atomically but mid-edit hand-edits used to brick the daemon — this is
// the "no, just keep going with what we shipped" failsafe.
function loadConfigWithLog() {
  return loadConfig({ onError: (msg) => log(msg) });
}

// Self-heal on update — when this daemon is newer than the version stamp on
// disk, re-register the local plugin directory and migrate config to the
// current shape, then stamp the version. This is how an `npm update` reaches
// users who never re-run setup. Runs before the config load below; best-effort
// — a failure must never stop the daemon.
try {
  const healed = selfHealOnUpdate({ silent: true });
  if (healed.changed) {
    log(`self-heal on update: ${healed.from || 'fresh'} → ${VERSION} (plugin ${healed.rewired ? 'registered' : 'already current'}, config migrated; autostart ${healed.autostart ? 'on' : 'off'})`);
  }
} catch (e) {
  log('startup self-heal failed (continuing):', e?.message || String(e));
}

let config = loadConfigWithLog();
let aggregate = readAggregate() || null;
let liveSessions = [];
// OS-level "an OpenCode process exists" flag (see oc-proc.js). Injected into
// every resolved state so applyIdle can tell "open but quiet" (→ idle) from
// "actually closed" (→ stale) — state-file mtimes alone can't, which is why an
// untouched-but-open session could clear the card after staleSessionMin.
// null = unknown (never checked / detection unavailable) → old behavior.
let ocProcAlive = null;
let client = null;
let connected = false;
let connecting = false; // login() in flight — see the watchdog note in connect()
// True when the READY handshake identified an arRPC-style bridge (Vesktop/
// Equibop/web client) rather than the real Discord desktop client — see
// isBridgeUser in discord-ipc.js. Bridges never replay the current activity
// after their web client blips, so the keepalive below runs tighter there.
let bridgeClient = false;
// ── Outbound presence throttle ──────────────────────────────────────────────
// Discord rate-limits SET_ACTIVITY hard (~5 writes per 20s); a burst past it
// makes the client blank the presence until the writes stop — the actual
// mechanism behind "the card sometimes looks buggy", since OpenCode plugin
// events can fire in flurries. We never write faster than activityGapMs(): the first change
// after a quiet gap goes out at once, and changes inside the gap coalesce to
// the LATEST and flush once when it expires. See presence.throttleDecision.
// `lastSentHash` is what we believe is on the wire — advanced ONLY after a
// confirmed write, so a dropped/rate-limited write self-heals on the next push
// instead of being recorded as success and stranded (the old optimistic-hash
// bug, which stuck the card on a stale frame).
let lastSentHash = '';
let lastSentAt = 0;       // ms of the last write ATTEMPT (success or fail → back off either way)
let pendingSend = null;   // { kind, activity, hash, logMsg } coalesced during the gap; latest wins
let flushTimer = null;
// Timestamps (ms) of recent write ATTEMPTS (set + clear both hit Discord), for
// the sliding-window rate cap below. The per-write gap alone leaves the daemon
// riding Discord's ~5-per-20s SET_ACTIVITY ceiling — many triggers fire and a
// 4s gap still permits 6 writes in some 20s windows, which makes Discord EMPTY
// the presence (card → app name + bare timer). This bounds the COUNT per window
// regardless of how many triggers fire. Deliberately NOT cleared by
// resetTransmit (a scan/session/config refresh forces a re-render but must not
// reset the rate budget, or those refreshes could burst us past the limit).
let recentSends = [];
// Last status we acted on for outbound side-effects (webhook / desktop notify).
// Tracked separately from the render hash so we fire once per transition.
let lastNotifiedStatus = null;
let reconnectTimer = null;
// Current Discord reconnect step — pacing lives in presence.reconnectPlan
// (fast flat poll while Discord isn't running, exponential backoff to 5min
// when a live client keeps failing). Reset on a successful connect.
let reconnectDelayMs    = RECONNECT_BASE_MS;
// The "Discord isn't running" poll is every ~15s; logging each miss would
// write ~5,700 lines a day. One line per this interval keeps the log quiet
// while still landing inside the tail doctor reads for IPC state.
const ABSENT_LOG_EVERY_MS = 5 * 60_000;
let lastAbsentLogAt = 0;
// Rotation cursor (index + lastAt + status). selectFrame in presence.js resets
// it on a status transition — otherwise the cursor carries over from idle's
// 12-frame rotation into a single-frame working state and back, producing a
// jarring "blank tick" until modulo aligns.
const rotationCursor = makeRotationCursor();
// Which concurrent session's card we're currently showing. pickActiveSession
// keeps it sticky — see resolvePresence.
let displayedSessionId = null;
// sessionId → state-file path, remembered from the last tick the session was
// inside the live window. Lets token enrichment keep reading the state file
// after it goes quiet instead of zeroing the card's count.
const sessionPathMemo = new Map();
// Stabilizes Discord's elapsed timer: applyIdle can synthesize a sessionStart
// from a moving state-file timestamp, and missing-event scenarios leave it
// null — either case would make startTimestamp jump on every rotation.
let effectiveSessionStart = null;

// Reclaim any per-pid state tmp files orphaned by a hard-killed writer, plus
// per-session state files from sessions that ended long ago. The session-state
// sweep repeats every 30 min — a daemon runs for weeks, and every file left
// behind is re-read by listSessionStates on every render tick, so boot-only
// sweeping leaks both disk and per-tick CPU.
sweepStaleStateTmp();
sweepStaleSessionStates();
const sweepTimer = setInterval(() => {
  sweepStaleStateTmp();
  sweepStaleSessionStates();
}, 30 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

// pickFrames / selectFrame / resolveLargeImageKey now live in presence.js (pure
// + unit-tested). The rotation cursor (rotationCursor) is owned here and passed
// into selectFrame.

// Resolve the raw state file into the final presence state: idle/stale, shipped
// and trigger overlays, live-session token enrichment, and the privacy verdict.
// Run ONCE per tick (in pushPresence) and reused by buildActivity, so the
// clear-vs-push decision and the rendered frame are guaranteed to agree —
// previously this chain ran twice and only buildActivity applied the trigger
// overlay, so the two could diverge.
function resolvePresence() {
  let state;
  // Multi-session: each session writes its own state-<id>.json. Pick which one
  // to show, sticking with the current session while it's active so the card
  // doesn't thrash between projects (which also stabilizes the elapsed timer
  // and the GitHub button — both follow the displayed session). Fall back to
  // the legacy global state.json when there are no per-session files.
  const sessions = listSessionStates();
  if (sessions.length) {
    const idleMs = Math.max(30_000, (config.idleThresholdSec || 60) * 1000);
    const picked = pickActiveSession(sessions, displayedSessionId, Date.now(), idleMs);
    displayedSessionId = picked.sessionId;
    state = picked.state || readState();
    // Party count from the SAME per-session list we selected from, so the
    // "N sessions" field stays consistent with the card instead of wobbling
    // on state-file update timing.
    state._liveCount = picked.liveCount;
  } else {
    state = readState();
  }
  // Attach live sessions BEFORE applyIdle so the stale/idle decision can
  // see ongoing state-file activity, not just this daemon's cached state.
  state.liveSessions = liveSessions;
  // Same for OS-level process liveness (oc-proc poll), unless the state
  // already carries a verdict.
  if (state.opencodeProcessAlive === undefined) state.opencodeProcessAlive = ocProcAlive;
  state = applyIdle(state, config);
  // Shipped overlay sits on top of idle/working/thinking — but never over
  // stale (we don't celebrate when OpenCode isn't running).
  state = applyShipped(state, config);
  // Custom-command trigger overlay (config.triggers) — never over stale/shipped.
  state = applyTrigger(state, config);

  // Refresh tokens/model from the session's state file. The plugin updates it
  // on every usage event, so this keeps the card current even when the selected
  // state object was written before the latest token delta. Matching is by
  // session ID first, with cwd as a fallback for borrowed/legacy states.
  if (state.status !== 'stale') {
    const live = state.liveSessions || [];
    let tpath = null;
    if (state.sessionId && !state.borrowed) {
      const bySid = live.find((s) => s.sessionId === state.sessionId);
      if (bySid) {
        tpath = bySid.path;
        if (!sessionPathMemo.has(state.sessionId) && sessionPathMemo.size >= 64) {
          sessionPathMemo.delete(sessionPathMemo.keys().next().value);
        }
        sessionPathMemo.set(state.sessionId, tpath);
      } else {
        tpath = sessionPathMemo.get(state.sessionId) || null;
      }
    }
    if (!tpath && state.cwd) {
      const cwdLower = state.cwd.toLowerCase();
      tpath = live.find((s) => (s.cwd || '').toLowerCase() === cwdLower)?.path || null;
    }
    if (tpath) {
      const t = readSessionTokens(tpath);
      if (t) state.tokens = t;
      // The plugin refreshes the model on usage and session events, so this
      // render-time read keeps the card current if the state object is a tick
      // old. The state file remains plugin-owned.
      const liveModel = readSessionModel(tpath);
      if (liveModel) state.model = liveModel;
    }
  }

  // Apply privacy AFTER token resolution but BEFORE buildVars — so the
  // template inputs ({project}, {currentFile}, etc.) already reflect the
  // visibility decision. Sets state._privacy so we can short-circuit to
  // clearActivity when visibility=hidden.
  state = applyPrivacy(state, config);
  return state;
}

// Render the Discord activity for a state resolvePresence() already resolved
// (pushPresence's single resolution per tick).
function buildActivity(state) {
  // Subscription usage rides in like liveSessions: injected onto state so
  // buildVars stays pure. Stale/missing cache → null → usage frames vanish.
  state.usage = readUsageCache();
  const vars = buildVars(state, config, aggregate);
  const p = config.presence || {};

  // Pick the active set of frames + any status-level largeImageText override.
  // Reset the rotation cursor when status changes so a 7-frame idle rotation
  // doesn't bleed its index into a 1-frame working state.
  let rawFrames, statusLIT;
  if (state.status === 'trigger' && state._triggerFrame) {
    rawFrames = [state._triggerFrame];
    statusLIT = state._triggerFrame.largeImageText || null;
  } else {
    ({ frames: rawFrames, largeImageTextTpl: statusLIT } = pickFrames(p, state.status));
  }
  // Select the frame for this tick: filter by `requires`, reset the cursor on a
  // status change (starting on the base frame), advance once per intervalMs.
  const intervalMs = Math.max(5000, config.rotationIntervalMs || 12000);
  const frame = selectFrame(rawFrames, vars, state.status, rotationCursor, intervalMs, framePasses, Date.now());

  const activity = {};
  // Forcing `name` overrides whatever Discord has cached for the app's
  // display name, so every user sees the same "Playing <appName>" header
  // regardless of their client's stale application cache.
  activity.name = config.appName || APP_NAME;
  if (frame.details) activity.details = fillTemplate(frame.details, vars).slice(0, 128);
  if (frame.state) activity.state = fillTemplate(frame.state, vars).slice(0, 128);

  // Large-image precedence (statusAssets[status] > modelAssets[tier] > global)
  // lives in presence.js/resolveLargeImageKey. smallImageKey separately resolves
  // to the `{statusIcon}` template var (config.statusIcons), dropped when empty.
  const largeKeyTpl = resolveLargeImageKey(config, p, state.status, state.model);
  if (largeKeyTpl) activity.largeImageKey = fillTemplate(largeKeyTpl, vars);
  // largeImageText precedence: per-frame override > byStatus entry > global default.
  const largeTextTpl = frame.largeImageText || statusLIT || p.largeImageText;
  if (largeTextTpl) activity.largeImageText = fillTemplate(largeTextTpl, vars).slice(0, 128);

  // Small image: pick the status icon directly from vars (set via config.statusIcons).
  // Skips when the icon is empty (e.g. 'stale' has no asset).
  const smallKey = p.smallImageKey ? fillTemplate(p.smallImageKey, vars) : vars.statusIcon;
  if (smallKey && smallKey !== 'stale') {
    activity.smallImageKey = smallKey;
    activity.smallImageText = fillTemplate(p.smallImageText || '{statusVerbose}', vars).slice(0, 128);
  }

  if (state.status === 'stale') {
    effectiveSessionStart = null;
  } else if (state.sessionStart && !state.borrowed) {
    effectiveSessionStart = state.sessionStart;
  } else if (!effectiveSessionStart) {
    // Borrowed states can carry a moving state-file timestamp as sessionStart
    // — seed the timer from the first observation and hold it, or the elapsed
    // clock restarts every refreshLiveSessions tick.
    effectiveSessionStart = state.sessionStart || state.lastActivity || Date.now();
  }
  if (config.showElapsed && effectiveSessionStart && state.status !== 'stale') {
    // Discord IPC expects millisecond timestamps (not seconds).
    activity.startTimestamp = effectiveSessionStart;
  }

  // Activity type — 0=Playing, 1=Streaming, 2=Listening, 3=Watching, 5=Competing.
  // Default to Playing for backwards-compat; config can override.
  if (typeof config.activityType === 'number') activity.type = config.activityType;

  // Buttons: static configured set, optionally augmented with a per-project
  // GitHub button when the current cwd has a github origin. Suppressed under any
  // non-public privacy verdict (else the link leaks the project we're hiding),
  // while stale, and when presence.githubButton is set to false (the explicit
  // off switch — works even without the gh CLI that private-repo detection needs).
  const buttons = Array.isArray(p.buttons) ? p.buttons.slice() : [];
  const gh = shouldShowGithubButton(p, state) ? detectGithubUrl(state.cwd) : null;
  if (gh && !buttons.some((b) => /github\.com/i.test(b.url || ''))) {
    buttons.unshift({ label: 'View on GitHub →', url: gh });
  }
  if (buttons.length) {
    activity.buttons = buttons.slice(0, 2).map((b) => ({
      label: fillTemplate(b.label, vars).slice(0, 32),
      url: fillTemplate(b.url, vars),
    }));
  }

  // Concurrent sessions render natively via Discord's party field — the card
  // shows "(2 of 2)" with no template work. Only attached when more than one
  // live session exists (a party of one is noise). Opt out: showPartySize:false.
  // Prefer the per-session count (consistent with the displayed session); fall
  // back to the state-file-derived count for the legacy single-state path.
  const liveCount = state._liveCount != null ? state._liveCount : (state.liveSessions || []).length;
  if (config.showPartySize !== false && liveCount > 1) {
    activity.partyId = 'clawstly-oc-rpc';
    activity.partySize = liveCount;
    activity.partyMax = liveCount;
  }
  return activity;
}

// Fire desktop-notification + webhook on a status transition (once per change).
// When `suppressed` (paused / privacy=hidden), we still advance the transition
// cursor — so resume doesn't replay a stale notification — but stay silent, or
// the webhook/toast would leak the project name and defeat the snooze.
function fireStatusSideEffects(resolved, suppressed = false) {
  const status = resolved.status;
  if (status === lastNotifiedStatus) return;
  const prev = lastNotifiedStatus;
  lastNotifiedStatus = status;
  if (suppressed) return;
  try {
    // Sanitize the cwd-derived project name before it reaches a notifier or
    // webhook — see sanitizeLabel (closes a win32 PowerShell injection via a
    // maliciously-named directory).
    const appLabel = config.appName || APP_NAME;
    const project = sanitizeLabel(humanProject(resolved.cwd)) || appLabel;
    if (shouldNotify(config.notify, prev, status)) {
      desktopNotify(`${appLabel} needs you`, `Waiting on you in ${project}`);
      log(`desktop notification raised (status=${status})`);
    }
    if (shouldWebhook(config.webhook, prev, status)) {
      postWebhook(config.webhook.url, {
        status,
        project,
        model: config.displayModel || resolved.model || null,
        justShipped: resolved.justShippedKind || null,
        ts: Date.now(),
      });
      log(`webhook: POSTed status=${status} (${project})`);
    }
  } catch (e) {
    log('status side-effect failed:', e.message);
  }
}

// Compute the desired presence for the current state and hand it to the
// throttle. Called from many triggers (plugin-driven state changes, the periodic
// tick, config/scan/session refreshes); transmit() collapses that into at most
// one Discord write per activityGapMs(), so callers never have to think about
// the rate limit. Best-effort throughout — presence must never crash the daemon.
function pushPresence() {
  if (!connected || !client?.user) return;
  try {
    // Resolve state ONCE — this same object decides clear-vs-push, drives the
    // status side-effects, AND is rendered by buildActivity, so there's no way
    // for the decision and the frame to disagree.
    const resolved = resolvePresence();

    const hideWhenStale = config.hideWhenStale !== false;
    const privacyHidden = resolved._privacy?.visibility === 'hidden';
    // Global snooze (`clawstly-oc-rpc pause`) — clears the card while the deadline
    // is in the future. Re-checked every tick, so expiry resumes presence
    // automatically (the next frame's hash differs from the cleared sentinel).
    const pausedUntil = pauseUntil();
    const suppressed = privacyHidden || !!pausedUntil || (resolved.status === 'stale' && hideWhenStale);

    // Outbound side-effects on a status TRANSITION (fire once per change): a
    // desktop notification when OpenCode needs you, and an opt-in webhook POST.
    // Suppressed while paused / privacy=hidden — those snooze the card, and a
    // toast or webhook leaking the project name would defeat that.
    fireStatusSideEffects(resolved, suppressed);

    if (suppressed) {
      // Wipe effectiveSessionStart so the next active push gets a fresh
      // elapsed timer rather than counting from a previous session.
      effectiveSessionStart = null;
      const reason = pausedUntil
        ? `paused until ${new Date(pausedUntil).toLocaleTimeString()}`
        : privacyHidden ? 'privacy=hidden in this project' : 'stale — OpenCode not running';
      transmit('clear', null, `Presence cleared (${reason})`);
      return;
    }

    const activity = buildActivity(resolved);
    transmit('set', activity, `Presence updated: ${activity.details || '-'} | ${activity.state || '-'}`);
  } catch (e) {
    log('pushPresence failed:', e.message);
  }
}

// Minimum gap between Discord writes, read live so a config reload takes effect.
// Floored at 2s as a sanity minimum. The gap spaces consecutive writes; the
// sliding-window cap below is what actually bounds writes-per-window so we stay
// under Discord's ~5-per-20s SET_ACTIVITY limit (see default-config).
function activityGapMs() {
  return Math.max(2000, config.minActivityGapMs || 4000);
}

// Sliding-window rate cap parameters, read live like the gap. Defaults to 4
// writes per 20s — one under Discord's ~5-per-20s SET_ACTIVITY ceiling, so we
// stay clear of it even if Discord counts its window inclusively or our clock
// drifts. Floored so a bad config can't disable the protection entirely.
function activityWindowMs() {
  return Math.max(5000, config.activityWindowMs || 20000);
}
function maxActivityWrites() {
  return Math.max(2, config.maxActivityWrites || 4);
}

// Presence keepalive — after this much wire silence, re-send the current frame
// even though it hasn't changed. The real Discord client holds an activity
// until told otherwise, so 60s there is pure insurance; arRPC-style bridges
// lose the activity whenever their web client blips and never replay it, so
// the interval tightens once the handshake identifies one (issue #37 — card
// gone on Vesktop while every write is acked). config.presenceKeepaliveSec
// overrides (floored at 15s); 0/false disables. Costs one SET_ACTIVITY per
// interval at most — far under the 4-per-20s window cap.
const KEEPALIVE_DESKTOP_SEC = 60;
const KEEPALIVE_BRIDGE_SEC = 20;
function presenceKeepaliveMs() {
  const v = config.presenceKeepaliveSec;
  if (v === 0 || v === false) return 0;
  const sec = typeof v === 'number' && v > 0
    ? Math.max(15, v)
    : (bridgeClient ? KEEPALIVE_BRIDGE_SEC : KEEPALIVE_DESKTOP_SEC);
  return sec * 1000;
}

// Sentinel for a clear — can never collide with a real activity hash, since
// JSON.stringify of an activity object always begins with '{'.
const CLEAR_HASH = 'cleared';

// Route a desired payload (kind:'set'|'clear') through the rate-limit throttle.
// 'send' writes now; 'defer' stashes the LATEST payload and arms a single flush
// timer; 'skip' means the wire already shows this exact frame.
function transmit(kind, activity, logMsg) {
  const hash = kind === 'clear' ? CLEAR_HASH : JSON.stringify(activity);
  // Keepalive only re-asserts a VISIBLE frame — re-writing an already-cleared
  // presence would burn rate-limited writes on a no-op, all night, every night.
  const keepaliveMs = kind === 'clear' ? 0 : presenceKeepaliveMs();
  const reassert = hash === lastSentHash; // only possible via keepalive expiry
  const d = throttleDecision({
    hash, lastSentHash, lastSentAt,
    now: Date.now(), gapMs: activityGapMs(), flushPending: !!flushTimer,
    recentSends, windowMs: activityWindowMs(), maxPerWindow: maxActivityWrites(),
    keepaliveMs,
  });
  if (d.action === 'skip') { pendingSend = null; return; }
  if (reassert) logMsg = `${logMsg} · keepalive re-assert`;
  if (d.action === 'send') { doSend({ kind, activity, hash, logMsg }); return; }
  // defer — remember the LATEST payload and flush it once when the gap expires.
  pendingSend = { kind, activity, hash, logMsg };
  if (!flushTimer) {
    flushTimer = setTimeout(flushPendingSend, d.waitMs);
    if (flushTimer.unref) flushTimer.unref();
  }
}

function flushPendingSend() {
  flushTimer = null;
  const p = pendingSend;
  pendingSend = null;
  if (!p || !connected || !client?.user) return;
  if (p.hash === lastSentHash) return; // state reverted to what's already shown
  doSend(p);
}

// The single point that actually writes to Discord. lastSentAt advances on every
// ATTEMPT (so a failure backs off a full gap before retrying); lastSentHash
// advances ONLY on success — a dropped/rate-limited write is therefore retried
// by the next push rather than being recorded as success and stranded.
async function doSend({ kind, activity, hash, logMsg }) {
  lastSentAt = Date.now();
  // Record the attempt and drop anything older than the window — this is the
  // ledger throttleDecision reads to enforce the per-window cap. Counts every
  // attempt (set AND clear) since both are SET_ACTIVITY writes to Discord.
  recentSends.push(lastSentAt);
  const cutoff = lastSentAt - activityWindowMs();
  if (recentSends[0] <= cutoff) recentSends = recentSends.filter((t) => t > cutoff);
  try {
    if (kind === 'clear') await client.user.clearActivity();
    else await client.user.setActivity(activity);
    lastSentHash = hash;
    log(logMsg);
  } catch (e) {
    log('setActivity failed:', e.message, '|', e.stack?.split('\n').slice(0, 3).join(' | '));
    // A failed write usually means the IPC pipe died WITHOUT a 'disconnected'
    // event (Discord restart, socket reset, OS sleep). Left alone, `connected`
    // stays true and the daemon goes silently dark forever. Tear down and force
    // a backoff reconnect so we self-heal — guarded to connection-shaped errors
    // so a one-off app error (e.g. a rate-limit rejection) just waits for the
    // next push's retry instead of needlessly bouncing a healthy socket.
    if (isConnectionError(e)) {
      log('setActivity error looks connection-level — forcing reconnect');
      connected = false;
      resetTransmit();
      try { client?.destroy(); } catch { /* already gone */ }
      scheduleReconnect('setActivity failed');
    }
  }
}

// Force the next pushPresence to write even if the activity is byte-identical,
// and drop any queued flush. Called when an input changed (config/aggregate/
// scan/sessions) or the connection bounced — the new frame must go out fresh.
function resetTransmit() {
  lastSentHash = '';
  pendingSend = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

// Heuristic: does this error indicate the IPC transport itself is dead
// (vs. a transient/application-level failure)? Matches the common broken-pipe
// / closed-socket shapes from our IPC client (src/discord-ipc.js) and the net
// socket so we only force a reconnect when the connection is actually gone.
function isConnectionError(e) {
  const code = (e && e.code) || '';
  // ETIMEDOUT: request() now deadlines nonce replies — a half-open pipe that
  // acks writes but never answers is a dead transport, so reconnect.
  if (['EPIPE', 'ECONNRESET', 'ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_STREAM_WRITE_AFTER_END'].includes(code)) return true;
  const m = String((e && e.message) || '').toLowerCase();
  return /closed|reset|broken pipe|not connected|disconnect|write after end|socket|econnreset|epipe|connection/.test(m);
}

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // While login() is in flight, connected===false and reconnectTimer===null
  // both hold, so the watchdog's "down, nothing pending" branch would spawn a
  // second connect() that overwrites `client` and orphans this socket. Block it.
  connecting = true;
  // Retire the previous client before replacing it. Left alive, a socket it
  // still held (e.g. from a login that timed out) would close later and its
  // 'disconnected' would mark the NEW, healthy client down and reconnect.
  if (client) {
    client.removeAllListeners();
    try { client.destroy(); } catch { /* already gone */ }
  }
  const self = new Client({ clientId: config.clientId, transport: { type: 'ipc' } });
  client = self;

  // Every handler ignores events from a client that has since been replaced.
  self.on('ready', () => {
    if (client !== self) return;
    connected = true;
    // Reset backoff so the next outage also starts at RECONNECT_BASE_MS.
    reconnectDelayMs = RECONNECT_BASE_MS;
    lastAbsentLogAt = 0;
    bridgeClient = isBridgeUser(client.user);
    if (bridgeClient) {
      // Doctor greps this line: "connected as" feeds ipcStateFromLog, "arrpc"
      // feeds bridgeFromLog — keep both tokens if rewording.
      log(`Discord RPC connected as ${client.user?.username} — arRPC-style bridge (Vesktop/Equibop/web client). ` +
          `Bridges don't replay presence after their web client reconnects; keepalive re-asserts every ${Math.round(presenceKeepaliveMs() / 1000)}s.`);
    } else {
      log('Discord RPC connected as', client.user?.username);
    }
    resetTransmit();
    pushPresence();
  });
  self.on('disconnected', () => {
    if (client !== self) return;
    connected = false;
    scheduleReconnect('Discord disconnected');
  });
  try { await self.login(); }
  catch (e) {
    // ECONNREFUSED is login()'s "no IPC socket accepted" — Discord isn't
    // running, as opposed to a client that answered and then failed.
    if (client === self) scheduleReconnect(`Discord login failed: ${e.message}`, { absent: e.code === 'ECONNREFUSED' });
  } finally {
    if (client === self) connecting = false;
  }
}

function scheduleReconnect(reason = 'reconnect', { absent = false } = {}) {
  connected = false;
  if (reconnectTimer) return;
  const { waitMs, nextDelayMs } = reconnectPlan({ delayMs: reconnectDelayMs, absent });
  const now = Date.now();
  if (!absent || now - lastAbsentLogAt >= ABSENT_LOG_EVERY_MS) {
    // Doctor greps "retry in Ns" (ipcStateFromLog) — keep the token if rewording.
    log(`${reason} — retry in ${Math.round(waitMs / 1000)}s. Is Discord desktop running?`);
    if (absent) lastAbsentLogAt = now;
  }
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, waitMs);
  reconnectDelayMs = nextDelayMs;
}

function watchFiles() {
  // Single source of truth for every on-disk change the daemon reacts to.
  // Each target is covered two ways at once: a directory watcher (instant)
  // and the mtime-poll fallback below (never misses). See watch-poll.js for
  // why both exist — fs.watch drops atomic-rename events on Windows, and
  // every writer here (state.js, pause.js, the scanner, the settings GUI)
  // commits via tmp+rename.
  const targets = [
    // Hooks write per-session state-<sid>.json (state.json only for legacy
    // payloads without a session_id), so the state target matches the whole
    // family — filtering on the literal 'state.json' made the instant watcher
    // path dead for every real session, leaving only the poll tick.
    {
      path: STATE_PATH, label: 'state', onChange: pushPresence,
      matches: (f) => /^state(-.+)?\.json$/.test(f),
      scanDir: STATE_DIR,
    },
    { path: PAUSE_PATH, label: 'pause', onChange: pushPresence },
    { path: CONFIG_PATH, label: 'config', onChange: () => {
      log('Config changed — reloading');
      config = loadConfigWithLog();
      resetTransmit();
      pushPresence();
    } },
    { path: AGGREGATE_PATH, label: 'aggregate', onChange: () => {
      aggregate = readAggregate() || aggregate;
      resetTransmit();
      pushPresence();
    } },
  ];

  // Last mtime we've reacted to, per target. Updated by BOTH the watcher and
  // the poll, so a change one path already handled resolves to a no-op for
  // the other (pollDecision → 'idle') instead of a duplicate push — and the
  // poll only logs a "fallback caught it" line for events the watcher truly
  // missed, not for everything it already handled.
  const lastMtime = new Map();
  // Current mtime for a target: single file by default, or the max across a
  // directory's matching files for family targets (state-<sid>.json). Max is
  // monotone under writes, so pollDecision's `cur > prev` still works; a
  // deleted session file lowers it, which correctly doesn't fire.
  const statTarget = (t) => {
    if (t.scanDir) {
      let max;
      try {
        for (const name of readdirSync(t.scanDir)) {
          if (!t.matches(name)) continue;
          try {
            const m = statSync(join(t.scanDir, name)).mtimeMs;
            if (max === undefined || m > max) max = m;
          } catch { /* file vanished mid-scan */ }
        }
      } catch { /* dir missing (before first plugin event) */ }
      return max;
    }
    try { return existsSync(t.path) ? statSync(t.path).mtimeMs : undefined; }
    catch { return undefined; /* mid-rename; a later observation records it */ }
  };
  const recordMtime = (t) => {
    const m = statTarget(t);
    if (m !== undefined) lastMtime.set(t.path, m);
  };
  // Seed baselines so the first poll tick doesn't fire for files that merely
  // already existed when the daemon started.
  targets.forEach((t) => recordMtime(t));

  const fire = (t, viaPoll) => {
    if (viaPoll) log(`${t.label} changed — poll fallback caught an event fs.watch missed`);
    recordMtime(t); // record before onChange so a re-entrant tick can't double-fire
    t.onChange();
  };

  // Watch DIRECTORIES, not files: every writer uses tmp+rename and inotify
  // tracks the inode, so a file-path watcher goes silent after the first
  // rename. A dir watcher survives renames and works before the file exists
  // (fresh install — daemon up before the first plugin event seeds state).
  // Group by directory so STATE_DIR (state.json + pause.json) takes one
  // watcher, not two. Events are filtered by filename where the platform
  // reports one; a null filename fans out to the whole group (one debounced
  // push per target, deduped by the payload hash).
  const groups = new Map();
  for (const t of targets) {
    const dir = dirname(t.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(t);
  }
  for (const [dir, group] of groups) {
    if (!existsSync(dir)) continue;
    let timer = null;
    try {
      watch(dir, (event, filename) => {
        const hits = filename
          ? group.filter((t) => (t.matches ? t.matches(String(filename)) : basename(t.path) === filename))
          : group;
        if (!hits.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => hits.forEach((t) => fire(t, false)), 250);
      });
    } catch (e) {
      log(`watch failed for ${dir} (poll fallback still covers it):`, e.message);
    }
  }

  // Mtime-poll fallback. Runs fast on Windows (where it's effectively the
  // primary path — fs.watch drops atomic-rename events there) and lazily on
  // macOS/Linux. Now covers config.json and pause.json too: a dropped
  // pause/config event previously had no backstop at all and could hang
  // until the next unrelated state change.
  setInterval(() => {
    for (const t of targets) {
      const cur = statTarget(t);
      const decision = pollDecision(lastMtime.get(t.path), cur);
      if (decision === 'seed') lastMtime.set(t.path, cur);
      else if (decision === 'fire') fire(t, true);
    }
  }, pollIntervalMs());
}

// The OpenCode aggregator is cheap (it reads state files, not transcripts), so
// it runs in-process. The plugin writes aggregate.json on every meaningful
// event; this pass just ensures the file exists and refreshes the in-memory copy.
let scanRunning = false;
async function runBackgroundScan({ force = false } = {}) {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const t0 = Date.now();
    const res = scan({ force });
    const agg = res.aggregate;
    aggregate = agg;
    log(`Aggregate refreshed in ${Date.now() - t0}ms — allHours=${((agg.activeMs || 0) / 3_600_000).toFixed(1)}, sessions=${agg.sessions || 0}`);
    resetTransmit();
    pushPresence();
  } catch (e) {
    log('Aggregate refresh failed:', e.message);
  } finally {
    scanRunning = false;
  }
}

function shutdown() {
  log('Shutting down…');
  // Best-effort cleanup on the way out the door. Only remove the pid/info
  // files if they are still OURS: during an update handover the replacement
  // daemon claims the pid file while we wind down, and deleting it blindly
  // orphaned the replacement (`status` said "not running", the next plugin
  // setup spawned a second daemon, and `stop` could only ever kill one).
  try { client?.destroy(); } catch { /* IPC already gone (or not created yet) */ }
  try { if (readPid() === process.pid) unlinkSync(PID_PATH); } catch { /* race vs another shutdown */ }
  try { if (readDaemonInfo()?.pid === process.pid) unlinkSync(DAEMON_INFO_PATH); } catch { /* gone */ }
  process.exit(0);
}

// ── Lifecycle watchdog ──────────────────────────────────────────────────────
// Every BEAT_EVERY_MS: honor a `stop` (any daemon still alive — a duplicate the
// signal missed, one a launcher started anyway — exits), reconcile the pid file
// (a tmp cleaner deleting it used to let every session start add one more
// daemon), refresh the heartbeat, and hand over to new code once an update has
// replaced the files on disk.
function onDiskVersion() {
  if (IS_PACKAGED) {
    // The packaged exe can't be read for a version; its file changing under us
    // (setup/the desktop app copying a new build over the canonical exe) is the
    // signal. Only meaningful when we ARE the canonical exe.
    const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
    if (norm(process.execPath) !== norm(CANONICAL_EXE)) return null;
    try { const st = statSync(CANONICAL_EXE); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
  }
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || null; } catch { return null; }
}
const BOOT_DISK_VERSION = onDiskVersion();
let diskChangeSeen = null;   // needs two consecutive sightings — npm may be mid-extract
let handingOver = false;
let handoverBlockedUntil = 0;

// Spawn a fresh daemon from whatever is on disk and exit once it has claimed
// the pid file. If it never comes up, keep running (better old code than none)
// and don't try again for an hour.
function handOver(reason) {
  if (handingOver || Date.now() < handoverBlockedUntil) return;
  handingOver = true;
  log(`${reason} — handing over to a fresh daemon`);
  try { if (readPid() === process.pid) unlinkSync(PID_PATH); } catch { /* gone */ }
  spawnDaemonDetached();
  const deadline = Date.now() + 8000;
  const poll = setInterval(() => {
    const cur = readPid();
    if (cur && cur !== process.pid && isAlive(cur)) { clearInterval(poll); shutdown(); return; }
    if (Date.now() < deadline) return;
    clearInterval(poll);
    log('Handover failed: the new daemon never came up — staying on this one');
    try { writeFileSync(PID_PATH, String(process.pid)); } catch { /* unwritable */ }
    handingOver = false;
    handoverBlockedUntil = Date.now() + 60 * 60_000;
  }, 250);
}

function lifecycleTick() {
  if (handingOver) return;
  if (isStopped()) { log('Stop requested (`clawstly-oc-rpc stop`)'); shutdown(); return; }
  const cur = readPid();
  if (cur !== process.pid) {
    const info = readDaemonInfo();
    if (cur && isAlive(cur) && info?.pid === cur && Date.now() - (info.beatAt || 0) < BEAT_STALE_MS) {
      log(`Another daemon (pid ${cur}) owns the pid file — exiting as a duplicate`);
      try { client?.destroy(); } catch { /* gone */ }
      process.exit(0);
    }
    try { writeFileSync(PID_PATH, String(process.pid)); log(`Pid file ${cur ? `named pid ${cur}` : 'was missing'} — restored`); }
    catch { /* unwritable — run lockless */ }
  }
  beat();
  const disk = onDiskVersion();
  if (disk && BOOT_DISK_VERSION && disk !== BOOT_DISK_VERSION) {
    if (diskChangeSeen === disk) handOver(`Update on disk (${IS_PACKAGED ? 'new exe' : `${VERSION} → ${disk}`})`);
    diskChangeSeen = disk;
  } else {
    diskChangeSeen = null;
  }
}
setInterval(lifecycleTick, BEAT_EVERY_MS);

log('Clawstly OpenCode RPC daemon starting. clientId=', config.clientId);
if (!config.clientId || config.clientId === 'YOUR_DISCORD_CLIENT_ID') {
  log('WARNING: config.json still contains the placeholder clientId — presence will not appear until you set your Discord Application ID.');
}

connect();
watchFiles();

// Push presence on a tick — also drives rotation.
const pushIntervalMs = Math.max(2000, config.updateIntervalMs || 4000);
setInterval(pushPresence, pushIntervalMs);

// Initial scan + periodic rescan.
runBackgroundScan({ force: false });
const rescanMs = Math.max(60_000, (config.rescanIntervalSec || 300) * 1000);
setInterval(() => runBackgroundScan({ force: false }), rescanMs);

// Live session polling — cheap state-file walk. With the plugin now flipping
// opencodeClosed=true authoritatively (see format.applyIdle), this poll is no
// longer the primary "is OpenCode open?" signal — it is a hard-kill backstop
// and the source for concurrent-session detection. 30s cadence keeps the disk
// work minimal while still surfacing a new sibling session within a rotation
// cycle or two.
function refreshLiveSessions() {
  try {
    const thresholdMs = (config.liveSessionThresholdSec || 90) * 1000;
    const next = findLiveSessions({ thresholdMs });
    const prevCount = liveSessions.length;
    liveSessions = next;
    if (next.length !== prevCount) {
      log('Concurrent sessions:', next.length, next.map((s) => `${s.cwd || s.sessionId}(${Math.round((Date.now() - s.lastActivity) / 1000)}s)`).join(', '));
      resetTransmit();
      pushPresence();
    }
  } catch (e) {
    log('live-session poll failed:', e.message);
  }
}
refreshLiveSessions();
setInterval(refreshLiveSessions, 30_000);

// OS-level OpenCode liveness poll (see oc-proc.js). An open-but-untouched
// session stays 'idle' instead of being declared stale after staleSessionMin:
// plugin events go quiet when the user stops typing, but the process table
// doesn't lie. Kill switch: processDetection:false.
const OPENCODE_PROC_POLL_MS = 60_000;
let ocProcFailStreak = 0;
async function refreshOpenCodeProc() {
  if (config.processDetection === false) { ocProcAlive = null; return; }
  try {
    const alive = await detectOpenCodeProcess();
    if (alive === null) {
      ocProcFailStreak += 1;
      if (ocProcFailStreak >= 2 && ocProcAlive !== null) {
        log('oc-proc: detection unavailable — falling back to state-file liveness');
        ocProcAlive = null;
      }
      return;
    }
    ocProcFailStreak = 0;
    if (alive !== ocProcAlive) {
      log(`oc-proc: OpenCode process ${alive ? 'detected' : 'gone'}`);
      ocProcAlive = alive;
      resetTransmit();
      pushPresence();
    }
  } catch (e) {
    log('oc-proc poll failed:', e.message);
  }
}
refreshOpenCodeProc();
const ocProcTimer = setInterval(refreshOpenCodeProc, OPENCODE_PROC_POLL_MS);
if (ocProcTimer.unref) ocProcTimer.unref();

// ── Connection watchdog (auto-heal) ──────────────────────────────────────────
// The reconnect path is event-driven (the 'disconnected' handler + login
// failures + setActivity errors). But a connection can rot in ways that emit
// no event at all: a half-open client where `connected` is still true but the
// user handle is gone, or a state where we're down with no retry in flight.
// This periodic check guarantees the daemon always converges back to a live
// connection instead of silently staying dark — the single most common
// "it just stopped showing up" failure users hit.
const HEALTH_CHECK_MS = 30_000;
setInterval(() => {
  try {
    // Half-open: flag says connected but there's no usable user handle.
    if (connected && !client?.user && !connecting) {
      log('Watchdog: connected but no user handle — forcing reconnect');
      connected = false;
      try { client?.destroy(); } catch { /* already gone */ }
      scheduleReconnect('watchdog: half-open');
      return;
    }
    // Down with nothing scheduled to bring us back. scheduleReconnect is a
    // no-op when a timer is already pending, so this can't stack retries.
    if (!connected && !reconnectTimer && !connecting) {
      log('Watchdog: disconnected with no reconnect pending — forcing reconnect');
      scheduleReconnect('watchdog: no retry pending');
    }
  } catch (e) {
    log('Watchdog tick failed:', e.message);
  }
}, HEALTH_CHECK_MS);

