/**
 * Choosing where received files are saved.
 *
 * A web page cannot open a folder picker that reveals a real path on the PC,
 * so the page either sends a typed path, or asks this module to open the
 * native Windows folder dialog on its behalf.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';

/** A message fit to show the student as-is. */
export class SaveDirError extends Error {}

/**
 * Turn whatever the student typed into a folder we can really write to.
 * Creates the folder if it does not exist yet.
 */
export async function validateSaveDir(input: unknown): Promise<string> {
  // "Copy as path" in Explorer wraps the path in quotes; accept that.
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1').trim();

  if (!raw) throw new SaveDirError('Type or paste a folder path.');
  if (raw.length > 400) throw new SaveDirError('That path is too long.');
  if (!path.isAbsolute(raw) || (platform() === 'win32' && /^[\\/](?![\\/])/.test(raw))) {
    // "\Users\x" is "absolute" to Node but means "the current drive", which
    // is a guess. Insist on a drive letter or a network path.
    throw new SaveDirError('Use a full path that starts with a drive, like D:\\My Files');
  }

  const dir = path.resolve(raw);

  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new SaveDirError(explain(e, dir));
  }

  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new SaveDirError('That path is a file, not a folder.');

  // mkdir succeeding on an existing folder proves nothing about writing to
  // it (read-only drives, locked-down lab folders). Actually try.
  const probe = path.join(dir, `.stuff-transfer-check-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(probe, 'ok');
    await unlink(probe);
  } catch (e) {
    throw new SaveDirError(explain(e, dir));
  }

  return dir;
}

function explain(e: unknown, dir: string): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'This account is not allowed to save there. Pick a folder inside your own user folder, or on another drive.';
  }
  if (code === 'ENOENT') return `The drive ${path.parse(dir).root} does not exist on this PC.`;
  if (code === 'EROFS') return 'That drive is read-only.';
  if (code === 'ENOSPC') return 'That drive is full.';
  if (code === 'ENOTDIR') return 'Part of that path is a file, not a folder.';
  return `Can't save there (${code ?? 'unknown error'}).`;
}

/** Only Windows has the dialog wired up; elsewhere the page offers typing. */
export const canBrowse = platform() === 'win32';

/**
 * Open the standard Windows folder picker and return the chosen folder, or
 * null if the student cancelled. Needs no admin rights.
 */
export function browseForFolder(startIn: string): Promise<string | null> {
  if (!canBrowse) return Promise.resolve(null);

  // The starting folder travels in an environment variable, never spliced
  // into the script text, so no path can inject PowerShell code.
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Choose where received files are saved'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($env:ST_START_DIR -and (Test-Path -LiteralPath $env:ST_START_DIR)) { $dialog.SelectedPath = $env:ST_START_DIR }',
    // An invisible topmost owner window, so the dialog opens in front of the
    // browser instead of hiding behind it.
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ST_START_DIR: startIn }, windowsHide: true },
    );

    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));

    // A dialog left open forever would pin this request; give up eventually.
    const timer = setTimeout(() => child.kill(), 5 * 60_000);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new SaveDirError(`Could not open the folder picker (${e.message}). Type the path instead.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const chosen = out.trim();
      if (chosen) return resolve(chosen);
      if (code !== 0 && err.trim()) {
        // e.g. PowerShell locked down by lab policy: typing still works.
        return reject(new SaveDirError('The folder picker is blocked on this PC. Type the path instead.'));
      }
      resolve(null); // cancelled
    });
  });
}
