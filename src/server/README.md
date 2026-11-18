# Clawstly OpenCode RPC — local dashboard server

A dependency-free Node 18+ HTTP server for the local dashboard and settings UI.
It binds only to `127.0.0.1` on `DASHBOARD_PORT` (default `47474`, overridable
with `CLAWSTLY_RPC_PORT`). Do not expose it to a LAN or reverse-proxy it.

## Pages

| Path | Purpose |
| --- | --- |
| `/` | Dashboard: live OpenCode sessions, presence preview, aggregate stats, daily/hourly charts, top projects/tools |
| `/settings` | Client ID, app name, intervals, status templates, Discord asset keys, autostart, workspace privacy, daemon controls, log tail |

Both pages are plain HTML/CSS/vanilla JS in `assets/`, inlined by `page.js` at
startup. There is no build step and no external CDN. The browser tab icon is
served from `assets/favicon.ico` via `GET /favicon.ico`.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/state` | Current state, live sessions, presence preview, aggregate summary |
| GET | `/api/aggregate` | Aggregate summary including `byDay` and `byHour` |
| GET | `/api/sessions` | Known and live OpenCode sessions |
| GET | `/api/log` | Tail of `daemon.log` |
| GET | `/api/settings` | Effective config, daemon status, template variable names |
| GET | `/api/template-vars` | Template variables with sample values |
| GET | `/api/workspaces` | Seen workspaces and visibility levels |
| POST | `/api/settings` | `{ base, edited }` config edit (only changed keys are written) |
| POST | `/api/daemon` | `{ action: "start" \| "stop" \| "restart" }` |
| POST | `/api/workspaces` | `{ cwd, level }` where level is `public`, `name-only`, `hidden`, or `default` |
| POST | `/api/scan` | `{ force?: boolean }` rebuild stats from session state and return an updated summary |
| GET | `/events` | Server-Sent Events `refresh` stream when state files or `aggregate.json` change |

POSTs require an `application/json` body and a same-origin `Origin` header when
one is present. Bodies are capped at 512 KiB. A missing `aggregate.json`,
missing scan cache, or placeholder Discord client ID never prevents the server
from starting.
