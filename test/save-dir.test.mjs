/**
 * Choosing where received files are saved, and keeping other websites away
 * from the PC's private server.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-savedir-'));
process.env.STUFF_TRANSFER_DIR = path.join(base, 'default');

const { serve } = await import('@hono/node-server');
const { createPcApp } = await import('../dist/server-pc.js');
const { startSession, stopSession, setCustomRoot, receivedRoot } = await import('../dist/session.js');
const { validateSaveDir, SaveDirError } = await import('../dist/save-dir.js');

let server;
let port;
let pc;

before(async () => {
  await new Promise((resolve) => {
    server = serve({ fetch: createPcApp().fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port;
      pc = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await stopSession('done');
  setCustomRoot(null);
  server.close();
  await rm(base, { recursive: true, force: true });
});

const post = (route, body) =>
  fetch(`${pc}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const status = async () => (await fetch(`${pc}/api/status`)).json();

/**
 * A raw request with whatever headers we like. fetch() refuses to let us set
 * Host, which is exactly the header a DNS-rebinding attack controls.
 */
function raw(method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: route, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('checking a folder path', () => {
  test('a new folder is created and used', async () => {
    const wanted = path.join(base, 'new', 'nested');
    assert.equal(await validateSaveDir(wanted), wanted);
    assert.ok(existsSync(wanted));
  });

  test('quotes from "Copy as path" are accepted', async () => {
    const wanted = path.join(base, 'quoted');
    assert.equal(await validateSaveDir(`"${wanted}"`), wanted);
  });

  test('a relative path is refused', async () => {
    await assert.rejects(validateSaveDir('my files'), SaveDirError);
  });

  test('an empty path is refused', async () => {
    await assert.rejects(validateSaveDir('   '), /Type or paste/);
  });

  test('a path that is a file is refused', async () => {
    const file = path.join(base, 'a-file.txt');
    await writeFile(file, 'x');
    await assert.rejects(validateSaveDir(file), SaveDirError);
  });

  test('on Windows, a path without a drive letter is refused', { skip: process.platform !== 'win32' }, async () => {
    await assert.rejects(validateSaveDir('\\Users\\someone'), /drive/);
  });

  test('on Windows, a drive that does not exist is explained', { skip: process.platform !== 'win32' }, async (t) => {
    const free = 'QRSTUVWXYZ'.split('').find((l) => !existsSync(`${l}:\\`));
    if (!free) return t.skip('every drive letter is in use');
    await assert.rejects(validateSaveDir(`${free}:\\Stuff`), /does not exist/);
  });
});

describe('changing the folder from the PC page', () => {
  test('a chosen folder is used for the next session', async () => {
    const wanted = path.join(base, 'chosen');
    const res = await post('/api/save-dir', { path: wanted });
    assert.equal(res.status, 200);

    const s = await res.json();
    assert.equal(s.saveDir.path, wanted);
    assert.equal(s.saveDir.isCustom, true);

    const session = await startSession();
    assert.equal(path.dirname(session.dir), wanted, 'the session folder should be inside the chosen one');
    await stopSession('done');
  });

  test('the folder cannot be changed during a session', async () => {
    await startSession();
    const res = await post('/api/save-dir', { path: path.join(base, 'mid-session') });
    assert.equal(res.status, 409, 'one batch must not be split across two folders');
    assert.equal((await post('/api/save-dir/default')).status, 409);
    assert.equal((await post('/api/save-dir/browse')).status, 409);
    await stopSession('done');
  });

  test('a bad path is explained, and the old folder stays', async () => {
    const before = receivedRoot();
    const res = await post('/api/save-dir', { path: 'not absolute' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /full path/);
    assert.equal(receivedRoot(), before);
  });

  test('"Use default" goes back to the default folder', async () => {
    await post('/api/save-dir', { path: path.join(base, 'temp-choice') });
    const s = await (await post('/api/save-dir/default')).json();
    assert.equal(s.saveDir.isCustom, false);
    assert.equal(s.saveDir.path, path.join(base, 'default'));
  });

  test('picking the default folder by hand counts as the default', async () => {
    const s = await (await post('/api/save-dir', { path: path.join(base, 'default') })).json();
    assert.equal(s.saveDir.isCustom, false);
  });

  test('where there is no folder dialog, the page is told to type instead', { skip: process.platform === 'win32' }, async () => {
    assert.equal((await post('/api/save-dir/browse')).status, 501);
  });
});

describe('only this app\'s own page can use the PC server', () => {
  const body = JSON.stringify({ path: path.join(base, 'attacker-choice') });
  const json = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };

  test('another website cannot change the save folder', async () => {
    const code = await raw('POST', '/api/save-dir', { ...json, origin: 'https://evil.example' }, body);
    assert.equal(code, 403);
    assert.notEqual(receivedRoot(), path.join(base, 'attacker-choice'));
  });

  test('another website cannot start a session', async () => {
    assert.equal(await raw('POST', '/api/start', { origin: 'https://evil.example' }), 403);
  });

  test('a cross-site request is refused even without an Origin header', async () => {
    assert.equal(await raw('POST', '/api/stop', { 'sec-fetch-site': 'cross-site' }), 403);
  });

  test('DNS rebinding: a foreign Host is refused, even for reads', async () => {
    // An attacker's domain re-pointed at 127.0.0.1 would arrive with its own
    // name as Host, and could otherwise read the QR code's secret token.
    assert.equal(await raw('GET', '/api/status', { host: `evil.example:${port}` }), 403);
    assert.equal(await raw('GET', '/', { host: 'evil.example' }), 403);
  });

  test('the app\'s own page is still allowed', async () => {
    const code = await raw(
      'POST',
      '/api/save-dir/default',
      { 'content-type': 'application/json', 'content-length': 2, origin: pc, 'sec-fetch-site': 'same-origin' },
      '{}',
    );
    assert.equal(code, 200);
    assert.equal(await raw('GET', '/api/status', { host: `localhost:${port}` }), 200);
  });
});
