// Shared theme runtime for both local pages. Mirrors dogma_caveat_or_debunk:
// light / dark / system, persisted in localStorage, applied via data-theme on
// <html>. The head script in each page applies the saved value before paint;
// this file wires up the controls and keeps system mode live.
(() => {
  'use strict';

  const KEY = 'clawstly-theme';
  const MODES = ['light', 'dark', 'system'];
  const root = document.documentElement;
  let mode = 'system';
  try {
    const saved = localStorage.getItem(KEY);
    if (MODES.includes(saved)) mode = saved;
  } catch { /* localStorage may be unavailable */ }

  const media = typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: dark)') : null;
  const resolvedDark = () => mode === 'dark' || (mode === 'system' && !!media?.matches);

  function apply() {
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = mode;

    document.querySelectorAll('[data-theme-mode]').forEach((item) => {
      item.setAttribute('aria-checked', String(item.dataset.themeMode === mode));
    });
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      const dark = resolvedDark();
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
  }

  function setMode(next, persist = true) {
    mode = MODES.includes(next) ? next : 'system';
    if (persist) {
      try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
    }
    apply();
  }

  function closeMenu(menu, button) {
    menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function init() {
    const toggle = document.getElementById('theme-toggle');
    const button = document.getElementById('theme-menu-button');
    const menu = document.getElementById('theme-menu');

    if (toggle) {
      toggle.addEventListener('click', () => setMode(resolvedDark() ? 'light' : 'dark'));
    }
    if (button && menu) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        menu.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      });
      menu.querySelectorAll('[data-theme-mode]').forEach((item) => {
        item.addEventListener('click', () => {
          setMode(item.dataset.themeMode);
          closeMenu(menu, button);
          button.focus();
        });
      });
      document.addEventListener('click', (event) => {
        if (!menu.hidden && !menu.contains(event.target) && event.target !== button) {
          closeMenu(menu, button);
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) {
          closeMenu(menu, button);
          button.focus();
        }
      });
    }
    if (media) {
      const onChange = () => { if (mode === 'system') apply(); };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
