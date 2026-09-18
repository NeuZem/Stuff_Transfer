/**
 * Phase 3: surviving bad networks, and not being knocked over by bad clients.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.STUFF_TRANSFER_DIR = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-res-'));

const { serve } = await import('@hono/node-server');
const { createPhoneApp } = await import('../dist/server-phone.js');
const { createPcApp } = await import('../dist/server-pc.js');
const { startSession, stopSession, peekSession } = await import('../dist/session.js');
const { CHUNK_SIZE } = await import('../dist/config.js');

let phoneServer;
let pcServer;
let base;
let pcBase;

const listen = (app) =>
  new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });

before(async () => {
  ({ server: phoneServer, url: base } = await listen(createPhoneApp()));
  ({ server: pcServer, url: pcBase } = await listen(createPcApp()));
});

after(async () => {
  await stopSession('done');
  phoneServer.close();
  pcServer.close();
  await rm(process.env.STUFF_TRANSFER_DIR, { recursive: true, force: true });
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function freshSession() {
  const session = await startSession();
  const res = await fetch(`${base}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: session.token, deviceId: 'phone-a' }),
  });
  const { sessionKey } = await res.json();
  return { session, key: sessionKey };
}

const post = (key, route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function init(key, name, size, fingerprint) {
  const res = await post(key, '/api/file/init', { name, size, fingerprint });
  return { res, body: await res.json() };
}

function putChunk(key, fileId, index, data, extra = {}) {
  return fetch(`${base}/api/file/${fileId}/chunk/${index}`, {
    method: 'PUT',
    headers: {
      'x-session-key': key,
      'content-type': 'application/octet-stream',
      'x-chunk-sha256': sha256(data),
    },
    body: data,
    ...extra,
  });
}

/** A body with no Content-Length: sent with chunked transfer encoding. */
function streamOf(totalBytes, pieceSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(pieceSize, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
}

describe('chunk size limits (memory safety)', () => {
  test('an oversized chunk streamed without Content-Length is cut off', async () => {
    const { key } = await freshSession();
    const { body: meta } = await init(key, 'small.bin', 1000);

    // Before the fix, this was buffered into memory whole. A client could
    // send gigabytes this way and exhaust the PC's RAM.
    const outcome = await fetch(`${base}/api/file/${meta.fileId}/chunk/0`, {
      method: 'PUT',
      headers: { 'x-session-key': key, 'content-type': 'application/octet-stream' },
      body: streamOf(50 * 1024 * 1024),
      duplex: 'half',
    }).then(
      (res) => res.status,
      (err) => err.cause?.code, // the server hung up while we were still sending
    );

    // Either is correct: a 413, or the server cutting the connection mid-send.
    assert.ok(
      outcome === 413 || outcome === 'ECONNRESET' || outcome === 'UND_ERR_SOCKET',
      `expected refusal, got ${outcome}`,
    );

    const file = peekSession().files.get(meta.fileId);
    assert.equal(file.inflightBytes, 0, 'no bytes left counted');
    assert.deepEqual(file.receivedChunks, [], 'nothing written');
  });

  test('a declared oversize is refused before reading anything', async () => {
    const { key } = await freshSession();
    const { body: meta } = await init(key, 'small.bin', 1000);

    const res = await putChunk(key, meta.fileId, 0, randomBytes(5000));
    assert.equal(res.status, 413);
  });

  test('a chunk shorter than expected is rejected', async () => {
    const { key } = await freshSession();
    const { body: meta } = await init(key, 'small.bin', 1000);

    const res = await putChunk(key, meta.fileId, 0, randomBytes(400));
    assert.equal(res.status, 400);
  });

  test('a chunk index past the end of the file is rejected', async () => {
    const { key } = await freshSession();
    const { body: meta } = await init(key, 'small.bin', 1000);

    const res = await putChunk(key, meta.fileId, 7, randomBytes(1000));
    assert.equal(res.status, 400);
  });

  test('a chunk abandoned mid-stream is not left counted as progress', async () => {
    const { key } = await freshSession();
    const { body: meta } = await init(key, 'big.bin', CHUNK_SIZE);

    // Start sending, then pull the plug partway, like a phone losing signal.
    const ctrl = new AbortController();
    const upload = fetch(`${base}/api/file/${meta.fileId}/chunk/0`, {
      method: 'PUT',
      headers: { 'x-session-key': key, 'content-type': 'application/octet-stream' },
      body: new ReadableStream({
        async pull(controller) {
          // Stop producing once aborted, or this test's own timers keep the
          // process alive after it finishes.
          if (ctrl.signal.aborted) return controller.close();
          controller.enqueue(new Uint8Array(256 * 1024));
          await new Promise((r) => setTimeout(r, 20));
        },
      }),
      duplex: 'half',
      signal: ctrl.signal,
    }).catch(() => null);

    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await upload;
    await new Promise((r) => setTimeout(r, 100));

    const file = peekSession().files.get(meta.fileId);
    assert.equal(file.inflightBytes, 0, 'aborted bytes must be withdrawn');
    assert.equal(file.bytesReceived, 0);
    assert.deepEqual(file.receivedChunks, []);
  });
});

describe('recovering from a lost reply', () => {
  test('asking to complete twice succeeds both times', async () => {
    const { session, key } = await freshSession();
    const data = randomBytes(2048);
    const { body: meta } = await init(key, 'twice.txt', data.length);
    await putChunk(key, meta.fileId, 0, data);

    const first = await post(key, `/api/file/${meta.fileId}/complete`);
    // The phone never heard back, so it asks again.
    const second = await post(key, `/api/file/${meta.fileId}/complete`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'a retry must not report failure for a finished file');
    assert.equal((await second.json()).sha256, sha256(data));
    assert.deepEqual(await readdir(session.dir), ['twice.txt'], 'and must not create a copy');
  });

  test('re-sending a chunk the PC already has is harmless', async () => {
    const { session, key } = await freshSession();
    const data = randomBytes(3000);
    const { body: meta } = await init(key, 'dup.bin', data.length);

    await putChunk(key, meta.fileId, 0, data);
    const again = await putChunk(key, meta.fileId, 0, data);
    assert.equal(again.status, 200);

    await post(key, `/api/file/${meta.fileId}/complete`);
    assert.deepEqual(await readFile(path.join(session.dir, 'dup.bin')), data);
  });
});

describe('resuming after a reload', () => {
  test('the same file picked again continues where it stopped', async () => {
    const { session, key } = await freshSession();
    const data = randomBytes(CHUNK_SIZE + 777);
    const fp = 'lecture.mp4|' + data.length + '|1726650000000';

    const first = await init(key, 'lecture.mp4', data.length, fp);
    await putChunk(key, first.body.fileId, 0, data.subarray(0, CHUNK_SIZE));

    // Page reloaded: the phone has forgotten the file id and registers again.
    const again = await init(key, 'lecture.mp4', data.length, fp);
    assert.equal(again.body.fileId, first.body.fileId, 'should resume, not start a second copy');
    assert.equal(again.body.resumed, true);
    assert.deepEqual(again.body.received, [0], 'and should report what already arrived');

    await putChunk(key, again.body.fileId, 1, data.subarray(CHUNK_SIZE));
    await post(key, `/api/file/${again.body.fileId}/complete`);
    assert.deepEqual(await readFile(path.join(session.dir, 'lecture.mp4')), data);
    assert.deepEqual(await readdir(session.dir), ['lecture.mp4'], 'exactly one copy');
  });

  test('a different file with the same name is not mistaken for it', async () => {
    const { key } = await freshSession();
    const a = await init(key, 'notes.pdf', 5000, 'notes.pdf|5000|111');
    const b = await init(key, 'notes.pdf', 5000, 'notes.pdf|5000|222'); // different edit time

    assert.notEqual(a.body.fileId, b.body.fileId);
    assert.equal(b.body.resumed, false);
  });

  test('a finished file is never resumed into', async () => {
    const { key } = await freshSession();
    const data = randomBytes(1500);
    const fp = 'photo.jpg|1500|999';

    const first = await init(key, 'photo.jpg', data.length, fp);
    await putChunk(key, first.body.fileId, 0, data);
    await post(key, `/api/file/${first.body.fileId}/complete`);

    // Sending the same photo again on purpose makes a second copy.
    const again = await init(key, 'photo.jpg', data.length, fp);
    assert.notEqual(again.body.fileId, first.body.fileId);
  });
});

describe('announcing the batch', () => {
  test('a batch over 1 GB is refused before any data is sent', async () => {
    const { key } = await freshSession();
    const res = await post(key, '/api/plan', { files: 3, bytes: 1.5 * 1024 ** 3 });
    assert.equal(res.status, 413);
  });

  test('a sensible batch is accepted and shown on the PC', async () => {
    const { key } = await freshSession();
    const res = await post(key, '/api/plan', { files: 4, bytes: 30_000_000 });
    assert.equal(res.status, 200);

    const status = await (await fetch(`${pcBase}/api/status`)).json();
    assert.equal(status.session.transfer.totalFiles, 4);
    assert.equal(status.session.transfer.totalBytes, 30_000_000);
    assert.equal(status.session.transfer.active, true);
  });

  test('a malformed plan is rejected', async () => {
    const { key } = await freshSession();
    assert.equal((await post(key, '/api/plan', { files: 0, bytes: 10 })).status, 400);
    assert.equal((await post(key, '/api/plan', { files: 'x' })).status, 400);
  });

  test('the plan needs the session key', async () => {
    await freshSession();
    assert.equal((await post('wrong', '/api/plan', { files: 1, bytes: 10 })).status, 403);
  });
});

describe('progress and speed on the PC', () => {
  test('the PC reports bytes, speed and time left while data flows', async () => {
    const { key } = await freshSession();
    const data = randomBytes(CHUNK_SIZE * 2);
    await post(key, '/api/plan', { files: 1, bytes: data.length * 2 }); // one more file to come
    const { body: meta } = await init(key, 'movie.bin', data.length);

    await putChunk(key, meta.fileId, 0, data.subarray(0, CHUNK_SIZE));

    const status = await (await fetch(`${pcBase}/api/status`)).json();
    const t = status.session.transfer;
    assert.equal(t.bytesDone, CHUNK_SIZE);
    assert.ok(t.bytesPerSec > 0, 'speed should be measured');
    assert.ok(t.etaSeconds > 0, 'time left should be estimated');
    assert.equal(t.stalled, false);
  });
});
