#!/usr/bin/env node
/**
 * Entry point.
 *
 * Starts two servers and one tunnel:
 *   - phone server on a random local port  ->  exposed through the tunnel
 *   - PC server on 7777                    ->  127.0.0.1 only, opens in the browser
 *
 * The tunnel starts once at boot and lives for the whole process, so clicking
 * "Receive files" shows a QR instantly instead of waiting for Cloudflare.
 */

import { serve, type ServerType } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDesktopShortcut } from './shortcut.js';
import { createPcApp } from './server-pc.js';
import { createPhoneApp } from './server-phone.js';
import { startTunnel, type Tunnel } from './tunnel.js';
import { stopSession } from './session.js';
import { appState } from './state.js';
import { PC_PORT } from './config.js';

const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HELP = `
  Stuff Transfer ${VERSION}
  Send files from your phone to this PC by scanning a QR code.
  Phone to PC only. No accounts, nothing left logged in.

  Usage
    npx stuff-transfer [options]

  Options
    --dir <folder>   Default save folder (normally Desktop\\Received).
                     Students can still change it for one run on the PC page.
    --no-open        Do not open the browser automatically
    --shortcut       Put the Desktop shortcut back (it is made once, on first run)
    --no-shortcut    Do not create a Desktop shortcut
    --new-instance   Start a new copy even if one is already running
    -v, --version    Show the version
    -h, --help       Show this help

  Received files land in a new folder per session, named by date and time.
  Press Ctrl+C to stop.
`;

interface Options {
  dir?: string;
  open: boolean;
  shortcut: 'auto' | 'force' | 'off';
  newInstance: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    open: !process.env.STUFF_TRANSFER_NO_OPEN,
    shortcut: 'auto',
    newInstance: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '-v' || arg === '--version') {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === '--no-open') {
      opts.open = false;
    } else if (arg === '--shortcut') {
      opts.shortcut = 'force';
    } else if (arg === '--no-shortcut') {
      opts.shortcut = 'off';
    } else if (arg === '--new-instance') {
      opts.newInstance = true;
    } else if (arg === '--dir' || arg.startsWith('--dir=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value) fail('--dir needs a folder, for example:  --dir D:\\MyFiles');
      opts.dir = path.resolve(value);
    } else {
      fail(`Unknown option: ${arg}\n  Run with --help to see the options.`);
    }
  }
  return opts;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function listen(app: ReturnType<typeof createPcApp>, port: number): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) =>
      resolve({ server, port: info.port }),
    );
    server.on('error', reject);
  });
}

/** Try the preferred port, then walk forward if something else has it. */
async function listenWithFallback(app: ReturnType<typeof createPcApp>, preferred: number) {
  for (let port = preferred; port < preferred + 20; port++) {
    try {
      return await listen(app, port);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`No free port between ${preferred} and ${preferred + 20}`);
}

function openBrowser(url: string): void {
  const p = process.platform;
  const cmd = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open';
  const args = p === 'win32' ? ['/c', 'start', '""', url] : [url];
  import('node:child_process').then(({ spawn }) =>
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(),
  );
}

/**
 * Is Stuff Transfer already running on this PC? Returns its page address.
 *
 * Double-clicking the Desktop shortcut a second time should bring back the
 * page that is already open, not start a second copy with its own tunnel and
 * another 40-second wait.
 */
async function findRunningCopy(): Promise<string | null> {
  for (let port = PC_PORT; port < PC_PORT + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(800) });
      const body = (await res.json()) as { app?: string };
      if (body.app === 'stuff-transfer') return `http://127.0.0.1:${port}`;
    } catch {
      /* nothing there, or not us */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dir) process.env.STUFF_TRANSFER_DIR = opts.dir;

  if (!opts.newInstance) {
    const running = await findRunningCopy();
    if (running) {
      console.log(`\n  Stuff Transfer is already running: ${running}`);
      if (opts.open) {
        console.log('  Opening it in the browser.\n');
        openBrowser(running);
      }
      return;
    }
  }

  console.log(`\n  Stuff Transfer ${VERSION}\n`);

  const phone = await listen(createPhoneApp(), 0);
  const pc = await listenWithFallback(createPcApp(), PC_PORT);

  const pcUrl = `http://127.0.0.1:${pc.port}`;
  console.log(`  PC page:  ${pcUrl}`);
  if (opts.dir) console.log(`  Saving to: ${opts.dir}`);
  if (process.env.STUFF_TRANSFER_DEBUG) console.log(`  [debug] phone server: http://127.0.0.1:${phone.port}`);

  // Open the page straight away. It shows its own "preparing" screen, which
  // beats a student staring at a terminal for a minute wondering if it works.
  if (opts.open) openBrowser(pcUrl);

  // In the background: a slow or failing shortcut must never delay the app.
  if (opts.shortcut !== 'off') {
    void ensureDesktopShortcut({
      cliPath: fileURLToPath(import.meta.url),
      force: opts.shortcut === 'force',
    }).then((result) => {
      if (result.status === 'created') {
        appState.shortcutCreated = true;
        console.log(`  Added a "Stuff Transfer" shortcut to the Desktop. Next time, just double-click it.`);
      } else if (result.status === 'failed') {
        console.log(`  (Could not add a Desktop shortcut: ${result.message})`);
      }
    });
  }

  let tunnel: Tunnel | null = null;

  /** Bring the tunnel up. Also wired to the "Try again" button on the PC page. */
  const bringUpTunnel = async () => {
    appState.tunnelStatus = 'starting';
    appState.tunnelError = null;
    console.log('  Preparing the secure link (about 40 seconds)...');
    try {
      tunnel?.stop();
      tunnel = await startTunnel(phone.port);
      appState.tunnelUrl = tunnel.url;
      appState.tunnelStatus = 'ready';
      console.log('  Ready. Click "Receive files" on the PC page.\n');
    } catch (e) {
      appState.tunnelStatus = 'error';
      appState.tunnelError = e instanceof Error ? e.message : String(e);
      console.error(`  Could not open the secure link: ${appState.tunnelError}\n`);
    }
  };
  appState.retryTunnel = () => void bringUpTunnel();

  const shutdown = async () => {
    console.log('\n  Closing...');
    await stopSession();
    tunnel?.stop();
    phone.server.close();
    pc.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bringUpTunnel();
}

main().catch((e) => {
  console.error(`\n  Failed to start: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
