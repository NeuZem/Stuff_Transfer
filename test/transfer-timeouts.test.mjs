/**
 * Phase 3: timeouts must bend for a transfer in progress, without becoming
 * a way to hold a session open forever.
 *
 * Real values: idle 3 min, idle-mid-transfer 10 min, lifetime 30 min,
 * absolute ceiling 2 h. Scaled to milliseconds here; same rules.
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Keep the real ordering (idle < transfer-idle < lifetime < ceiling), or the
// wrong limit fires first and the tests check nothing meaningful.
const IDLE = 300;
const TRANSFER_IDLE = 1200;
const HARD = 2400;
const ABSOLUTE = 4000;

Object.assign(process.env, {
  STUFF_TRANSFER_DIR: await mkdtemp(path.join(tmpdir(), 'stuff-transfer-tt-')),
  ST_IDLE_TIMEOUT_MS: String(IDLE),
  ST_TRANSFER_IDLE_TIMEOUT_MS: String(TRANSFER_IDLE),
  ST_HARD_TIMEOUT_MS: String(HARD),
  ST_ABSOLUTE_MAX_MS: String(ABSOLUTE),
  ST_UNCLAIMED_TIMEOUT_MS: '60000',
});

const { startSession, stopSession, maintain, lastCloseReason } = await import('../dist/session.js');
const { IncomingFile } = await import('../dist/receiver.js');

after(async () => {
  await stopSession('done');
  await rm(process.env.STUFF_TRANSFER_DIR, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A paired session with one part-sent file, as if mid-upload. */
async function midTransfer() {
  const session = await startSession();
  session.claim(session.token, 'phone-a');
  const file = await IncomingFile.create({
    id: 'f1',
    sessionDir: session.dir,
    name: 'lecture.mp4',
    size: 10_000_000,
  });
  session.files.set(file.id, file);
  session.recordBytes(1000);
  return session;
}

describe('silence', () => {
  test('with nothing in progress, a quiet phone is dropped at the normal limit', async () => {
    const session = await startSession();
    session.claim(session.token, 'phone-a');

    await sleep(IDLE + 100);
    maintain();

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'idle');
  });

  test('mid-transfer, the same silence is survived — the phone probably lost signal', async () => {
    const session = await midTransfer();

    await sleep(IDLE + 300); // past the normal limit, inside the transfer limit
    maintain();

    assert.equal(session.closed, false, 'a lift ride must not cost the student their upload');
  });

  test('mid-transfer silence still ends eventually', async () => {
    const session = await midTransfer();

    await sleep(TRANSFER_IDLE + 150);
    maintain();

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'idle');
  });

  test('a batch the phone announced but has not started counts as in progress', async () => {
    const session = await startSession();
    session.claim(session.token, 'phone-a');
    session.plan = { files: 2, bytes: 5000 };

    await sleep(IDLE + 200);
    maintain();

    assert.equal(session.closed, false);
  });
});

describe('lifetime', () => {
  test('a slow transfer that keeps moving is allowed past the normal lifetime', async () => {
    const session = await midTransfer();

    // Data trickles in the whole time, like 1 GB over a weak signal.
    const until = Date.now() + HARD + 400;
    while (Date.now() < until) {
      await sleep(100);
      session.touch();
      session.recordBytes(500);
      maintain();
    }

    assert.equal(session.closed, false, 'cutting off a working 1 GB upload helps nobody');
  });

  test('but not past the absolute ceiling', async () => {
    const session = await midTransfer();

    const until = Date.now() + ABSOLUTE + 200;
    while (Date.now() < until && !session.closed) {
      await sleep(100);
      session.touch();
      session.recordBytes(500);
      maintain();
    }

    assert.equal(session.closed, true);
    assert.equal(lastCloseReason(), 'expired');
  });

  test('heartbeats alone do not earn the extension', async () => {
    const session = await midTransfer();

    // The phone checks in but sends no data, as if parked with a plan open.
    const until = Date.now() + HARD + 300;
    while (Date.now() < until && !session.closed) {
      await sleep(100);
      session.touch();
      maintain();
    }

    assert.equal(session.closed, true, 'idling with a plan must not hold a session for two hours');
    assert.equal(lastCloseReason(), 'expired');
  });
});
