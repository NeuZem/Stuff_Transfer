/**
 * The font and logo are served by the PUBLIC phone server, so the asset
 * route must never become a way to read other files off the PC.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

const { serve } = await import('@hono/node-server');
const { createPhoneApp } = await import('../dist/server-phone.js');
const { assetNames } = await import('../dist/assets.js');

let server;
let port;

before(async () => {
  await new Promise((resolve) => {
    server = serve({ fetch: createPhoneApp().fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
});
after(() => server.close());

/** Raw request, so paths are sent exactly as written (fetch would tidy them up). */
function get(rawPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serving the page\'s font and logo', () => {
  test('each listed file is served with the right type', async () => {
    const types = { woff2: 'font/woff2', png: 'image/png' };
    for (const name of assetNames) {
      const res = await get(`/assets/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers['content-type'], types[name.split('.').pop()], name);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.body.length > 1000, `${name} should have real content`);
    }
  });

  test('the font really is a font and the logos really are PNGs', async () => {
    const font = await get('/assets/archivo-latin.woff2');
    assert.equal(font.body.subarray(0, 4).toString('latin1'), 'wOF2');
    const png = await get('/assets/neuzem-wordmark-dark.png');
    assert.deepEqual([...png.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('nothing else can be read through it', () => {
  const attempts = [
    '/assets/../package.json',
    '/assets/..%2Fpackage.json',
    '/assets/..%2F..%2Fpackage.json',
    '/assets/%2e%2e%2fserver-phone.js',
    '/assets/Archivo-OFL.txt', // shipped in the package, but not on the list
    '/assets/constructor', // object-prototype keys must not count as files
    '/assets/__proto__',
    '/assets/',
  ];

  for (const path of attempts) {
    test(`refuses ${path}`, async () => {
      const res = await get(path);
      assert.notEqual(res.status, 200, `${path} must not be served`);
      assert.ok(!res.body.toString().includes('"name"'), 'no file content leaks');
    });
  }
});
