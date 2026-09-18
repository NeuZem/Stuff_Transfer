/**
 * The PC's own server. Bound to 127.0.0.1 and never tunnelled, so Windows
 * Firewall stays quiet and nothing outside this machine can reach it.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { ExtractError, extractZip } from './extract.js';
import { MAX_SESSION_BYTES } from './config.js';
import {
  CLOSE_MESSAGES,
  defaultRoot,
  getSession,
  isCustomRoot,
  lastCloseReason,
  receivedRoot,
  setCustomRoot,
  startSession,
  stopSession,
} from './session.js';
import { SaveDirError, browseForFolder, canBrowse, validateSaveDir } from './save-dir.js';
import { appState } from './state.js';

const pcHtml = await readFile(fileURLToPath(new URL('./ui/pc.html', import.meta.url)), 'utf8');

/** Cached so we don't re-render the same QR on every status poll. */
let qrCache: { url: string; dataUrl: string } | null = null;

/**
 * Only this app's own page may talk to this server.
 *
 * Binding to 127.0.0.1 keeps other computers out, but not other websites: a
 * page open in this PC's browser can still send requests to 127.0.0.1. It
 * cannot read the replies (the browser blocks that), but a plain POST still
 * runs, which would let any website start sessions or quietly change where
 * received files are saved. Two checks close that:
 *
 *   - Host must be 127.0.0.1 or localhost. Stops "DNS rebinding", where an
 *     attacker's domain is re-pointed at 127.0.0.1 to become same-origin.
 *   - Anything that changes state must come from this exact origin. Browsers
 *     always send Origin (and Sec-Fetch-Site) on a cross-site POST.
 *
 * Requests without these headers (curl, our tests) come from a program
 * already running on this PC, which could do anything anyway.
 */
function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      return c.text('Forbidden', 403);
    }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }
    await next();
  };
}

/** Only one Windows folder dialog open at a time. */
let browsing = false;

