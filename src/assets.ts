/**
 * The pages' static files: the Archivo font and the NeuZem wordmark.
 *
 * The phone server is public, so this must not become a way to read files
 * off the PC. It never touches the disk per request: a fixed list of files
 * is loaded into memory once, and requests are answered by exact name from
 * that list. There is no path to traverse, because there is no path at all.
 */

import type { Context } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ALLOWED: Record<string, string> = {
  'archivo-latin.woff2': 'font/woff2',
  'neuzem-wordmark-dark.png': 'image/png',
  'neuzem-wordmark-light.png': 'image/png',
};

const files = new Map<string, Buffer>(
  await Promise.all(
    Object.keys(ALLOWED).map(
      async (name) =>
        [name, await readFile(fileURLToPath(new URL(`./ui/assets/${name}`, import.meta.url)))] as const,
    ),
  ),
);

/** Names the pages may ask for. Exported for tests. */
export const assetNames = Object.keys(ALLOWED);

export function serveAsset(c: Context) {
  const name = c.req.param('name') ?? '';
  const body = Object.hasOwn(ALLOWED, name) ? files.get(name) : undefined;
  if (!body) return c.text('Not found', 404);

  return c.body(new Uint8Array(body), 200, {
    'content-type': ALLOWED[name]!,
    // A day is plenty: these files only change with a new app version.
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
}
