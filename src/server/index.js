#!/usr/bin/env node
// Localhost-only HTTP server for Clawstly OpenCode RPC.
//
//   /                 dashboard (live sessions, presence, aggregate charts)
//   /settings         local settings (config, daemon, privacy, log)
//   /events           SSE refresh stream
//   /api/*            JSON snapshot + settings endpoints
//
// Zero dependencies, vanilla browser JS, no external CDN. The port comes from
// paths.DASHBOARD_PORT (default 47474) and an optional env override.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as paths from '../paths.js';
import { ROUTES, JSON_HEADERS } from './routes.js';
import { buildHtml, buildSettingsHtml } from './page.js';
import { loadAssetBuffer } from './assets.js';
import { writeAllowed } from './settings.js';
import { addClient, removeClient, watchSources } from './sse.js';

const PORT = Number(process.env.CLAWSTLY_RPC_PORT || paths.DASHBOARD_PORT) || 47474;
const MAX_BODY_BYTES = 512 * 1024;

function pageFor(path) {
  if (path === '/' || path === '/index.html') return buildHtml({ port: PORT });
  if (path === '/settings' || path === '/settings.html') return buildSettingsHtml({ port: PORT });
  return null;
}

function openPath(raw) {
  const value = String(raw || '');
  if (value === '/settings' || value === '/settings.html') return '/settings';
  return ''; // the dashboard is the only other page in this build
}
const OPEN_PATH = openPath(process.env.CLAWSTLY_RPC_OPEN_PATH);

function isLocalHost(host) {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function sendJson(res, value, status) {
  const code = status || (value && value.error ? 400 : 200);
  if (!res.headersSent) res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(value ?? {}));
}

function handleWrite(req, res, handler, query) {
  if (!writeAllowed(req.headers)) return sendJson(res, { error: 'forbidden' }, 403);
  const chunks = [];
  let size = 0;
  let closed = false;
  req.on('data', (chunk) => {
    if (closed) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      closed = true;
      sendJson(res, { error: 'request too large' }, 413);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    if (!closed) { closed = true; sendJson(res, { error: 'bad request' }, 400); }
  });
  req.on('end', async () => {
    if (closed || res.writableEnded) return;
    closed = true;
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); }
      catch { return sendJson(res, { error: 'body is not valid JSON' }, 400); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    try { await handler(req, res, { query, body }); }
    catch { sendJson(res, { error: 'internal error' }, 500); }
  });
}

function dispatch(req, res) {
  // Binding to loopback blocks the LAN; the Host check also blocks DNS
  // rebinding, where a remote page resolves to 127.0.0.1 and becomes
  // same-origin with this server.
  if (!isLocalHost(req.headers.host)) {
    return sendJson(res, { error: 'forbidden' }, 403);
  }

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, { error: 'bad request' }, 400); }
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { allow: 'GET, POST, OPTIONS' }).end();
    return;
  }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    addClient(res);
    req.on('close', () => removeClient(res));
    return;
  }

  const route = ROUTES.get(`${req.method} ${path}`);
  if (route) {
    if (req.method === 'POST') return handleWrite(req, res, route, query);
    return route(req, res, { query });
  }

  if (req.method === 'GET') {
    const page = pageFor(path);
    if (page) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(page);
      return;
    }
    if (path === '/favicon.ico') {
      // Read on each request so replacing the icon file needs no server restart.
      // no-store stops the browser holding on to an older icon.
      const icon = loadAssetBuffer('favicon.ico');
      res.writeHead(200, {
        'content-type': 'image/x-icon',
        'content-length': icon.length,
        'cache-control': 'no-store',
      });
      res.end(icon);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
}

const server = createServer((req, res) => {
  try { dispatch(req, res); }
  catch {
    if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500);
    else { try { res.end(); } catch { /* socket gone */ } }
  }
});

function openBrowser(base) {
  if (process.env.CLAWSTLY_RPC_NO_OPEN) return;
  const url = base + OPEN_PATH;
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, { windowsHide: true }, () => {});
}

async function dashboardAlreadyUp(base) {
  try {
    const signal = AbortSignal.timeout?.(1500);
    const res = await fetch(`${base}/api/settings`, { signal });
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data?.version === 'string';
  } catch { return false; }
}

let watcher = null;

function writeDashboardPid() {
  try {
    mkdirSync(dirname(paths.DASHBOARD_PID_PATH), { recursive: true });
    writeFileSync(paths.DASHBOARD_PID_PATH, String(process.pid));
  } catch { /* best-effort — command-line sweep is the fallback */ }
}

function clearDashboardPid() {
  try {
    const current = Number(String(readFileSync(paths.DASHBOARD_PID_PATH, 'utf8')).trim());
    if (current === process.pid) unlinkSync(paths.DASHBOARD_PID_PATH);
  } catch { /* already gone */ }
}

server.on('error', async (e) => {
  if (server.listening) {
    try { console.error('dashboard error:', e?.message || e); } catch { /* ignore */ }
    return;
  }
  const base = `http://127.0.0.1:${PORT}`;
  if (e?.code === 'EADDRINUSE' && await dashboardAlreadyUp(base)) {
    console.log(`Clawstly OpenCode RPC dashboard is already running: ${base}`);
    openBrowser(base);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  console.error(e?.code === 'EADDRINUSE'
    ? `Port ${PORT} is in use — stop it, or set CLAWSTLY_RPC_PORT to another port.`
    : `Dashboard could not listen on 127.0.0.1:${PORT}: ${e?.message || e}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  writeDashboardPid();
  watcher = watchSources();
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`Clawstly OpenCode RPC dashboard: ${base}`);
  console.log(OPEN_PATH ? `  opening ${base}${OPEN_PATH}  ·  Ctrl-C to stop.` : '  Ctrl-C to stop.');
  openBrowser(base);
});

function shutdown() {
  clearDashboardPid();
  try { watcher?.close(); } catch { /* ignore */ }
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => {
  try { console.error('dashboard rejection:', e?.message || e); } catch { /* ignore */ }
});
