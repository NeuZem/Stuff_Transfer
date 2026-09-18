/** Copy the HTML pages next to the compiled JS, since tsc only emits .js. */

import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// new URL('..') already yields the project directory; do not call dirname on it.
const root = fileURLToPath(new URL('..', import.meta.url));
const from = path.join(root, 'src', 'ui');
const to = path.join(root, 'dist', 'ui');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