export function createPcApp(): Hono {
  const app = new Hono();

  app.use('*', localOnly());

  app.get('/', (c) => c.html(pcHtml));

  app.get('/api/status', async (c) => c.json(await buildStatus()));

  app.post('/api/start', async (c) => {
    if (appState.tunnelStatus !== 'ready') {
      return c.json({ error: 'The secure link is not ready yet. Wait a few seconds.' }, 503);
    }
    await startSession();
    return c.json(await buildStatus());
  });

  /** Retry a failed tunnel from the page, so nobody has to restart the app. */
  app.post('/api/retry-tunnel', async (c) => {
    if (appState.tunnelStatus === 'error' && appState.retryTunnel) appState.retryTunnel();
    return c.json(await buildStatus());
  });

  app.post('/api/stop', async (c) => {
    await stopSession('done');
    qrCache = null;
    return c.json(await buildStatus());
  });

  /**
   * Unpack a received .zip next to it. Lives on the PC's private server:
   * only the person at the PC can trigger it, never the phone.
   */
  app.post('/api/extract', async (c) => {
    const session = getSession();
    const { fileId } = await c.req.json<{ fileId?: string }>().catch(() => ({ fileId: undefined }));
    const file = fileId ? session?.files.get(fileId) : undefined;

    if (!session || !file || !file.finalPath) return c.json({ error: 'File not found' }, 404);
    if (!/\.zip$/i.test(file.finalPath)) return c.json({ error: 'Only .zip files can be unpacked' }, 400);
    if (file.extractedTo) return c.json({ ok: true, folder: file.extractedTo });
    if (file.extracting) return c.json({ error: 'Already unpacking' }, 409);

    file.extracting = true;
    try {
      const result = await extractZip(file.finalPath, path.dirname(file.finalPath));
      file.extractedTo = result.folder;
      return c.json({ ok: true, ...result });
    } catch (e) {
      const message = e instanceof ExtractError ? e.message : 'Could not unpack this zip.';
      return c.json({ error: message }, 400);
    } finally {
      file.extracting = false;
    }
  });

  // --- where received files are saved ------------------------------------

  /** Changing folders mid-session would split one batch across two places. */
  const lockedBySession = () =>
    getSession() ? 'Click Done to finish this session before changing the folder.' : null;

  /** Use a typed or pasted folder path. */
  app.post('/api/save-dir', async (c) => {
    const locked = lockedBySession();
    if (locked) return c.json({ error: locked }, 409);

    const { path: wanted } = await c.req.json<{ path?: string }>().catch(() => ({ path: undefined }));
    try {
      applySaveDir(await validateSaveDir(wanted));
      return c.json(await buildStatus());
    } catch (e) {
      const message = e instanceof SaveDirError ? e.message : 'Could not use that folder.';
      return c.json({ error: message }, 400);
    }
  });

  /** Pick a folder with the standard Windows dialog, then use it. */
  app.post('/api/save-dir/browse', async (c) => {
    const locked = lockedBySession();
    if (locked) return c.json({ error: locked }, 409);
    if (!canBrowse) return c.json({ error: 'Type the folder path instead.' }, 501);
    if (browsing) return c.json({ error: 'The folder picker is already open.' }, 409);

    browsing = true;
    try {
      const chosen = await browseForFolder(receivedRoot());
      if (!chosen) return c.json({ cancelled: true, ...(await buildStatus()) });
      applySaveDir(await validateSaveDir(chosen));
      return c.json(await buildStatus());
    } catch (e) {
      const message = e instanceof SaveDirError ? e.message : 'Could not use that folder.';
      return c.json({ error: message }, 400);
    } finally {
      browsing = false;
    }
  });

  /** Go back to --dir, or Desktop\Received. */
  app.post('/api/save-dir/default', async (c) => {
    const locked = lockedBySession();
    if (locked) return c.json({ error: locked }, 409);
    setCustomRoot(null);
    return c.json(await buildStatus());
  });

  /** Open the received-files folder in the system file manager. */
  app.post('/api/open-folder', (c) => {
    const dir = getSession()?.dir ?? receivedRoot();
    const p = platform();
    if (p === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    else if (p === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    return c.json({ ok: true, dir });
  });

  return app;
}

/** Choosing the default folder by hand just means "use the default". */
function applySaveDir(dir: string): void {
  const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  setCustomRoot(same(dir, defaultRoot()) ? null : dir);
}

async function buildStatus() {
  const session = getSession();

  const closeReason = lastCloseReason();
  const base = {
    // Lets a second launch recognise this as a running Stuff Transfer.
    app: 'stuff-transfer',
    pcName: appState.pcName,
    shortcutCreated: appState.shortcutCreated,
    tunnel: appState.tunnelStatus,
    tunnelError: appState.tunnelError,
    maxSessionBytes: MAX_SESSION_BYTES,
    receivedRoot: receivedRoot(),
    saveDir: {
      path: receivedRoot(),
      isCustom: isCustomRoot(),
      defaultPath: defaultRoot(),
      canBrowse,
      locked: session !== null,
    },
    // Why the previous session ended, so the page can explain itself.
    closeReason,
    closeMessage: closeReason ? CLOSE_MESSAGES[closeReason] : null,
  };

  if (!session) return { ...base, session: null };

  const phoneUrl = `${appState.tunnelUrl}/t/${session.token}`;
  if (qrCache?.url !== phoneUrl) {
    qrCache = {
      url: phoneUrl,
      dataUrl: await QRCode.toDataURL(phoneUrl, { width: 512, margin: 1 }),
    };
  }

  return {
    ...base,
    session: {
      pin: session.pin,
      url: phoneUrl,
      qr: qrCache.dataUrl,
      claimed: session.claimed,
      // Drives the "new code in Ns" countdown; null once a phone is paired,
      // because the link then belongs to that phone and stops rotating.
      tokenExpiresAt: session.claimed ? null : session.tokenExpiresAt,
      dir: session.dir,
      bytesReceived: session.bytesReceived,
      bytesExpected: session.bytesExpected,
      transfer: transferSummary(session),
      files: [...session.files.values()].map((f) => ({
        id: f.id,
        name: f.displayName,
        size: f.size,
        received: f.bytesProgress,
        status: f.status,
        error: f.error,
        canExtract: f.status === 'done' && /\.zip$/i.test(f.displayName) && !f.extractedTo,
        extracting: f.extracting,
        extractedTo: f.extractedTo ? path.basename(f.extractedTo) : null,
      })),
    },
  };
}

/** How long without incoming data before we tell the student it has stalled. */
const STALL_MS = 6000;

/**
 * Totals, speed and time left for the whole batch.
 *
 * Uses the phone's announced plan when there is one, so the total is right
 * from the start instead of growing as each file is registered.
 */
function transferSummary(session: NonNullable<ReturnType<typeof getSession>>) {
  const bytesDone = session.bytesProgress;
  const totalBytes = Math.max(session.plan?.bytes ?? 0, session.bytesExpected);
  const totalFiles = Math.max(session.plan?.files ?? 0, session.files.size);
  const bytesPerSec = session.rate.bytesPerSecond();
  const active = session.transferInProgress;

  const remaining = Math.max(0, totalBytes - bytesDone);
  const etaSeconds = active && bytesPerSec > 0 ? Math.ceil(remaining / bytesPerSec) : null;

  return {
    active,
    filesDone: session.filesDone,
    totalFiles,
    bytesDone,
    totalBytes,
    bytesPerSec: Math.round(bytesPerSec),
    etaSeconds,
    // Mid-transfer silence almost always means the phone lost signal.
    stalled: active && session.lastProgressAt > 0 && Date.now() - session.lastProgressAt > STALL_MS,
  };
}
