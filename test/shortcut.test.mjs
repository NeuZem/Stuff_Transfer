/**
 * The Desktop shortcut and its launcher.
 *
 * Both the Desktop and the app's data folder are redirected to temporary
 * folders, so running the tests never touches the real Desktop.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const onWindows = process.platform === 'win32';

const base = await mkdtemp(path.join(tmpdir(), 'stuff-transfer-shortcut-'));
const desktop = path.join(base, 'Desktop');
process.env.STUFF_TRANSFER_DATA_DIR = path.join(base, 'appdata');
process.env.ST_DESKTOP_DIR = desktop;

const { makeIco } = await import('../dist/icon.js');
const { buildLauncher, ensureDesktopShortcut, appDataDir } = await import('../dist/shortcut.js');

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

before(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(desktop, { recursive: true });
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the icon', () => {
  const ico = makeIco();

  test('is a valid multi-size .ico', () => {
    assert.equal(ico.readUInt16LE(0), 0, 'reserved');
    assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
    const count = ico.readUInt16LE(4);
    assert.ok(count >= 4, 'several sizes');

    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const bytes = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      assert.ok(offset + bytes <= ico.length, `image ${i} lies inside the file`);
      assert.equal(ico.readUInt32LE(offset), 40, `image ${i} starts with a bitmap header`);
    }
  });

  /** Read one pixel of the 48x48 image as [r, g, b, a]. */
  function pixel48(x, y) {
    const count = ico.readUInt16LE(4);
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      if (ico.readUInt8(entry) !== 48) continue;
      const pixels = ico.readUInt32LE(entry + 12) + 40;
      const at = pixels + ((47 - y) * 48 + x) * 4; // rows are stored bottom-up
      return [ico[at + 2], ico[at + 1], ico[at], ico[at + 3]];
    }
    throw new Error('no 48px image');
  }

  test('corners are transparent (rounded square)', () => {
    assert.equal(pixel48(0, 0)[3], 0);
    assert.equal(pixel48(47, 47)[3], 0);
  });

  test('the background is the app\'s near-black and the arrow is white', () => {
    const [r, g, b, a] = pixel48(10, 24); // left of the arrow
    assert.ok(r < 40 && g < 40 && b < 40 && a === 255, `expected near-black, got ${[r, g, b, a]}`);
    const stem = pixel48(24, 22); // on the arrow's stem
    assert.ok(stem.slice(0, 3).every((c) => c > 200), `expected white, got ${stem}`);
  });
});

describe('the launcher', () => {
  test('runs this exact copy of the app, and falls back to npx', () => {
    const script = buildLauncher({ cliPath: 'C:\\apps\\st\\dist\\cli.js', nodePath: 'C:\\node\\node.exe' });
    assert.match(script, /set "ST_APP=C:\\apps\\st\\dist\\cli\.js"/);
    assert.match(script, /set "ST_NODE=C:\\node\\node\.exe"/);
    assert.match(script, /npx(\.cmd)?"? --yes stuff-transfer/);
    assert.ok(script.includes('\r\n'), 'cmd.exe needs Windows line endings');
  });

  test('a % in a folder name cannot be read as a variable', () => {
    const script = buildLauncher({ cliPath: 'C:\\100%done\\cli.js', nodePath: 'C:\\node\\node.exe' });
    assert.ok(script.includes('C:\\100%%done\\cli.js'));
  });
});

describe('creating the shortcut', () => {
  test('outside Windows, nothing is created', { skip: onWindows }, async () => {
    assert.equal((await ensureDesktopShortcut({ cliPath })).status, 'unsupported');
  });

  test('first run: a shortcut appears on the Desktop, with the icon', { skip: !onWindows }, async () => {
    const result = await ensureDesktopShortcut({ cliPath });
    assert.equal(result.status, 'created', result.message);
    assert.equal(result.path, path.join(desktop, 'Stuff Transfer.lnk'));
    assert.ok(existsSync(result.path));

    // Read it back through Windows itself.
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-Command',
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${result.path.replace(/'/g, "''")}'); "$($s.TargetPath)|$($s.IconLocation)"`,
    ]);
    const [target, icon] = stdout.trim().split('|');
    // Compare locations, not spellings: Windows may hand back the long name
    // ("runneradmin") for a folder the temp dir spelled in 8.3 short form
    // ("RUNNER~1"), as happens on GitHub's Windows runners.
    const canonical = (p) => realpathSync.native(p).toLowerCase();
    assert.equal(canonical(target), canonical(path.join(appDataDir(), 'Stuff Transfer.cmd')));
    assert.match(icon, /stuff-transfer\.ico,0$/);
  });

  test('the launcher it points to really starts the app', { skip: !onWindows }, async () => {
    const launcher = path.join(appDataDir(), 'Stuff Transfer.cmd');
    const { stdout } = await run('cmd.exe', ['/d', '/c', launcher, '--version']);
    assert.equal(stdout.trim(), version);
  });

  test('a deleted shortcut is not forced back on every start', { skip: !onWindows }, async () => {
    const lnk = path.join(desktop, 'Stuff Transfer.lnk');
    await unlink(lnk);
    const again = await ensureDesktopShortcut({ cliPath });
    assert.equal(again.status, 'exists');
    assert.equal(existsSync(lnk), false, 'the student removed it on purpose');
  });

  test('--shortcut brings it back', { skip: !onWindows }, async () => {
    const result = await ensureDesktopShortcut({ cliPath, force: true });
    assert.equal(result.status, 'created');
    assert.ok(existsSync(path.join(desktop, 'Stuff Transfer.lnk')));
  });
});
