# Clawstly OC RPC

Discord Rich Presence for **OpenCode** into an OpenCode V2 plugin + local daemon.

This fork does **not** include the upstream Claude Code hooks, transcript scanner, VS Code extension, Cloudflare worker, Discord bot, hosted website, community telemetry, leaderboard/profile publishing, or Anthropic usage polling. Community, usage, and profile integrations are hard-disabled by default.

## Requirements

- Node.js 18+
- OpenCode V2
- Discord desktop client running and signed in (Rich Presence uses local Discord IPC)
- Your own Discord application Client ID

## Discord Developer Portal setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Copy the **Application ID** (this is the OAuth2 Client ID used for Rich Presence).
3. Choose card art:
   - **Static Discord art:** under **Rich Presence → Art Assets**, upload images and use their asset names. The defaults are `oc_working`, `oc_thinking`, `oc_compacting`, `oc_shipped`, `oc_idle`, and `oc_notification`.
   - **Animated GIFs (upstream style):** host your own GIFs at public direct URLs — GitHub raw or GitHub Pages works — and set those URLs as `statusAssets` values in `config.json`. Discord fetches the GIF directly; the daemon does not download or proxy it. Use a direct file URL, not a GitHub blob page, and do not reuse upstream `clawd-*` assets.

   Example:

   ```json
   {
     "clientId": "1572562385951002674",
     "statusAssets": {
       "working": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_working.gif",
       "thinking": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_thinking.gif",
       "compacting": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_compacting.gif",
       "shipped": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_shipped.gif",
       "idle": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_idle.gif",
       "notification": "https://raw.githubusercontent.com/sdkitagawa/clawstly_oc_rpc/main/assets/status/clawstly_oc_notification.gif"
     }
   }
   ```
4. Put the Application ID in `config.json` as `clientId`, or edit it later in the local dashboard at `http://127.0.0.1:47474/settings`.

> The default value `YOUR_DISCORD_CLIENT_ID` is a placeholder. Presence will not appear in Discord until you replace it with your own application ID.

## Install

```bash
npm install
node bin/clawstly-oc-rpc.js setup
```

`setup` will:

- create `config.json` from the shipped defaults if it does not exist
- register this project's `plugin/` directory in your OpenCode V2 config
- print the Discord Portal steps and current status

To see the config snippet without writing anything:

```bash
node bin/clawstly-oc-rpc.js setup --print-plugin
```

OpenCode config locations checked by setup:

- `~/.config/opencode/opencode.jsonc` (also on Windows)
- `./opencode.jsonc`
- `./.opencode/opencode.jsonc`

The plugin registration looks like:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/absolute/path/to/clawstly_oc_rpc/plugin"
  ]
}
```

OpenCode reloads config changes automatically; check with `opencode plugin list` if needed. Restart the daemon after changing `config.json`:

```bash
node bin/clawstly-oc-rpc.js restart
```

## Easy launcher

Four launchers are included so you never have to type a command:

- `run.cmd` / `run.bat` — double-click on Windows
- `run.ps1` — PowerShell directly
- `run.sh` — Git Bash / WSL

With no arguments they open a menu:

```text
1  Start RPC
2  Stop RPC
3  Restart RPC
4  Status
5  Health check
6  Open dashboard
7  Change displayed model
8  Token / cost display
9  Exit
```

Direct forms also work, for example `run.cmd model sol`, `run.cmd metric cost`, or `./run.sh stop`.

## Commands

```bash
node bin/clawstly-oc-rpc.js setup [--yes] [--print-plugin]
node bin/clawstly-oc-rpc.js start
node bin/clawstly-oc-rpc.js stop
node bin/clawstly-oc-rpc.js restart
node bin/clawstly-oc-rpc.js status
node bin/clawstly-oc-rpc.js doctor
node bin/clawstly-oc-rpc.js serve [--port 47474]
node bin/clawstly-oc-rpc.js scan
node bin/clawstly-oc-rpc.js config get [key]
node bin/clawstly-oc-rpc.js config set <key> <json-value>
node bin/clawstly-oc-rpc.js model [alias|custom label]
node bin/clawstly-oc-rpc.js metric <tokens|cost|both>
node bin/clawstly-oc-rpc.js private add <cwd>
node bin/clawstly-oc-rpc.js private remove <cwd>
node bin/clawstly-oc-rpc.js private list
node bin/clawstly-oc-rpc.js pause <duration|off>
node bin/clawstly-oc-rpc.js help [command]
```

`hook` is intentionally absent. OpenCode uses the V2 plugin in `plugin/index.ts` instead.

## Privacy display controls

The Discord card shows **Clawstly** as its app name. Two config keys control what else is visible:

- `displayModel` — the model name Discord sees. Defaults to `Claude Opus`. Choices: `GPT Sol`, `GPT Luna`, `GPT Astra`, `Claude Opus`, `Claude Sonnet`, `Claude Haiku`, `Claude Fable`, a custom label, or blank to use the real model. This never changes the model OpenCode actually runs.
- `displayMetric` — `tokens`, `cost`, or `both`. Defaults to `cost`, rendered with `≈` because it is an estimate from local pricing data, not a bill.

Use launcher menu options **7** and **8**, the `/settings` page, or the `model` and `metric` commands above. Changes restart the daemon so the card updates immediately.

## Local dashboard

```bash
node bin/clawstly-oc-rpc.js serve
```

Then open <http://127.0.0.1:47474>. The dashboard shows live OpenCode sessions, the current presence preview, aggregate stats, charts, and a `/settings` page for templates, asset keys or GIF URLs, model/metric display, privacy, and daemon controls. The server binds to loopback only and enforces same-origin checks on POST routes.

## What the plugin maps

The V2 plugin writes one state file per OpenCode session and maps:

- `session.created` → session seed
- `session.hook("prompt")` → early thinking status
- `session.inbox.delivered` → prompt count, thinking status
- `ctx.tool.hook("execute.before"/"execute.after")` → working status, tool/file counters, ship detection
- `ctx.shell.hook("create.before")` → shell command activity
- permission and form hooks/events → notification status
- `session.hook("compaction")`, compaction events → compacting status
- `session.usage.updated` → token and cost counters
- `session.idle`, execution end, shutdown → idle/closed state

See [`plugin/README.md`](plugin/README.md) for details.

## Files and data

| Purpose | Location |
| --- | --- |
| User config | `config.json` in this repo (dev), or `%APPDATA%/clawstly-oc-rpc/config.json` when installed |
| Live session state | OS temp dir: `clawstly-oc-rpc/state-<sessionId>.json` |
| Aggregate stats | `~/.clawstly-oc-rpc/aggregate.json` |
| Daemon log | OS temp dir: `clawstly-oc-rpc/daemon.log` |
| Dashboard | `http://127.0.0.1:47474` |

## License

Upstream MIT notice retained in [`LICENSE`](LICENSE).
