/**
 * Phase 2: session security.
 *
 * The real timings (90s rotation, 3 minute idle, 30 minute cap) would make
 * this suite unusable, so the same rules run in milliseconds here through the
 * ST_* environment overrides. The code under test is identical.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TTL = 300;
const GRACE = 150;
const IDLE = 500;
const UNCLAIMED = 900;
const HARD = 1800;
const MAX_FAILS = 3;

Object.assign(process.env, {
  STUFF_TRANSFER_DIR: await mkdtemp(path.join(tmpdir(), 'stuff-transfer-sec-')),
  ST_TOKEN_TTL_MS: String(TTL),
  ST_TOKEN_GRACE_MS: String(GRACE),
  ST_IDLE_TIMEOUT_MS: String(IDLE),
  ST_UNCLAIMED_TIMEOUT_MS: String(UNCLAIMED),
  ST_HARD_TIMEOUT_MS: String(HARD),
  ST_MAX_FAILED_ATTEMPTS: String(MAX_FAILS),
});

const { serve } = await import('@hono/node-server');
const { createPhoneApp } = await import('../dist/server-phone.js');
const { startSession, stopSession, peekSession, maintain, lastCloseReason } = await import(
  '../dist/session.js'
);

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
  await stopSession('done');
  server.close();
  await rm(process.env.STUFF_TRANSFER_DIR, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const claim = (token, deviceId) =>
  fetch(`${base}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, deviceId }),
  });

const heartbeat = (key) =>
  fetch(`${base}/api/heartbeat`, { method: 'POST', headers: { 'x-session-key': key } });

describe('rotating codes', () => {
  test('the token changes while nobody has scanned it', async () => {
    const session = await startSession();
    const first = session.token;

    await sleep(TTL + 60);
    maintain();

    assert.notEqual(session.token, first, 'an unscanned code should be replaced');
  });

  test('a code replaced moments ago still works, so a mid-scan phone is not punished', async () => {
    const session = await startSession();
    const first = session.token;

    await sleep(TTL + 60);
    maintain();

    const res = await claim(first, 'phone-mid-scan');
    assert.equal(res.status, 200, 'the just-replaced code should work during the grace period');
  });

  test('once the grace period passes, the old code is dead', async () => {
    const session = await startSession();
    const first = session.token;

    await sleep(TTL + 60);
    maintain();
    await sleep(GRACE + 80);

    const res = await claim(first, 'phone-too-late');
    assert.equal(res.status, 403, 'a photographed QR must stop working');
  });

  test('the code stops rotating once a phone is paired', async () => {
    const session = await startSession();
    await claim(session.token, 'phone-a');
    const paired = session.token;

    await sleep(TTL + 60);
    maintain();

    assert.equal(session.token, paired, 'rotating now would break the paired phone mid-upload');
  });
});

describe('pairing', () => {
  test('the first phone claims the session and a second is refused', async () => {
    const session = await startSession();

    const first = await claim(session.token, 'phone-a');
    assert.equal(first.status, 200);

    const second = await claim(session.token, 'phone-b');
    assert.equal(second.status, 409, 'a valid code must not let a second phone in');
  });

  test('the same phone can re-claim after a reload or dropped signal', async () => {
    const session = await startSession();

    const first = await claim(session.token, 'phone-a');
    const again = await claim(session.token, 'phone-a');

    assert.equal(again.status, 200, 'reloading must not lock a student out of their own session');
    assert.equal((await again.json()).sessionKey, (await first.json()).sessionKey);
  });

  test('a phone that claimed during the grace period gets the current token back', async () => {
    const session = await startSession();
    const scanned = session.token;

    await sleep(TTL + 60);
    maintain(); // rotates; `scanned` is now the previous token, still in grace

    const res = await claim(scanned, 'phone-a');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.token, session.token, 'the phone must be told the live token');
    assert.notEqual(body.token, scanned, 'otherwise a reload would lock the student out');
  });

  test('a phone keeps its session by key once the token it scanned is dead', async () => {
    const session = await startSession();
    const scanned = session.token;

    await sleep(TTL + 60);
    maintain(); // rotate, so the phone claims inside the grace window
    const { sessionKey } = await (await claim(scanned, 'phone-a')).json();

    await sleep(GRACE + 80); // the scanned token is now truly dead

    assert.equal((await claim(scanned, 'phone-a')).status, 403, 'the old token should be gone');
    const resumed = await heartbeat(sessionKey);
    assert.equal(resumed.status, 200, 'but the session key must still work, so reloads survive');
    assert.equal((await resumed.json()).pin, session.pin);
  });

  test('a claim without a device id is rejected', async () => {
    const session = await startSession();
    assert.equal((await claim(session.token, '')).status, 400);
  });
});

describe('timeouts', () => {
  test('a heartbeat keeps a session alive while the student picks files', async () => {
    const session = await startSession();
    const { sessionKey } = await (await claim(session.token, 'phone-a')).json();

    // Beat across a span longer than the idle timeout.
    for (let i = 0; i < 4; i++) {
      await sleep(IDLE / 2);
      assert.equal((await heartbeat(sessionKey)).status, 200, `heartbeat ${i} should be accepted`);
    }

    assert.equal(peekSession()?.closed, false, 'a phone that keeps checking in must stay connected');
  });

  test('a session closes when the phone goes quiet', async () => {
    const session = await startSession();
    const { sessionKey } = await (await claim(session.token, 'phone-a')).json();

    await sleep(IDLE + 150);
    maintain();

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'idle');
    assert.equal((await heartbeat(sessionKey)).status, 403);
  });

  test('a session nobody scans closes on its own', async () => {
    const session = await startSession();

    await sleep(UNCLAIMED + 150);
    maintain();

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'unscanned');
  });

  test('a long-running session ends at the hard limit', async () => {
    const session = await startSession();
    const { sessionKey } = await (await claim(session.token, 'phone-a')).json();

    // Keep it busy the whole time: the hard cap must win anyway.
    const deadline = Date.now() + HARD + 200;
    while (Date.now() < deadline) {
      await sleep(IDLE / 3);
      await heartbeat(sessionKey);
    }
    maintain();

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'expired');
  });
});

describe('guessing attempts', () => {
  test('repeated wrong codes kill the session', async () => {
    const session = await startSession();
    const goodToken = session.token;

    for (let i = 0; i < MAX_FAILS; i++) {
      const res = await claim('wrong-token-' + i, 'attacker');
      assert.equal(res.status, 403);
    }

    assert.equal(session.closed, true, 'the session should not survive a guessing run');
    assert.equal(lastCloseReason(), 'abuse');

    // Even the real token is now useless: the student must start a new session.
    assert.equal((await claim(goodToken, 'phone-a')).status, 403);
  });

  test('loading the page with a wrong token also counts as an attempt', async () => {
    const session = await startSession();

    for (let i = 0; i < MAX_FAILS; i++) {
      const res = await fetch(`${base}/t/not-a-real-token-${i}`);
      assert.equal(res.status, 404);
    }

    assert.equal(session.closed, true, 'page loads must not be a free way to probe tokens');
    assert.equal(lastCloseReason(), 'abuse');
  });

  test('a wrong code from a second phone is not counted as guessing', async () => {
    const session = await startSession();
    await claim(session.token, 'phone-a');

    // The token is correct, so this is a mix-up, not an attack. It must not
    // burn the student's session.
    for (let i = 0; i < MAX_FAILS + 2; i++) {
      assert.equal((await claim(session.token, 'phone-b')).status, 409);
    }

    assert.equal(session.closed, false, 'an honest mistake should not end the transfer');
  });
});
