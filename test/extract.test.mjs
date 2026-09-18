/**
 * Phase 4: unpacking received zips, which are untrusted input from a phone.
 *
 * Normal zip libraries refuse to CREATE malicious zips, so these tests build a
 * harmless zip and then rewrite bytes in it, the way a real attacker would.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';

// A small cap so the zip-bomb test does not need gigabytes.
const BOMB_CAP = 10 * 1024 * 1024;
process.env.ST_MAX_EXTRACT_BYTES = String(BOMB_CAP);
process.env.STUFF_TRANSFER_DIR = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-zip-'));

const { extractZip, ExtractError } = await import('../dist/extract.js');

let work;
before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'zip-work-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(process.env.STUFF_TRANSFER_DIR, { recursive: true, force: true });
});

/** Build a zip in memory. */
function makeZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) {
      if (e.name.endsWith('/')) zip.addEmptyDirectory(e.name);
      else zip.addBuffer(e.data, e.name, { mode: e.mode, compress: e.compress ?? true });
    }
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

/** Rewrite every occurrence of `from` with `to` (same length), e.g. in file names. */
function patch(buf, from, to) {
  assert.equal(from.length, to.length, 'patches must keep the length');
  const out = Buffer.from(buf);
  let i = out.indexOf(from);
  assert.ok(i >= 0, `"${from}" not found in zip`);
  while (i >= 0) {
    out.write(to, i, 'latin1');
    i = out.indexOf(from, i + 1);
  }
  return out;
}

/** A fresh folder holding one zip, as if just received. */
async function receive(name, buf) {
  const dir = await mkdtemp(path.join(work, 'session-'));
  const zipPath = path.join(dir, name);
  await writeFile(zipPath, buf);
  return { dir, zipPath };
}

/** Everything in `dir`, recursively, as relative paths. */
async function tree(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replaceAll('\\', '/'));
  }
  return out.sort();
}

describe('unpacking a normal zip', () => {
  test('files and folders come out intact, next to the zip', async () => {
    const a = randomBytes(5000);
    const b = randomBytes(300);
    const { dir, zipPath } = await receive(
      'notes.zip',
      await makeZip([
        { name: 'week1/maths/a.pdf', data: a },
        { name: 'week1/b.txt', data: b },
        { name: 'week2/', data: Buffer.alloc(0) }, // an empty folder entry
      ]),
    );

    const result = await extractZip(zipPath, dir);

    assert.equal(result.folder, path.join(dir, 'notes'));
    assert.equal(result.files, 2);
    assert.deepEqual(await readFile(path.join(dir, 'notes', 'week1', 'maths', 'a.pdf')), a);
    assert.deepEqual(await readFile(path.join(dir, 'notes', 'week1', 'b.txt')), b);
  });

  test('a zipped folder is not nested twice (how iPhones compress folders)', async () => {
    const { dir, zipPath } = await receive(
      'Semester 3.zip',
      await makeZip([
        { name: 'Semester 3/', data: Buffer.alloc(0) },
        { name: 'Semester 3/DBMS/notes.txt', data: Buffer.from('notes') },
        { name: 'Semester 3/OS/lab1.txt', data: Buffer.from('lab') },
      ]),
    );

    const result = await extractZip(zipPath, dir);

    assert.equal(path.basename(result.folder), 'Semester 3');
    assert.deepEqual(await tree(result.folder), ['DBMS/notes.txt', 'OS/lab1.txt'], 'not Semester 3/Semester 3/...');
  });

  test('a single top folder with an unsafe name is still sanitised', async () => {
    const clean = await makeZip([{ name: 'CON/a.txt', data: Buffer.from('x') }]);
    const { dir, zipPath } = await receive('dev.zip', clean);
    const result = await extractZip(zipPath, dir);
    assert.equal(path.basename(result.folder), '_CON', 'a Windows device name must not become a folder');
  });

  test('unpacking twice does not overwrite the first copy', async () => {
    const { dir, zipPath } = await receive('pics.zip', await makeZip([{ name: 'x.jpg', data: randomBytes(10) }]));
    const first = await extractZip(zipPath, dir);
    const second = await extractZip(zipPath, dir);
    assert.notEqual(first.folder, second.folder);
    assert.equal(path.basename(second.folder), 'pics (1)');
  });
});

