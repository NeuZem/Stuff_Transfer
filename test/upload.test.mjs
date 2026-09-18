/**
 * End-to-end tests against the PUBLIC phone server.
 *
 * These drive the same HTTP API a phone uses, so they cover both the happy
 * path and the things an attacker with the tunnel URL would try.
 *
 * Run with:  npm test   (after npm run build)
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.STUFF_TRANSFER_DIR = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-test-'));

const { serve } = await import('@hono/node-server');
const { createPhoneApp } = await import('../dist/server-phone.js');
const { startSession, stopSession, getSession } = await import('../dist/session.js');
const { CHUNK_SIZE } = await import('../dist/config.js');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = serve({ fetch: createPhoneApp().fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

after(async () => {
  await stopSession();
  server.close();
  await rm(process.env.STUFF_TRANSFER_DIR, { recursive: true, force: true });
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Claim a fresh session and return its key plus the session object. */
async function freshSession() {
  const session = await startSession();
  const res = await fetch(`${base}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: session.token, deviceId: 'test-phone' }),
  });
  assert.equal(res.status, 200, 'claim should succeed with the right token');
  const { sessionKey } = await res.json();
  return { session, sessionKey };
}

/** Upload a buffer the way the phone page does, chunk by chunk. */
async function upload(sessionKey, name, data, opts = {}) {
  const init = await fetch(`${base}/api/file/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-key': sessionKey },
    body: JSON.stringify({ name, size: data.length, relPath: opts.relPath }),
  });
  const meta = await init.json();
  if (!init.ok) return { init, meta };

  const total = meta.totalChunks;
  const only = opts.onlyChunks ?? [...Array(total).keys()];

  for (const index of only) {
    const slice = data.subarray(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, data.length));
    const res = await fetch(`${base}/api/file/${meta.fileId}/chunk/${index}`, {
      method: 'PUT',
      headers: {
        'x-session-key': sessionKey,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': opts.corruptHashes ? sha256(Buffer.from('wrong')) : sha256(slice),
      },
      body: slice,
    });
    if (!res.ok) return { chunkFailed: res, meta };
  }

  if (opts.skipComplete) return { meta };

  const done = await fetch(`${base}/api/file/${meta.fileId}/complete`, {
    method: 'POST',
    headers: { 'x-session-key': sessionKey },
  });
  return { meta, done, result: await done.json() };
}

describe('uploading', () => {
  test('a small file arrives byte-for-byte intact', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(64 * 1024);

    const { done, result } = await upload(sessionKey, 'notes.txt', data);

    assert.equal(done.status, 200);
    assert.equal(result.sha256, sha256(data), 'PC-side hash should match what we sent');

    const saved = await readFile(path.join(session.dir, 'notes.txt'));
    assert.deepEqual(saved, data);
  });

  test('a multi-chunk file is reassembled in the right order', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(CHUNK_SIZE * 2 + 12345); // 3 chunks, last one partial

    const { meta, result } = await upload(sessionKey, 'big.bin', data);

    assert.equal(meta.totalChunks, 3);
    assert.equal(result.sha256, sha256(data));
    assert.deepEqual(await readFile(path.join(session.dir, 'big.bin')), data);
  });

  test('a second file with the same name does not overwrite the first', async () => {
    const { session, sessionKey } = await freshSession();
    const first = randomBytes(1024);
    const second = randomBytes(2048);

    await upload(sessionKey, 'report.pdf', first);
    await upload(sessionKey, 'report.pdf', second);

    const names = (await readdir(session.dir)).sort();
    assert.deepEqual(names, ['report (1).pdf', 'report.pdf']);
    assert.deepEqual(await readFile(path.join(session.dir, 'report.pdf')), first);
    assert.deepEqual(await readFile(path.join(session.dir, 'report (1).pdf')), second);
  });

  test('a folder upload keeps its structure', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(512);

    await upload(sessionKey, 'a.txt', data, { relPath: 'week1/maths/a.txt' });

    assert.deepEqual(await readFile(path.join(session.dir, 'week1', 'maths', 'a.txt')), data);
  });
});

