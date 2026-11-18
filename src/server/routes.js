// Simple /api route table for the local dashboard. The dispatcher in index.js
// looks handlers up by `METHOD PATH`; writes are same-origin-checked and JSON
// body-limited before they get here.

import { snapshot, aggregateSummary, sessionList, safeAggregate, emptyAggregate } from './api.js';
import {
  getSettings, saveSettings, daemonAction, getLog,
  listWorkspaces, setWorkspaceVisibility, templateVariables,
} from './settings.js';

import * as scanner from '../scanner.js';

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function sendJson(res, value, status) {
  const code = status || (value && value.error ? 400 : 200);
  if (!res.headersSent) res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(value ?? {}));
}

export const ROUTES = new Map();

ROUTES.set('GET /api/state', (_req, res) => sendJson(res, snapshot()));

ROUTES.set('GET /api/aggregate', (_req, res, { query } = {}) => {
  sendJson(res, { ...aggregateSummary(safeAggregate()), range: query?.range || 'all' });
});

ROUTES.set('GET /api/sessions', (_req, res) => sendJson(res, { sessions: sessionList() }));

ROUTES.set('GET /api/log', (_req, res) => sendJson(res, getLog()));

ROUTES.set('GET /api/settings', (_req, res) => sendJson(res, getSettings()));

ROUTES.set('GET /api/template-vars', (_req, res) => sendJson(res, { vars: templateVariables() }));

ROUTES.set('GET /api/workspaces', (_req, res) => sendJson(res, listWorkspaces()));

ROUTES.set('POST /api/settings', async (_req, res, { body }) => {
  try { sendJson(res, await saveSettings(body)); }
  catch (e) { sendJson(res, { error: e?.message || 'Could not save settings' }, 500); }
});

ROUTES.set('POST /api/daemon', async (_req, res, { body }) => {
  try { sendJson(res, await daemonAction(body?.action)); }
  catch (e) { sendJson(res, { error: e?.message || 'Daemon action failed' }, 500); }
});

ROUTES.set('POST /api/workspaces', (_req, res, { body }) => sendJson(res, setWorkspaceVisibility(body)));

function scanSummary(result) {
  if (!result || typeof result !== 'object') return null;
  const out = {};
  for (const key of ['scanned', 'skipped', 'total', 'removed', 'changed']) {
    if (typeof result[key] === 'number') out[key] = result[key];
  }
  return Object.keys(out).length ? out : null;
}

ROUTES.set('POST /api/scan', async (_req, res, { body } = {}) => {
  try {
    const force = body?.force === true;
    const result = await scanner.scan({ force });
    let agg = scanner.readAggregate();
    if (!agg || typeof agg !== 'object') {
      agg = emptyAggregate();
      // A fresh install has no aggregate yet. Materialise an empty one so the
      // next read has a stable shape; failures here are non-fatal.
      try { scanner.writeAggregate?.(agg); } catch { /* read-only disk */ }
    }
    sendJson(res, {
      ok: true,
      scanned: scanSummary(result),
      aggregate: aggregateSummary(agg),
    });
  } catch (e) {
    sendJson(res, { error: e?.message || 'Scan failed' }, 500);
  }
});
