import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const testDir = new URL('../test/', import.meta.url);
const files = readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed++; process.stdout.write(`  ok  ${name}\n`); })
        .catch((err) => { failed++; process.stdout.write(`FAIL  ${name}\n${err.stack || err}\n`); });
    }
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`FAIL  ${name}\n${err.stack || err}\n`);
  }
}

process.stdout.write(`Running ${files.length} test file(s)\n`);
for (const file of files) {
  const mod = await import(pathToFileURL(join(fileURLToPath(testDir), file)).href);
  if (typeof mod.run !== 'function') continue;
  await mod.run({ test, assert });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
