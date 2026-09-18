/**
 * Full integration test: drives the real app through the real public tunnel,
 * pretending to be a phone.
 *
 * Unlike the unit tests, this proves the parts that only exist at runtime:
 * the tunnel, the QR URL, and the separation between the public server and
 * the PC's own controls.
 *
 * Run with:  node scripts/e2e-tunnel.mjs
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHUNK_SIZE = 4 * 1024 * 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const receiveDir = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-e2e-'));

console.log('\n=== Stuff Transfer — end-to-end check ===\n');
console.log('Starting the app...');

const app = spawn(process.execPath, ['dist/cli.js'], {
  env: { ...process.env, STUFF_TRANSFER_DIR: receiveDir, STUFF_TRANSFER_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (b) => process.stdout.write(`  | ${b}`));
app.stderr.on('data', (b) => process.stdout.write(`  | ${b}`));

const cleanup = async () => {
  app.kill();
  await rm(receiveDir, { recursive: true, force: true });
};

try {
  // The PC page walks forward from 7777 if that port is busy.
  const pcBase = await findPcServer();
  console.log(`\nPC server: ${pcBase}`);

  const status = await waitForTunnel(pcBase);
  check(status.tunnel === 'ready', 'tunnel came up', status.tunnelError ?? '');

  // Start a session, exactly as clicking "Receive files" does.
  const started = await (await fetch(`${pcBase}/api/start`, { method: 'POST' })).json();
  const phoneUrl = started.session.url;
  const origin = new URL(phoneUrl).origin;
  console.log(`Phone URL: ${phoneUrl}\n`);

  // --- what a phone does ---
  const page = await fetch(phoneUrl);
  check(page.ok, 'phone page loads over HTTPS', `HTTP ${page.status}`);

  const token = phoneUrl.split('/t/')[1];
  const claimAs = (deviceId) =>
    fetch(`${origin}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, deviceId }),
    });

  const claim = await claimAs('e2e-phone');
  const { sessionKey, pin } = await claim.json();
  check(claim.ok && !!sessionKey, 'phone claims the session');
  check(pin === started.session.pin, 'PIN matches on both screens', `${pin} vs ${started.session.pin}`);

  const intruder = await claimAs('someone-elses-phone');
  check(intruder.status === 409, 'a second phone is refused', `HTTP ${intruder.status}`);

  // A 9 MB file: three chunks, so ordering and the partial last chunk are exercised.
  const data = randomBytes(9 * 1024 * 1024);
  const init = await fetch(`${origin}/api/file/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-key': sessionKey },
    body: JSON.stringify({ name: 'photos.zip', size: data.length }),
  });
  const meta = await init.json();
  check(init.ok && meta.totalChunks === 3, 'file registered', `${meta.totalChunks} chunks`);

  const t0 = Date.now();
  for (let i = 0; i < meta.totalChunks; i++) {
    const slice = data.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, data.length));
    const res = await fetch(`${origin}/api/file/${meta.fileId}/chunk/${i}`, {
      method: 'PUT',
      headers: {
        'x-session-key': sessionKey,
        'content-type': 'application/octet-stream',
        'x-chunk-sha256': sha256(slice),
      },
      body: slice,
    });
    if (!res.ok) check(false, `chunk ${i} uploaded`, await res.text());
  }
  const seconds = (Date.now() - t0) / 1000;

  const done = await fetch(`${origin}/api/file/${meta.fileId}/complete`, {
    method: 'POST',
    headers: { 'x-session-key': sessionKey },
  });
  const result = await done.json();
  check(done.ok, 'upload completed');
  check(result.sha256 === sha256(data), 'file arrived intact (SHA-256 match)');

  const saved = await readFile(path.join(started.session.dir, 'photos.zip'));
  check(saved.length === data.length, 'file on disk has the right size');
  console.log(`        9 MB through the tunnel in ${seconds.toFixed(1)}s ` +
    `(${(9 / seconds).toFixed(1)} MB/s from this PC)`);

  // --- what an attacker with the URL would try ---
  console.log('');
  const pcPage = await fetch(`${origin}/`);
  check(pcPage.status === 404, 'PC page is NOT reachable through the tunnel', `HTTP ${pcPage.status}`);

  const pcStatus = await fetch(`${origin}/api/status`);
  check(pcStatus.status === 404, 'PC status is NOT reachable through the tunnel', `HTTP ${pcStatus.status}`);

  const pcStop = await fetch(`${origin}/api/stop`, { method: 'POST' });
  check(pcStop.status === 404, 'nobody outside can stop the session', `HTTP ${pcStop.status}`);

  const noKey = await fetch(`${origin}/api/file/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', size: 1 }),
  });
  check(noKey.status === 403, 'uploads without the session key are refused', `HTTP ${noKey.status}`);

  // The PC UI should now show the finished file.
  const after = await (await fetch(`${pcBase}/api/status`)).json();
  check(after.session.files.some((f) => f.name === 'photos.zip' && f.status === 'done'),
    'PC page shows the received file');
} catch (e) {
  check(false, 'run completed', e.message);
} finally {
  await cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

async function findPcServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (let port = 7777; port < 7797; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (res.ok) return `http://127.0.0.1:${port}`;
      } catch { /* not this one */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('PC server never came up');
}

async function waitForTunnel(pcBase) {
  const deadline = Date.now() + 120_000;
  let status;
  while (Date.now() < deadline) {
    status = await (await fetch(`${pcBase}/api/status`)).json();
    if (status.tunnel !== 'starting') return status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return status;
}
