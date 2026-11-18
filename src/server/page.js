// Composes the two local pages from the files in server/assets/. There is no
// build step and no wrapped page: CSS and JS are inlined into the HTML. Assets
// are read on each build so editing a file shows up without a server restart.

import { loadAsset } from './assets.js';

function compose(template, styles, script, port) {
  return template
    .replaceAll('{{STYLES}}', () => styles)
    .replaceAll('{{SCRIPT}}', () => script)
    .replaceAll('{{PORT}}', String(port));
}

export function buildHtml({ port }) {
  return compose(
    loadAsset('dashboard.html'),
    loadAsset('dashboard.css'),
    loadAsset('dashboard.client.js'),
    port,
  );
}

export function buildSettingsHtml({ port }) {
  return compose(
    loadAsset('settings.html'),
    loadAsset('dashboard.css') + '\n' + loadAsset('settings.css'),
    loadAsset('settings.client.js'),
    port,
  );
}
