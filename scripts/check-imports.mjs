import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const skip = new Set(['node_modules', '.git']);
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|ts)$/.test(name)) files.push(p);
  }
}
walk(root);

const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
let missing = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(re)) {
    const spec = match[1] || match[2];
    if (!spec?.startsWith('.')) continue;
    const base = resolve(dirname(file), spec);
    const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.ts')];
    if (!candidates.some(existsSync)) {
      missing++;
      process.stdout.write(`${file}: unresolved ${spec}\n`);
    }
  }
}
process.stdout.write(`${files.length} source files checked, ${missing} unresolved relative imports\n`);
process.exit(missing ? 1 : 0);
