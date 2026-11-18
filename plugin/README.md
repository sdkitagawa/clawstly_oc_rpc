# clawstly-oc-rpc — OpenCode V2 plugin

This directory is the OpenCode V2 plugin entry point (`index.ts`). It maps
OpenCode hooks and events onto per-session state files and forwards notable
moments to the local daemon and dashboard. Scope: core + local dashboard only
(no VS Code extension, Cloudflare worker, Discord bot, hosted site, community
telemetry, or Anthropic usage polling).

The Discord card is titled **Clawstly**. The daemon also
applies `displayModel` (a privacy label such as `Claude Opus`) and `displayMetric`
(`tokens`, `cost`, or `both`) when it renders templates; neither key changes
the model OpenCode actually uses.

## Install

1. Install the project dependencies (see the root README), then create your
   Discord config. For a source checkout, copy `config.example.json` to
   `config.json` in the project root; for an installed build the file lives in
   the clawstly-oc-rpc user config directory. At minimum, set `clientId`.

2. Register the plugin in an OpenCode V2 config file —
   `~/.config/opencode/opencode.jsonc`, `./opencode.jsonc`, or
   `./.opencode/opencode.jsonc`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       "C:/absolute/path/to/clawstly_oc_rpc/plugin"
     }
   }
   ```

   The value must be the **directory** containing `index.ts` (not the file).
   Use an absolute path. OpenCode reloads config changes automatically; check with `opencode plugin list` if needed.

3. Optional CLI helpers:

   ```sh
   node bin/clawstly-oc-rpc.js setup    # seed config + register plugin
   node bin/clawstly-oc-rpc.js status   # daemon + live session state
   ```

   The plugin itself starts the daemon on setup if one is not already alive.
   Opt out with `"autostart": false` in the clawstly-oc-rpc config, or set
   `CLAWSTLY_OC_RPC_NO_AUTOSTART=1` for a single environment.

## Event coverage

| Signal | What it updates |
| --- | --- |
| `session.created` | resets the per-session state (cwd, model, project, session start) → `session` event |
| `session` prompt hook | early status `thinking`, cwd/model → `prompt` |
| `tool.execute.before/after`, `session.tool.*` | `currentTool`, `toolStartedAt`, `tools`, `toolBreakdown`, `currentFile`, `filesEdited`, `filesRead` → `tool` / `file` |
| `shell.create.before` | `currentTool: "Bash"`, command preview, tool count; git push/commit and `gh pr/issue/release create` set `justShipped*` → `tool` / `shipped` |
| `session.inbox.delivered` | `messages`, `lastUserPrompt`, status `thinking` → `prompt` |
| permission asked, `form.*` | `lastNotification`, status `notification` → `notification` |
| permission replied / compaction completion | clears the notification / `compactStartedAt` + `compactTrigger` |
| compaction hook, `session.compaction.*` | status `compacting`, compaction trigger/timestamp |
| `session.idle` | status `idle`, clears tool/file markers |
| `session.usage.updated` | tokens (`input`/`output`/`cacheRead`/`cacheWrite`) and cost → `usage` |
| `session.execution.*` | status `idle` when a turn finishes; `working` when one starts (an execution is one turn, not the whole session) |
| shutdown/exit signals | `opencodeClosed: true`, fresh `lastActivity` (no `session.closed` event exists in V2) |
| `session.deleted` | removes that session's state file |

Model IDs are resolved to display names via `ctx.model.list()`, with
`humanModel()` as the fallback. OpenCode liveness is also checked by
`src/oc-proc.js` (10-second cached, best-effort process detection). Every
hook/event path is wrapped in `try/catch`; failure never propagates into
OpenCode.

## Card art

`statusAssets` values are passed straight to Discord as `large_image`. Use
Discord Portal asset names for static art, or public direct GIF URLs (GitHub
raw or GitHub Pages) for animated art like upstream. Discord fetches the GIF;
the plugin and daemon never download or proxy it. Private URLs will not work,
and no upstream `clawd-*` assets or branding are used.

## Client ID placeholder

`config.example.json` and the shipped defaults use the placeholder
`YOUR_DISCORD_CLIENT_ID`, and the app name defaults to **OpenCode**. Replace
the client ID with your own Discord application's ID before starting the
daemon, otherwise Discord Rich Presence cannot connect. The dashboard and all
local state work without a real client ID. No upstream `clawd` CDN assets are
used.
