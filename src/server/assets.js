// Simple disk reader for the dashboard's browser assets. No SEA/blob handling;
// assets live beside this file in ./assets and are read once at startup.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets');

function assetPath(name) {
  if (typeof name !== 'string' || !/^[a-z0-9._-]+$/i.test(name)) {
    throw new Error(`Invalid asset name: ${name}`);
  }
  return join(ASSET_DIR, name);
}

export function loadAsset(name) {
  return readFileSync(assetPath(name), 'utf8');
}

// Binary assets (the dashboard favicon) must not be decoded as UTF-8.
export function loadAssetBuffer(name) {
  return readFileSync(assetPath(name));
}
