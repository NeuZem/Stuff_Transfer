/**
 * Updating to the newest published version. The rule that matters most: a
 * failed update must never stop the app from starting.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { isNewer, isInstalledCopy, runNewerIfAvailable } = await import('../dist/update.js');

describe('version comparison', () => {
  test('newer, older and equal', () => {
    assert.equal(isNewer('0.1.1', '0.1.0'), true);
    assert.equal(isNewer('0.2.0', '0.1.9'), true);
    assert.equal(isNewer('1.0.0', '0.9.9'), true);
    assert.equal(isNewer('0.1.0', '0.1.0'), false);
    assert.equal(isNewer('0.1.0', '0.2.0'), false);
    assert.equal(isNewer('0.10.0', '0.9.0'), true, 'numeric, not alphabetical');
  });
});

describe('which copies update themselves', () => {
  test('an npx or npm-installed copy does', () => {
    assert.equal(isInstalledCopy('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\stuff-transfer\\dist\\cli.js'), true);
    assert.equal(isInstalledCopy('/usr/lib/node_modules/stuff-transfer/dist/cli.js'), true);
  });

  test('a source checkout never does, so development is not hijacked', () => {
    assert.equal(isInstalledCopy('D:\\Stuff Transfer\\dist\\cli.js'), false);
  });
});

describe('deciding whether to update', () => {
  // A stand-in for the npm registry, answering with whatever `reply` says.
  let reply = { status: 200, body: { version: '0.1.0' } };
  let server;
  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.ST_UPDATE_URL = `http://127.0.0.1:${server.address().port}/stuff-transfer/latest`;
  });
  after(() => {
    server.close();
    delete process.env.ST_UPDATE_URL;
  });

  const installed = 'C:\\npm-cache\\_npx\\x\\node_modules\\stuff-transfer\\dist\\cli.js';
  const check = (current) => runNewerIfAvailable({ current, selfPath: installed, argv: ['--no-open'] });

  test('already the newest: carry on', async () => {
    reply = { status: 200, body: { version: '0.1.0' } };
    assert.equal(await check('0.1.0'), null);
  });

  test('not published yet (npm says 404): carry on', async () => {
    reply = { status: 404, body: { error: 'Not found' } };
    assert.equal(await check('0.1.0'), null);
  });

  test('npm unreachable: carry on, without a long wait', async () => {
    const saved = process.env.ST_UPDATE_URL;
    process.env.ST_UPDATE_URL = 'http://127.0.0.1:1/unreachable';
    const started = Date.now();
    assert.equal(await check('0.1.0'), null);
    assert.ok(Date.now() - started < 4000, 'an update check must never hold up the app');
    process.env.ST_UPDATE_URL = saved;
  });

  test('a newer version that fails to download: carry on with this one', { timeout: 90_000 }, async () => {
    // npm really has no such version, so the download genuinely fails.
    reply = { status: 200, body: { version: '99.0.0' } };
    assert.equal(await check('0.1.0'), null, 'a broken update must not stop the app');
  });

  test('--no-update skips the check entirely', async () => {
    reply = { status: 200, body: { version: '99.0.0' } };
    process.env.ST_NO_UPDATE = '1';
    try {
      assert.equal(await check('0.1.0'), null);
    } finally {
      delete process.env.ST_NO_UPDATE;
    }
  });
});
