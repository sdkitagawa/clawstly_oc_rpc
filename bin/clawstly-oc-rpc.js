#!/usr/bin/env node
import '../src/safe-stdio.js';
import { main } from '../src/cli.js';

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
