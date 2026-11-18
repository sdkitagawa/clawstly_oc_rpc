import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const skip = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(root);
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stdout.write(`${file}\n${r.stderr}`);
  }
}
process.stdout.write(`${files.length} JavaScript/TypeScript files checked, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
