/**
 * Runs every test/*.test.mjs file.
 *
 * Why not just `node --test <pattern>` in package.json: Node 20 does not
 * expand glob patterns (it looks for a file literally named "**\/*.test.mjs"),
 * while Node 22+ rejects a bare directory. Explicit file names work on every
 * version we support.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/${name}`);

if (files.length === 0) {
  console.error('No test files found in test/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
