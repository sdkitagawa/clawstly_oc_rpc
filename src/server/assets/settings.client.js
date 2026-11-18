// Settings page runtime. Vanilla JS; all writes go through same-origin JSON.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATUSES = ['working', 'thinking', 'compacting', 'shipped', 'notification', 'idle'];
  const ASSET_STATUSES = [...STATUSES, 'stale'];
  let base = null;

  function title(s) { return String(s).replace(/^./, (c) => c.toUpperCase()); }

  async function api(path, options) {
    const res = await fetch(path, options);
    let body;
    try { body = await res.json(); } catch { body = {}; }
    if (!res.ok || body?.error) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }
  function post(path, payload) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  let toastTimer = null;
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function getPath(obj, path) {
    let cur = obj;
    for (const part of String(path).split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
      cur = cur[key];
    }
    const last = parts[parts.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
    cur[last] = value;
  }

  function makeInput(configPath, label, value, placeholder, type) {
    const field = document.createElement('label');
    field.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = type || 'text';
    input.dataset.config = configPath;
    if (placeholder) input.placeholder = placeholder;
    if (type === 'number') input.step = '1';
    if (value !== undefined && value !== null) input.value = String(value);
    field.append(span, input);
    return field;
  }

  function buildStatusForm() {
    const host = $('status-templates');
    host.textContent = '';
    STATUSES.forEach((status, index) => {
      const group = document.createElement('details');
      group.className = 'status-group';
      group.open = index === 0;
      const summary = document.createElement('summary');
      summary.textContent = title(status);
      group.appendChild(summary);
      const grid = document.createElement('div');
      grid.className = 'form-grid';
      grid.append(
        makeInput(`presence.byStatus.${status}.details`, 'Details', '', '{project}'),
        makeInput(`presence.byStatus.${status}.state`, 'State', '', '{modelPretty}'),
        makeInput(`presence.byStatus.${status}.largeImageText`, 'Large image text', '', 'Working in {project}'),
      );
      group.appendChild(grid);
      host.appendChild(group);
    });
  }

  function buildModelSuggestions(profiles) {
    const list = $('model-suggestions');
    if (!list) return;
    list.textContent = '';
    for (const profile of profiles || []) {
      const option = document.createElement('option');
      option.value = profile.label;
      option.label = profile.alias;
      list.appendChild(option);
    }
  }

  function buildAssetForm(placeholders) {
    const host = $('asset-status-fields');
    host.textContent = '';
    for (const status of ASSET_STATUSES) {
      const key = placeholders?.[status] || `oc_${status}`;
      host.appendChild(makeInput(`statusAssets.${status}`, title(status) + ' image', '', key));
    }
  }

  function applyConfig(config) {
    for (const input of document.querySelectorAll('[data-config]')) {
      const value = getPath(config, input.dataset.config);
      if (input.type === 'checkbox') input.checked = value === true;
      else if (input.type === 'number') input.value = value === undefined || value === null ? '' : String(value);
      else input.value = value === undefined || value === null ? '' : String(value);
    }
  }

  function readConfig() {
    const edited = JSON.parse(JSON.stringify(base || {}));
    for (const input of document.querySelectorAll('[data-config]')) {
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.type === 'number') value = input.value === '' ? 0 : Number(input.value);
      else value = input.value;
      setPath(edited, input.dataset.config, value);
    }
    return edited;
  }

  function renderWarning(client) {
    const el = $('client-warning');
    const state = client?.state;
    if (state === 'ok') {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.classList.toggle('error', state === 'invalid');
    el.textContent = state === 'invalid'
      ? 'The Discord application ID is not valid. Use the 17–21 digit ID from the Discord developer portal.'
      : 'The Discord application ID is still a placeholder. You can save other settings, but presence will not connect until you set a real ID.';
  }

  async function loadSettings() {
    const data = await api('/api/settings');
    base = data.config || {};
    buildStatusForm();
    buildModelSuggestions(data.modelProfiles);
    buildAssetForm(data.assetPlaceholders);
    applyConfig(base);
    renderWarning(data.clientId);
    updateDaemon(data.daemon);
    return data;
  }

  async function saveSettings() {
    if (!base) { toast('Settings are still loading', true); return; }
    const button = $('save-settings');
    button.disabled = true;
    try {
      const result = await post('/api/settings', { base, edited: readConfig() });
      base = result.config || base;
      applyConfig(base);
      updateDaemon(result.daemon);
      if (result.restartError) toast(`Saved, but daemon restart failed: ${result.restartError}`, true);
      else if (result.restarted) toast('Settings saved · Discord card refreshed');
      else toast('Settings saved');
    } catch (e) {
      toast(e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function updateDaemon(status) {
    const pill = $('daemon-status');
    pill.textContent = status?.running ? `Running (pid ${status.pid})` : 'Stopped';
    pill.classList.toggle('ok', !!status?.running);
    pill.classList.toggle('off', !status?.running);
  }

  async function loadVars() {
    const data = await api('/api/template-vars');
    const host = $('var-chips');
    host.textContent = '';
    const vars = data.vars || [];
    if (!vars.length) {
      host.textContent = 'No variables available yet — start an OpenCode session.';
      return;
    }
    for (const item of vars) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'var-chip';
      chip.textContent = '{' + item.name + '}';
      if (item.sample) {
        const small = document.createElement('small');
        small.textContent = String(item.sample).slice(0, 40);
        chip.appendChild(small);
      }
      chip.addEventListener('click', () => {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText('{' + item.name + '}').catch(() => {});
        toast('Copied {' + item.name + '}');
      });
      host.appendChild(chip);
    }
  }

  async function loadWorkspaces() {
    const data = await api('/api/workspaces');
    const host = $('workspace-list');
    host.textContent = '';
    const rows = data.workspaces || [];
    if (!rows.length) {
      host.textContent = 'No workspaces have been scanned yet.';
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'workspace-row';
      const path = document.createElement('div');
      path.className = 'path';
      const name = document.createElement('strong');
      name.textContent = row.name || 'Workspace';
      const cwd = document.createElement('small');
      cwd.textContent = row.cwd;
      path.append(name, cwd);

      const select = document.createElement('select');
      for (const [value, label] of [
        ['default', 'Default (from config)'],
        ['public', 'Public'],
        ['name-only', 'Name only'],
        ['hidden', 'Hidden'],
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if ((row.level || 'default') === value) option.selected = true;
        select.appendChild(option);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = 'Save';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await post('/api/workspaces', { cwd: row.cwd, level: select.value });
          toast('Workspace visibility saved');
        } catch (e) {
          toast(e.message, true);
        } finally {
          button.disabled = false;
        }
      });
      el.append(path, select, button);
      host.appendChild(el);
    }
  }

  async function loadLog() {
    const data = await api('/api/log');
    $('log-content').textContent = data.content || '(log is empty)';
  }

  async function refreshDaemon() {
    try { updateDaemon((await api('/api/settings')).daemon); }
    catch (e) { toast(e.message, true); }
  }

  $('save-settings').addEventListener('click', saveSettings);
  $('refresh-vars').addEventListener('click', () => loadVars().catch((e) => toast(e.message, true)));
  $('refresh-workspaces').addEventListener('click', () => loadWorkspaces().catch((e) => toast(e.message, true)));
  $('refresh-log').addEventListener('click', () => loadLog().catch((e) => toast(e.message, true)));
  $('refresh-daemon').addEventListener('click', refreshDaemon);

  for (const button of document.querySelectorAll('[data-daemon]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await post('/api/daemon', { action: button.dataset.daemon });
        if (result.error) toast(result.error, true);
        else toast('Daemon ' + button.dataset.daemon + ' complete');
        updateDaemon(result.daemon);
      } catch (e) {
        toast(e.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  loadSettings()
    .then(() => Promise.allSettled([loadVars(), loadWorkspaces(), loadLog()]))
    .catch((e) => {
      toast(e.message, true);
      $('client-warning').classList.remove('hidden');
      $('client-warning').classList.add('error');
      $('client-warning').textContent = 'Could not load settings: ' + e.message;
    });
})();
