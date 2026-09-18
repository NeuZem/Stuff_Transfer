/**
 * A "Stuff Transfer" shortcut on the Desktop, so after the first run a
 * student can just double-click it instead of typing a command.
 *
 * Created on first run, not from an npm install script: install scripts are
 * the classic npm abuse vector, get flagged by security tooling and disabled
 * on many machines, and would also fire on developer and CI installs. With
 * `npx` the first run IS the install moment, so students see no difference.
 *
 * The shortcut points at a small launcher kept in the app's data folder and
 * rewritten on every start, so it always runs the most recently used copy of
 * the app, and falls back to `npx` if that copy has been cleaned away.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { makeIco } from './icon.js';

export type ShortcutStatus = 'created' | 'exists' | 'unsupported' | 'failed';

export interface ShortcutResult {
  status: ShortcutStatus;
  path?: string;
  message?: string;
}

const NAME = 'Stuff Transfer';

/** Per-user app folder. Overridable so tests never touch the real one. */
export function appDataDir(): string {
  if (process.env.STUFF_TRANSFER_DATA_DIR) return path.resolve(process.env.STUFF_TRANSFER_DATA_DIR);
  const base = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share');
  return path.join(base, 'stuff-transfer');
}

/**
 * The launcher script. Exported for tests.
 *
 * Paths are baked in at write time. `%` is doubled because cmd.exe would
 * otherwise read "%name%" inside a folder name as a variable.
 */
export function buildLauncher(opts: { cliPath: string; nodePath: string }): string {
  const esc = (s: string) => s.replace(/%/g, '%%');
  const npx = path.join(path.dirname(opts.nodePath), 'npx.cmd');

  return [
    '@echo off',
    'rem Stuff Transfer launcher. Rewritten each time the app starts.',
    'title Stuff Transfer - close this window to stop',
    `set "ST_NODE=${esc(opts.nodePath)}"`,
    `set "ST_APP=${esc(opts.cliPath)}"`,
    `set "ST_NPX=${esc(npx)}"`,
    'if exist "%ST_NODE%" if exist "%ST_APP%" (',
    '  "%ST_NODE%" "%ST_APP%" %*',
    '  goto :done',
    ')',
    'rem That copy is gone (for example, the npx cache was cleared): fetch it again.',
    'if exist "%ST_NPX%" ( call "%ST_NPX%" --yes stuff-transfer %* ) else ( call npx --yes stuff-transfer %* )',
    ':done',
    'rem Keep the window open if something went wrong, so the error can be read.',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'); // cmd.exe expects Windows line endings
}

/**
 * Make sure the launcher is current, and create the Desktop shortcut the
 * first time. Never throws: a missing shortcut must not stop the app.
 */
export async function ensureDesktopShortcut(opts: { cliPath: string; force?: boolean }): Promise<ShortcutResult> {
  if (platform() !== 'win32') return { status: 'unsupported' };

  try {
    const dir = appDataDir();
    await mkdir(dir, { recursive: true });

    const launcher = path.join(dir, `${NAME}.cmd`);
    const icon = path.join(dir, 'stuff-transfer.ico');
    await writeFile(launcher, buildLauncher({ cliPath: opts.cliPath, nodePath: process.execPath }));
    await writeFile(icon, makeIco());

    // Once only. A student who deletes the shortcut should not get it back
    // on every start; --shortcut brings it back on purpose.
    const marker = path.join(dir, 'shortcut-created.json');
    if (existsSync(marker) && !opts.force) return { status: 'exists' };

    let created: string;
    try {
      created = await createLnk(launcher, icon);
    } catch {
      // PowerShell may be locked down on lab PCs. A plain .cmd on the
      // Desktop still works when double-clicked, just without the icon.
      created = path.join(desktopDir(), `${NAME}.cmd`);
      await copyFile(launcher, created);
    }

    await writeFile(marker, JSON.stringify({ createdAt: new Date().toISOString(), path: created }, null, 2));
    return { status: 'created', path: created };
  } catch (e) {
    return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Best guess at the Desktop when we cannot ask Windows (the .lnk path asks). */
function desktopDir(): string {
  if (process.env.ST_DESKTOP_DIR) return process.env.ST_DESKTOP_DIR;
  const candidates = [
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null,
    path.join(homedir(), 'Desktop'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? homedir();
}

/**
 * Create a real Windows shortcut (.lnk) with our icon. Resolves to its path.
 *
 * Asks Windows for the Desktop folder rather than guessing it, because
 * Desktop is often redirected into OneDrive. Every value reaches PowerShell
 * through environment variables, never spliced into the script, so no path
 * can inject commands.
 */
function createLnk(launcher: string, icon: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$desk = if ($env:ST_DESKTOP_DIR) { $env:ST_DESKTOP_DIR } else { [Environment]::GetFolderPath('Desktop') }",
    `$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk '${NAME}.lnk'))`,
    '$lnk.TargetPath = $env:ST_LAUNCHER',
    '$lnk.WorkingDirectory = $env:USERPROFILE',
    "$lnk.IconLocation = $env:ST_ICON + ',0'",
    "$lnk.Description = 'Receive files from your phone'",
    // Minimised: the student sees the browser page, not a console. The
    // console stays in the taskbar, titled "close this window to stop".
    '$lnk.WindowStyle = 7',
    '$lnk.Save()',
    '[Console]::Out.Write($lnk.FullName)',
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ST_LAUNCHER: launcher, ST_ICON: icon }, windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const created = out.trim();
      if (code === 0 && created && existsSync(created)) resolve(created);
      else reject(new Error(`PowerShell could not create the shortcut (exit ${code})`));
    });
  });
}
