// Dashboard runtime. Vanilla JS, no build step, no external requests.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat();

  function fmtNumber(n) {
    return nf.format(Number.isFinite(Number(n)) ? Number(n) : 0);
  }
  function fmtCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return fmtNumber(v);
  }
  function fmtDuration(ms) {
    const minutes = Math.round((Number(ms) || 0) / 60000);
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  function fmtAgo(ts) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }
  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function prettyModel(model) {
    const leaf = String(model || '').trim().split('/').pop() || '';
    return leaf.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  let toastTimer = null;
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let body;
    try { body = await res.json(); } catch { body = {}; }
    if (!res.ok || body?.error) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }
  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function renderPresence(snap, settings) {
    const presence = snap?.presence || {};
    const active = presence.active || {};
    $('presence-status').textContent = presence.status || 'idle';
    $('presence-details').textContent = active.details || 'No active status';
    $('presence-state').textContent = active.state || '—';
    // Show a compact label instead of the full remote URL — a long GIF URL can
    // otherwise spill out of the live rail and dominate the preview.
    let imageLabel = 'not set';
    const largeImage = presence.largeImage || '';
    if (largeImage) {
      try {
        const parsed = new URL(largeImage);
        imageLabel = decodeURIComponent(parsed.pathname.split('/').pop() || '') || parsed.hostname;
      } catch {
        imageLabel = largeImage;
      }
    }
    $('presence-key').textContent = 'Large image: ' + imageLabel;

    // Show the live status art (the same URL Discord uses) in the avatar.
    // Asset keys without a URL keep the plain "OC" fallback.
    const avatar = $('presence-avatar');
    if (/^https?:\/\//i.test(largeImage)) {
      let img = avatar.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        avatar.textContent = '';
        avatar.appendChild(img);
      }
      if (img.getAttribute('src') !== largeImage) img.src = largeImage;
    } else {
      avatar.textContent = 'OC';
    }

    const idState = settings?.clientId?.state;
    const note = $('presence-note');
    if (idState === 'placeholder') {
      note.textContent = 'Set your Discord application ID in Settings to connect presence.';
      note.classList.add('warn');
    } else if (idState === 'invalid') {
      note.textContent = 'The saved Discord application ID is invalid — check Settings.';
      note.classList.add('warn');
    } else {
      note.textContent = 'Presence preview uses your saved templates and variables.';
      note.classList.remove('warn');
    }

    const frames = $('presence-frames');
    frames.textContent = '';
    (presence.frames || []).slice(0, 8).forEach((frame, index) => {
      const chip = document.createElement('span');
      chip.className = 'frame-chip' + (frame.passes && (!active.details || frame.details === active.details) ? ' active' : '');
      chip.textContent = `#${index + 1}${frame.passes ? '' : ' gated'}`;
      frames.appendChild(chip);
    });
  }

  function renderSessions(snap) {
    const sessions = (snap && (snap.sessions || snap.liveSessions)) || [];
    const el = $('live-list');
    el.textContent = '';
    $('live-count').textContent = String(sessions.length);
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No OpenCode sessions seen yet. Start a session and this panel updates automatically.';
      el.appendChild(empty);
      return;
    }
    for (const session of sessions.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'live-row';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = session.project || 'OpenCode';
      const state = document.createElement('div');
      state.className = 'state';
      state.textContent = (session.live ? 'live · ' : '') + (session.status || 'idle');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const bits = [session.model, session.currentTool, fmtAgo(session.lastActivity)];
      meta.textContent = bits.filter(Boolean).join(' · ');
      row.append(name, state, meta);
      el.appendChild(row);
    }
  }

  function renderStats(agg) {
    const a = agg || {};
    $('stat-active').textContent = fmtDuration(a.activeMs);
    $('stat-sessions').textContent = fmtNumber(a.sessions);
    $('stat-prompts').textContent = fmtNumber(a.prompts);
    $('stat-tools').textContent = fmtNumber(a.toolCalls);
    $('stat-tokens').textContent = fmtCompact(a.tokens);
    $('stat-projects').textContent = fmtNumber((a.projects || []).length);
  }

  function drawChart(svg, entries, labelFor, valueFor) {
    svg.textContent = '';
    const width = 600;
    const height = 180;
    const pad = { left: 8, right: 8, top: 10, bottom: 26 };
    const list = (entries || []).slice(0, 24);
    if (!list.length) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', width / 2);
      text.setAttribute('y', height / 2);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'empty');
      text.textContent = 'No data recorded yet';
      svg.appendChild(text);
      return;
    }
    const values = list.map((e) => Math.max(0, Number(valueFor(e)) || 0));
    const max = Math.max(1, ...values);
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const slot = innerW / list.length;
    const barW = Math.max(2, Math.min(28, slot * 0.7));

    const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    axis.setAttribute('x1', pad.left);
    axis.setAttribute('x2', width - pad.right);
    axis.setAttribute('y1', height - pad.bottom);
    axis.setAttribute('y2', height - pad.bottom);
    axis.setAttribute('class', 'axis');
    svg.appendChild(axis);

    list.forEach((entry, i) => {
      const value = values[i];
      const h = Math.max(1, (value / max) * innerH);
      const x = pad.left + i * slot + (slot - barW) / 2;
      const y = height - pad.bottom - h;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x.toFixed(1));
      rect.setAttribute('y', y.toFixed(1));
      rect.setAttribute('width', barW.toFixed(1));
      rect.setAttribute('height', h.toFixed(1));
      rect.setAttribute('rx', '3');
      rect.setAttribute('class', 'bar');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${labelFor(entry)}: ${fmtDuration(value)}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (i % Math.ceil(list.length / 7) === 0) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', x + barW / 2);
        label.setAttribute('y', height - 8);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('class', 'label');
        label.textContent = escapeXml(labelFor(entry));
        svg.appendChild(label);
      }
    });
  }

  function renderAggregate(agg) {
    renderStats(agg);
    const hours = (Number(agg?.activeMs) || 0) / 3_600_000;
    $('hero-num').textContent = hours ? hours.toFixed(1) : '0.0';
    $('hero-unit').textContent = hours === 1 ? 'hour' : 'hours';
    $('hero-caption').textContent =
      `${fmtNumber(agg?.sessions)} sessions · ${fmtNumber(agg?.prompts)} prompts · ${fmtCompact(agg?.tokens)} tokens`;
    const byDay = Object.entries(agg?.byDay || {})
      .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14)
      .map(([key, value]) => ({ key, value: value || {} }));
    drawChart($('day-chart'), byDay, (d) => d.key.slice(5), (d) => d.value.activeMs);

    const byHour = Object.entries(agg?.byHour || {})
      .map(([key, value]) => ({ hour: Number(key), value: value || {} }))
      .filter((h) => Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23)
      .sort((a, b) => a.hour - b.hour);
    drawChart($('hour-chart'), byHour, (h) => String(h.hour).padStart(2, '0') + 'h', (h) => h.value.activeMs);

    renderBarList($('top-projects'), agg?.projects || [], (p) => p.name, (p) => p.value, 'active');
    renderBarList($('top-tools'), agg?.tools || [], (t) => t.name, (t) => t.value, 'calls');
  }

  function renderBarList(el, entries, labelOf, valueOf, unit) {
    el.textContent = '';
    const list = Array.isArray(entries) ? entries.slice(0, 6) : [];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No data yet';
      el.appendChild(li);
      return;
    }
    const max = Math.max(1, ...list.map((e) => Number(valueOf(e)) || 0));
    for (const entry of list) {
      const value = Number(valueOf(entry)) || 0;
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = labelOf(entry) || '—';
      const val = document.createElement('span');
      val.className = 'value';
      val.textContent = unit === 'active' ? fmtDuration(value) : fmtNumber(value);
      const track = document.createElement('span');
      track.className = 'track';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = Math.max(2, (value / max) * 100) + '%';
      track.appendChild(fill);
      li.append(label, val, track);
      el.appendChild(li);
    }
  }

  async function loadAll() {
    const [stateResult, aggResult, settingsResult] = await Promise.allSettled([
      api('/api/state'), api('/api/aggregate'), api('/api/settings'),
    ]);
    if (stateResult.status === 'fulfilled') {
      renderPresence(stateResult.value, settingsResult.status === 'fulfilled' ? settingsResult.value : null);
      renderSessions(stateResult.value);
    }
    if (aggResult.status === 'fulfilled') renderAggregate(aggResult.value);
    const displayModel = settingsResult.status === 'fulfilled'
      ? settingsResult.value.config?.displayModel : '';
    const rawModel = stateResult.status === 'fulfilled' ? stateResult.value.state?.model : '';
    $('model').textContent = displayModel || prettyModel(rawModel) || '—';

    if (settingsResult.status === 'fulfilled') {
      const daemon = settingsResult.value.daemon || {};
      const pill = $('daemon-pill');
      pill.textContent = daemon.running ? `Daemon: running (${daemon.pid})` : 'Daemon: stopped';
      pill.classList.toggle('ok', !!daemon.running);
      pill.classList.toggle('off', !daemon.running);
    }
  }

  $('btn-refresh').addEventListener('click', () => {
    loadAll().then(() => toast('Dashboard refreshed')).catch((e) => toast(e.message, true));
  });

  $('btn-rescan').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await post('/api/scan', { force: event.shiftKey });
      toast(result.scanned?.scanned ? `Rebuilt stats from ${result.scanned.scanned} sessions` : 'Rescan complete');
      await loadAll();
    } catch (e) {
      toast(e.message, true);
    } finally {
      button.disabled = false;
    }
  });

  if (typeof EventSource !== 'undefined') {
    const events = new EventSource('/events');
    events.addEventListener('refresh', () => { loadAll().catch(() => {}); });
  }
  // Fallback in case an SSE event is missed: keep the model badge and live
  // preview in sync with config changes made from a launcher or the CLI.
  setInterval(() => { loadAll().catch(() => {}); }, 15_000);

  loadAll().catch((e) => {
    $('presence-details').textContent = 'Could not load local data';
    toast(e.message, true);
  });
})();