describe('malicious zips', () => {
  test('zip slip: an entry named ../ is refused and nothing escapes', async () => {
    const clean = await makeZip([{ name: 'ok.txt', data: Buffer.from('fine') }, { name: 'xx/evil.txt', data: Buffer.from('pwned') }]);
    const { dir, zipPath } = await receive('slip.zip', patch(clean, 'xx/evil.txt', '../evil.txt'));

    await assert.rejects(extractZip(zipPath, dir), ExtractError);

    assert.equal(existsSync(path.join(work, 'evil.txt')), false, 'nothing may be written above the folder');
    assert.deepEqual(await readdir(dir), ['slip.zip'], 'and no half-unpacked folder is left behind');
  });

  test('zip slip with Windows backslashes is refused too', async () => {
    const clean = await makeZip([{ name: 'aaevil.txt', data: Buffer.from('pwned') }]);
    const { dir, zipPath } = await receive('slash.zip', patch(clean, 'aaevil', '..\\evi'));

    await assert.rejects(extractZip(zipPath, dir), ExtractError);
    assert.deepEqual(await readdir(dir), ['slash.zip']);
  });

  test('an absolute path is refused', async () => {
    const clean = await makeZip([{ name: 'CC/Windows/evil.dll', data: Buffer.from('pwned') }]);
    const { dir, zipPath } = await receive('abs.zip', patch(clean, 'CC/Windows', 'C:/Windows'));

    await assert.rejects(extractZip(zipPath, dir), ExtractError);
    assert.deepEqual(await readdir(dir), ['abs.zip']);
  });

  test('zip bomb: refused before a single byte is written', async () => {
    // 50 MB of zeros compresses to about 50 KB.
    const bomb = await makeZip([{ name: 'zeros.bin', data: Buffer.alloc(50 * 1024 * 1024) }]);
    assert.ok(bomb.length < 1024 * 1024, 'the test zip itself should be tiny');
    const { dir, zipPath } = await receive('bomb.zip', bomb);

    await assert.rejects(extractZip(zipPath, dir), /more than the/);
    assert.deepEqual(await readdir(dir), ['bomb.zip']);
  });

  test('a zip that lies about its sizes is caught mid-unpack and cleaned up', async () => {
    // Declare 1,000 bytes but actually hold 200,000. This slips past the
    // up-front size check, so the stream-level check has to catch it.
    const real = Buffer.alloc(200_000, 0x41);
    const clean = await makeZip([{ name: 'liar.txt', data: real }]);
    const out = Buffer.from(clean);

    // Central directory entry: signature 0x02014b50, uncompressed size at +24.
    const cd = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.equal(out.readUInt32LE(cd + 24), real.length);
    out.writeUInt32LE(1000, cd + 24);

    const { dir, zipPath } = await receive('liar.zip', out);
    await assert.rejects(extractZip(zipPath, dir), ExtractError);
    assert.deepEqual(await readdir(dir), ['liar.zip'], 'the partial unpack must be removed');
  });

  test('symbolic links are skipped, never recreated', async () => {
    const zip = await makeZip([
      { name: 'real.txt', data: Buffer.from('hello') },
      // A link entry whose "content" is its target.
      { name: 'sneaky', data: Buffer.from('C:/Windows/System32'), mode: 0o120777 },
    ]);
    const { dir, zipPath } = await receive('links.zip', zip);

    const result = await extractZip(zipPath, dir);

    assert.equal(result.skipped, 1);
    assert.deepEqual(await tree(result.folder), ['real.txt']);
  });

  test('a file that is not really a zip gets a clear message', async () => {
    const { dir, zipPath } = await receive('fake.zip', randomBytes(4000));
    await assert.rejects(extractZip(zipPath, dir), /not a valid zip|damaged/);
  });
});

describe('through the PC page', () => {
  test('a received zip can be unpacked from the PC, and the phone cannot trigger it', async () => {
    const { serve } = await import('@hono/node-server');
    const { createPhoneApp } = await import('../dist/server-phone.js');
    const { createPcApp } = await import('../dist/server-pc.js');
    const { startSession, stopSession } = await import('../dist/session.js');

    const listen = (app) =>
      new Promise((resolve) => {
        const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
          resolve({ server, url: `http://127.0.0.1:${info.port}` }),
        );
      });
    const phoneApp = createPhoneApp();
    const phone = await listen(phoneApp);
    const pc = await listen(createPcApp());

    try {
      const session = await startSession();
      const claim = await fetch(`${phone.url}/api/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: session.token, deviceId: 'p' }),
      });
      const { sessionKey } = await claim.json();
      const headers = { 'content-type': 'application/json', 'x-session-key': sessionKey };

      const zip = await makeZip([{ name: 'hw/answer.txt', data: Buffer.from('42') }]);
      const init = await (
        await fetch(`${phone.url}/api/file/init`, {
          method: 'POST', headers, body: JSON.stringify({ name: 'homework.zip', size: zip.length }),
        })
      ).json();
      await fetch(`${phone.url}/api/file/${init.fileId}/chunk/0`, {
        method: 'PUT',
        headers: { 'x-session-key': sessionKey, 'x-chunk-sha256': createHash('sha256').update(zip).digest('hex') },
        body: zip,
      });
      await fetch(`${phone.url}/api/file/${init.fileId}/complete`, { method: 'POST', headers });

      // The phone server has no such route at all.
      assert.equal(
        phoneApp.routes.some((r) => r.path.includes('extract')),
        false,
        'unpacking must only be possible from the PC itself',
      );

      const res = await fetch(`${pc.url}/api/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: init.fileId }),
      });
      assert.equal(res.status, 200);
      // The zip holds one top folder, "hw", so that becomes the folder name.
      assert.equal(await readFile(path.join(session.dir, 'hw', 'answer.txt'), 'utf8'), '42');

      const status = await (await fetch(`${pc.url}/api/status`)).json();
      const row = status.session.files.find((f) => f.id === init.fileId);
      assert.equal(row.extractedTo, 'hw');
      assert.equal(row.canExtract, false);
    } finally {
      await stopSession('done');
      phone.server.close();
      pc.server.close();
    }
  });
});
