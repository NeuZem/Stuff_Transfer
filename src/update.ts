/**
 * Run the newest published version.
 *
 * A published npm version can never change, and the Desktop shortcut runs
 * the copy already on the PC. Without this, a student who first ran 0.1.0
 * would stay on 0.1.0 forever and never get a fix.
 *
 * Safety first: the new version is downloaded and proven to start BEFORE we
 * hand over to it. Any failure (offline, npm down, a broken download) just
 * means carrying on with the version already here.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PACKAGE = 'stuff-transfer';

/** True if version `a` is newer than `b` (plain x.y.z; pre-releases ignored). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Only an installed copy (npx cache or npm install) should update itself.
 * A source checkout is a developer's working copy: leave it alone.
 */
export function isInstalledCopy(file: string): boolean {
  return file.split(/[\\/]/).includes('node_modules');
}

/** npm's own npx script, run with this Node. No shell, so no quoting risk. */
function npxScript(): string | null {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Windows layout
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), // macOS / Linux
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function runNpx(script: string, args: string[], inherit: boolean): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--yes', ...args], {
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'],
      // Stops the newer copy from checking for updates all over again.
      env: { ...process.env, ST_UPDATED: '1' },
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve({ code: 1, out }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

/**
 * If npm has a newer version, run it and return its exit code. Returns null
 * when this copy should just carry on.
 */
export async function runNewerIfAvailable(opts: {
  current: string;
  selfPath: string;
  argv: string[];
}): Promise<number | null> {
  if (process.env.ST_UPDATED || process.env.ST_NO_UPDATE) return null;
  if (!isInstalledCopy(opts.selfPath)) return null;

  let latest: string;
  try {
    const url = process.env.ST_UPDATE_URL ?? `https://registry.npmjs.org/${PACKAGE}/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null; // not published yet, or npm unavailable
    latest = ((await res.json()) as { version?: string }).version ?? '';
  } catch {
    return null; // offline or slow: never hold up the app for an update
  }
  if (!latest || !isNewer(latest, opts.current)) return null;

  const script = npxScript();
  if (!script) return null;

  const spec = `${PACKAGE}@${latest}`;
  console.log(`\n  Updating Stuff Transfer ${opts.current} -> ${latest}...`);

  // Download it and prove it starts, before switching over.
  const probe = await runNpx(script, [spec, '--version'], false);
  if (probe.code !== 0 || probe.out.trim() !== latest) {
    console.log(`  Update failed, carrying on with ${opts.current}.\n`);
    return null;
  }

  const run = await runNpx(script, [spec, ...opts.argv], true);
  return run.code;
}
