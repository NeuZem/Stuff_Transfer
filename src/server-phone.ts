/**
 * The PUBLIC server. This is the only thing the tunnel exposes.
 *
 * Deliberately has no route that reads from the PC. Every route here either
 * writes an uploaded file or reports progress of an upload in flight. Keeping
 * the PC's own controls on a separate server (server-pc.ts) means "the phone
 * cannot pull files off this machine" is true by construction, not by a check
 * that someone might forget to add.
 */

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CHUNK_SIZE,
  DISK_HEADROOM_BYTES,
  HEARTBEAT_MS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  MAX_SESSION_BYTES,
} from './config.js';
import { DiskFullError, IncomingFile } from './receiver.js';
import { getSession, maintain } from './session.js';
import { freeSpace } from './safety.js';

const phoneHtml = await readFile(fileURLToPath(new URL('./ui/phone.html', import.meta.url)), 'utf8');

export function createPhoneApp(): Hono {
  const app = new Hono();

  /** Tunnel health probe. Reveals nothing about the session. */
  app.get('/health', (c) => c.text('ok'));

  /** The page the QR opens. The token travels in the path. */
  app.get('/t/:token', (c) => {
    const session = getSession();
    const token = c.req.param('token');

    if (!session || !session.matchesToken(token)) {
      // A wrong token here counts too: serving the page is the first step of
      // any guessing attempt, so it must not be a free probe.
      session?.registerFailure();
      maintain();
      return c.html(expiredPage(), 404);
    }

    const page = phoneHtml
      .replaceAll('__TOKEN__', encodeURIComponent(token))
      .replaceAll('__CHUNK_SIZE__', String(CHUNK_SIZE))
      .replaceAll('__MAX_SESSION__', String(MAX_SESSION_BYTES))
      .replaceAll('__MAX_FILE__', String(MAX_FILE_BYTES))
      .replaceAll('__HEARTBEAT_MS__', String(HEARTBEAT_MS));

    return c.html(page);
  });

  /**
   * Exchange the QR token for a session key.
   *
   * This is where a session becomes bound to one phone. The device id lets
   * the same phone re-claim after a reload or a dropped signal, while a
   * second phone is refused even though its token is valid.
   */
  app.post('/api/claim', async (c) => {
    const session = getSession();
    const body = await c.req
      .json<{ token?: string; deviceId?: string }>()
      .catch(() => ({}) as { token?: string; deviceId?: string });

    if (!session) {
      return c.json({ error: 'This code has expired. Ask the PC for a new QR.' }, 403);
    }

    const result = session.claim(body.token ?? '', body.deviceId ?? '');
    maintain(); // a burst of wrong tokens ends the session immediately

    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 409);

    return c.json({
      sessionKey: result.key,
      pin: result.pin,
      // The phone may have claimed with a token that was already in its grace
      // period. Hand back the canonical one so a later reload still works.
      token: session.token,
      chunkSize: CHUNK_SIZE,
      maxFileBytes: MAX_FILE_BYTES,
      maxSessionBytes: MAX_SESSION_BYTES,
      usedBytes: session.bytesExpected,
      heartbeatMs: HEARTBEAT_MS,
    });
  });

  // Everything below needs the session key.
  app.use('/api/file/*', async (c, next) => {
    const session = getSession();
    if (!session) return c.json({ error: 'Session closed' }, 403);
    if (!session.matchesKey(c.req.header('x-session-key'))) return c.json({ error: 'Not authorised' }, 403);
    session.touch(); // upload traffic counts as the phone being alive
    await next();
  });

  /**
   * "Still here." Sent while the student is choosing files, so picking a
   * folder for two minutes does not look like an abandoned session.
   *
   * Also serves as resume: a phone holding a valid key uses this instead of
   * claiming again, which keeps reloads working after the token has rotated.
   */
  app.post('/api/heartbeat', (c) => {
    const session = getSession();
    if (!session || !session.matchesKey(c.req.header('x-session-key'))) {
      return c.json({ error: 'Session closed' }, 403);
    }
    session.touch();
    return c.json({ ok: true, pin: session.pin, usedBytes: session.bytesExpected });
  });

  /**
   * Announce the whole batch before sending anything.
   *
   * Lets the PC show an honest total and time left, and lets us refuse an
   * over-limit or disk-filling batch before the student spends any data on it.
   */
  app.post('/api/plan', async (c) => {
    const session = getSession();
    if (!session || !session.matchesKey(c.req.header('x-session-key'))) {
      return c.json({ error: 'Session closed' }, 403);
    }
    session.touch();

    const body = await c.req
      .json<{ files?: number; bytes?: number }>()
      .catch(() => ({}) as Record<string, never>);
    const files = Number(body.files);
    const bytes = Number(body.bytes);
    if (!Number.isInteger(files) || files < 1 || !Number.isFinite(bytes) || bytes < 0) {
      return c.json({ error: 'Invalid plan' }, 400);
    }

    // Files already finished this session still count toward its limits.
    const doneBytes = [...session.files.values()]
      .filter((f) => f.status === 'done')
      .reduce((n, f) => n + f.size, 0);

    if (doneBytes + bytes > MAX_SESSION_BYTES) {
      return c.json({ error: 'That is more than the 1 GB limit for one session.' }, 413);
    }
    if (session.filesDone + files > MAX_FILES_PER_SESSION) {
      return c.json({ error: `Too many files (limit ${MAX_FILES_PER_SESSION} per session).` }, 413);
    }

    const free = await freeSpace(session.dir);
    if (free !== null && free - bytes < DISK_HEADROOM_BYTES) {
      return c.json({ error: 'Not enough free space on the PC for these files.' }, 507);
    }

    session.plan = { files: session.filesDone + files, bytes: doneBytes + bytes };
    return c.json({ ok: true });
  });

  /**
   * Register a file and find out which chunks (if any) already arrived.
   *
   * If the phone sends a fingerprint matching a file it already started,
   * that file is resumed rather than duplicated. This is what lets a student
   * reload the page, re-pick the same file, and carry on.
   */
  app.post('/api/file/init', async (c) => {
    const session = getSession()!;
    const body = await c.req
      .json<{ name?: string; relPath?: string; size?: number; fingerprint?: string }>()
      .catch(() => ({}) as Record<string, never>);

    const size = Number(body.size);
    if (!body.name || !Number.isFinite(size) || size < 0) {
      return c.json({ error: 'Missing file name or size' }, 400);
    }

    const existing = session.findResumable(body.fingerprint);
    if (existing && existing.size === size) {
      return c.json({
        fileId: existing.id,
        chunkSize: CHUNK_SIZE,
        totalChunks: existing.totalChunks,
        received: existing.receivedChunks,
        resumed: true,
      });
    }

    try {
      session.assertCanAccept(size);
    } catch (e) {
      return c.json({ error: message(e) }, 413);
    }

    const free = await freeSpace(session.dir);
    if (free !== null && free - size < DISK_HEADROOM_BYTES) {
      return c.json({ error: 'Not enough free space on the PC' }, 507);
    }

    try {
      const id = randomBytes(12).toString('hex');
      const file = await IncomingFile.create({
        id,
        sessionDir: session.dir,
        name: body.name,
        relPath: body.relPath,
        size,
        fingerprint: body.fingerprint,
      });
      session.files.set(id, file);

      return c.json({
        fileId: id,
        chunkSize: CHUNK_SIZE,
        totalChunks: file.totalChunks,
        received: file.receivedChunks,
        resumed: false,
      });
    } catch (e) {
      return c.json({ error: message(e) }, 400);
    }
  });

  /** Resume support: which chunks does the PC already have? */
  app.get('/api/file/:id', (c) => {
    const file = getSession()!.files.get(c.req.param('id'));
    if (!file) return c.json({ error: 'Unknown file' }, 404);
    return c.json({
      received: file.receivedChunks,
      totalChunks: file.totalChunks,
      status: file.status,
    });
  });

  /** One chunk of one file, as raw bytes. */
  app.put('/api/file/:id/chunk/:index', async (c) => {
    const session = getSession()!;
    const file = session.files.get(c.req.param('id'));
    if (!file) return c.json({ error: 'Unknown file' }, 404);

    let expected: number;
    try {
      expected = file.expectedChunkSize(Number(c.req.param('index')));
    } catch (e) {
      return c.json({ error: message(e) }, 400);
    }
    const index = Number(c.req.param('index'));

    // Count bytes as they arrive, for smooth progress and live speed. Undo our
    // share if this request dies, so an aborted chunk is not shown as sent.
    let counted = 0;
    const onBytes = (n: number) => {
      counted += n;
      file.inflightBytes += n;
      session.recordBytes(n);
    };

    try {
      const data = await readBodyCapped(c.req.raw, expected, onBytes);
      await file.writeChunk(index, data, c.req.header('x-chunk-sha256'));
      return c.json({ ok: true, received: file.receivedChunks.length, totalChunks: file.totalChunks });
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        // Hang up rather than keep draining whatever the client is still
        // pushing: an oversize body is either a bug or an attack.
        c.header('Connection', 'close');
        return c.json({ error: e.message }, 413);
      }
      if (e instanceof DiskFullError) return c.json({ error: e.message }, 507);
      return c.json({ error: message(e) }, 400);
    } finally {
      file.inflightBytes = Math.max(0, file.inflightBytes - counted);
    }
  });

  /**
   * Verify and publish the finished file under its real name.
   * Safe to repeat: a phone that lost the reply will simply ask again.
   */
  app.post('/api/file/:id/complete', async (c) => {
    const file = getSession()!.files.get(c.req.param('id'));
    if (!file) return c.json({ error: 'Unknown file' }, 404);

    try {
      const { sha256 } = await file.finish();
      return c.json({ ok: true, name: file.displayName, sha256 });
    } catch (e) {
      return c.json({ error: message(e), received: file.receivedChunks }, 409);
    }
  });

  return app;
}

class BodyTooLargeError extends Error {}

/**
 * Read a request body, refusing anything over `limit` bytes as it streams in.
 *
 * Checking the Content-Length header is not enough: a client can omit it and
 * use chunked encoding, and reading that with arrayBuffer() buffers an
 * unbounded body into memory. Anyone with the URL could exhaust the PC's RAM.
 */
async function readBodyCapped(
  req: Request,
  limit: number,
  onBytes: (n: number) => void,
): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyTooLargeError(`Chunk too large: ${declared} bytes, expected ${limit}`);
  }

  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const parts: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(`Chunk too large: more than ${limit} bytes`);
    }
    parts.push(value);
    onBytes(value.byteLength);
  }

  return Buffer.concat(parts, total);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const expiredPage = () => `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100svh;margin:0;
       background:#0b1020;color:#e8ecff;text-align:center;padding:1.5rem}
  h1{font-size:1.4rem;margin:.5rem 0}p{opacity:.75;line-height:1.6;max-width:22rem}
</style>
<div>
  <div style="font-size:3.5rem">&#8987;</div>
  <h1>This link has expired</h1>
  <p>Go back to the PC, click <b>Receive files</b> again, and scan the new QR code.</p>
</div>`;