describe('resume', () => {
  test('completing early fails, and the missing chunk can be sent afterwards', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(CHUNK_SIZE + 500); // 2 chunks

    // Send only the first chunk, then try to finish.
    const { meta } = await upload(sessionKey, 'partial.bin', data, { onlyChunks: [0], skipComplete: true });
    const early = await fetch(`${base}/api/file/${meta.fileId}/complete`, {
      method: 'POST',
      headers: { 'x-session-key': sessionKey },
    });
    assert.equal(early.status, 409, 'an incomplete file must not be published');

    // The phone asks what is missing, exactly as it does after a dropped signal.
    const status = await (
      await fetch(`${base}/api/file/${meta.fileId}`, { headers: { 'x-session-key': sessionKey } })
    ).json();
    assert.deepEqual(status.received, [0]);

    const slice = data.subarray(CHUNK_SIZE);
    await fetch(`${base}/api/file/${meta.fileId}/chunk/1`, {
      method: 'PUT',
      headers: {
        'x-session-key': sessionKey,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': sha256(slice),
      },
      body: slice,
    });

    const done = await fetch(`${base}/api/file/${meta.fileId}/complete`, {
      method: 'POST',
      headers: { 'x-session-key': sessionKey },
    });
    assert.equal(done.status, 200);
    assert.deepEqual(await readFile(path.join(session.dir, 'partial.bin')), data);
  });
});

describe('security', () => {
  test('a wrong token cannot claim a session', async () => {
    await startSession();
    const res = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-the-real-token' }),
    });
    assert.equal(res.status, 403);
  });

  test('an old token stops working once a new session starts', async () => {
    const { session } = await freshSession();
    const oldToken = session.token;
    await startSession(); // as if the student clicked Receive again

    const res = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: oldToken }),
    });
    assert.equal(res.status, 403, 'a photographed QR must not keep working');
  });

  test('file routes reject a missing or wrong session key', async () => {
    await freshSession();
    const body = JSON.stringify({ name: 'x.txt', size: 10 });

    const none = await fetch(`${base}/api/file/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(none.status, 403);

    const wrong = await fetch(`${base}/api/file/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-key': 'guessed' },
      body,
    });
    assert.equal(wrong.status, 403);
  });

  test('path traversal in a name cannot escape the session folder', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(256);

    await upload(sessionKey, '../../../evil.txt', data);
    await upload(sessionKey, 'ok.txt', data, { relPath: '../../escape/ok.txt' });

    // Both must land inside the session folder, never above it. Sibling
    // session folders are expected; an uploaded *file* up there is not.
    const parent = path.dirname(session.dir);
    const entries = await readdir(parent, { withFileTypes: true });
    const strays = entries.filter((e) => e.isFile()).map((e) => e.name);
    assert.deepEqual(strays, [], 'no uploaded file should be written outside a session folder');

    const inside = await readdir(session.dir);
    assert.ok(inside.includes('evil.txt'), 'the traversal prefix should be stripped, not honoured');
  });

  test('a corrupted chunk is rejected and never becomes a file', async () => {
    const { session, sessionKey } = await freshSession();
    const before = await readdir(session.dir);

    const { chunkFailed } = await upload(sessionKey, 'tampered.bin', randomBytes(2048), {
      corruptHashes: true,
    });

    assert.equal(chunkFailed.status, 400);
    const after = (await readdir(session.dir)).filter((n) => !n.endsWith('.part'));
    assert.deepEqual(after, before, 'no finished file should appear');
  });

  test('a file over the 1 GB limit is refused up front', async () => {
    const { sessionKey } = await freshSession();
    const res = await fetch(`${base}/api/file/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-key': sessionKey },
      body: JSON.stringify({ name: 'huge.zip', size: 2 * 1024 ** 3 }),
    });
    assert.equal(res.status, 413);
  });

  test('the public server exposes no route that reads from the PC', () => {
    // The guarantee students rely on: this server can receive, never send.
    const routes = createPhoneApp().routes.map((r) => `${r.method} ${r.path}`);
    const readable = routes.filter(
      (r) => r.startsWith('GET') && !['GET /health', 'GET /t/:token', 'GET /api/file/:id'].includes(r),
    );
    assert.deepEqual(readable, [], `unexpected readable route(s): ${readable.join(', ')}`);
  });

  test('session close aborts unfinished files instead of leaving them', async () => {
    const { session, sessionKey } = await freshSession();
    const data = randomBytes(CHUNK_SIZE + 10);

    await upload(sessionKey, 'abandoned.bin', data, { onlyChunks: [0], skipComplete: true });
    assert.equal(getSession()?.files.size, 1);

    await session.close();

    const leftovers = await readdir(session.dir);
    assert.deepEqual(leftovers, [], 'the .part file should be cleaned up');
  });
});
