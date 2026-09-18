/**
 * Session lifecycle and security.
 *
 * The upload URL sits on the public internet, so the token in the QR is the
 * only thing between a stranger and this PC's disk. Four defences stack here:
 *
 *   1. the token rotates while nobody has scanned it, so a photographed QR
 *      or a shoulder-surfed URL goes stale within ~90 seconds
 *   2. the first phone to scan claims the session; later phones are refused,
 *      so a leaked link cannot be used alongside the real student
 *   3. the session closes itself when the phone goes quiet, when it gets old,
 *      or when nobody scans at all
 *   4. repeated wrong tokens kill the session outright, so the 128-bit token
 *      cannot be brute-forced by grinding requests
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ABSOLUTE_MAX_MS,
  HARD_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_FILES_PER_SESSION,
  MAX_SESSION_BYTES,
  TOKEN_GRACE_MS,
  TOKEN_TTL_MS,
  TRANSFER_IDLE_TIMEOUT_MS,
  UNCLAIMED_TIMEOUT_MS,
} from './config.js';
import { uniquePath } from './safety.js';
import { IncomingFile } from './receiver.js';
import { RateMeter } from './rate.js';

/** Why a session ended. Shown on the PC page so a student is never confused. */
export type CloseReason = 'done' | 'idle' | 'expired' | 'unscanned' | 'abuse' | 'replaced';

export const CLOSE_MESSAGES: Record<CloseReason, string> = {
  done: 'Session finished.',
  idle: 'Closed: the phone stopped responding.',
  expired: 'Closed: the session reached its time limit.',
  unscanned: 'Closed: nobody scanned the code.',
  abuse: 'Closed: someone tried to guess the code. Start a new session.',
  replaced: 'Replaced by a newer session.',
};

export type ClaimResult =
  | { ok: true; key: string; pin: string }
  | { ok: false; status: number; error: string };

export class Session {
  readonly id = randomBytes(8).toString('hex');
  /** Sent with every phone request after claiming. */
  readonly key = randomBytes(24).toString('base64url');
  /** Shown on both screens so the student can confirm the right PC. */
  readonly pin = String(randomInt(1000, 10000));
  readonly createdAt = Date.now();
  readonly dir: string;

  /** Current token, the one in the QR. 128 bits, URL-safe. */
  token = randomBytes(16).toString('base64url');
  tokenIssuedAt = Date.now();

  /** The token just replaced, honoured briefly so a mid-scan phone still works. */
  private previousToken: string | null = null;
  private previousTokenUntil = 0;

  claimed = false;
  claimedBy: string | null = null;
  lastSeenAt = Date.now();
  failedAttempts = 0;

  closed = false;
  closeReason: CloseReason | null = null;

  readonly files = new Map<string, IncomingFile>();

  /**
   * What the phone said it is about to send. The phone registers files one
   * at a time, so without this the PC could not show an honest total or
   * time remaining, and the 1 GB cap would only bite partway through.
   */
  plan: { files: number; bytes: number } | null = null;

  /** Speed of incoming data, for the PC's MB/s and time-left display. */
  readonly rate = new RateMeter();
  /** Last time file data actually arrived, as distinct from a heartbeat. */
  lastProgressAt = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  get tokenExpiresAt(): number {
    return this.tokenIssuedAt + TOKEN_TTL_MS;
  }

  get bytesReceived(): number {
    let total = 0;
    for (const f of this.files.values()) total += f.bytesReceived;
    return total;
  }

  /** Received plus in flight, for smooth progress bars. */
  get bytesProgress(): number {
    let total = 0;
    for (const f of this.files.values()) total += f.bytesProgress;
    return total;
  }

  /** Bytes committed to so far: registered files, not counting failed ones. */
  get bytesExpected(): number {
    let total = 0;
    for (const f of this.files.values()) if (f.status !== 'error') total += f.size;
    return total;
  }

  get filesDone(): number {
    let n = 0;
    for (const f of this.files.values()) if (f.status === 'done') n++;
    return n;
  }

  /**
   * True while the phone still has work to do: a file is part-sent, or it
   * announced more files than have finished.
   */
  get transferInProgress(): boolean {
    for (const f of this.files.values()) if (f.status === 'uploading') return true;
    return this.plan !== null && this.filesDone < this.plan.files;
  }

  /** Called as bytes arrive, even before a chunk is complete. */
  recordBytes(n: number): void {
    this.rate.record(n);
    this.lastProgressAt = Date.now();
  }

  assertCanAccept(size: number): void {
    if (this.files.size >= MAX_FILES_PER_SESSION) {
      throw new Error(`Too many files in one session (limit ${MAX_FILES_PER_SESSION})`);
    }
    if (this.bytesExpected + size > MAX_SESSION_BYTES) {
      throw new Error('That would take this session over the 1 GB limit');
    }
  }

  /**
   * Find an unfinished file the phone already started, so a reload resumes
   * it instead of starting a second copy from zero.
   */
  findResumable(fingerprint: string | undefined): IncomingFile | null {
    if (!fingerprint) return null;
    for (const f of this.files.values()) {
      if (f.status === 'uploading' && f.fingerprint === fingerprint) return f;
    }
    return null;
  }

  /**
   * Issue a new token. Only happens before a phone has claimed the session:
   * afterwards the link belongs to that phone and must keep working.
   */
  rotateToken(now = Date.now()): void {
    if (this.claimed || this.closed) return;
    this.previousToken = this.token;
    this.previousTokenUntil = now + TOKEN_GRACE_MS;
    this.token = randomBytes(16).toString('base64url');
    this.tokenIssuedAt = now;
  }

  /** Constant-time compare, so a token cannot be recovered by timing replies. */
  matchesToken(candidate: string, now = Date.now()): boolean {
    if (safeEqual(this.token, candidate)) return true;
    if (this.previousToken && now < this.previousTokenUntil) {
      return safeEqual(this.previousToken, candidate);
    }
    return false;
  }

  matchesKey(candidate: string | undefined): boolean {
    return typeof candidate === 'string' && safeEqual(this.key, candidate);
  }

  /**
   * Bind the session to one phone.
   *
   * The same device may claim repeatedly, because reloading the page or
   * losing signal mid-upload should not lock a student out of their own
   * transfer. A different device is refused even with a valid token.
   */
  claim(token: string, deviceId: string): ClaimResult {
    if (this.closed) return { ok: false, status: 403, error: 'This session has closed.' };

    if (!token || !this.matchesToken(token)) {
      this.registerFailure();
      return { ok: false, status: 403, error: 'This code has expired. Ask the PC for a new QR.' };
    }

    if (!deviceId) return { ok: false, status: 400, error: 'Missing device id' };

    if (this.claimed && this.claimedBy !== deviceId) {
      // Not a failed guess: the token was right. Someone else is already paired.
      return {
        ok: false,
        status: 409,
        error: 'Another phone is already using this code. Ask the PC for a new QR.',
      };
    }

    this.claimed = true;
    this.claimedBy = deviceId;
    this.touch();
    return { ok: true, key: this.key, pin: this.pin };
  }

  /** Record contact from the phone, which holds the idle timeout off. */
  touch(): void {
    this.lastSeenAt = Date.now();
  }

  /** Count a wrong token. Enough of them and the session dies. */
  registerFailure(): void {
    this.failedAttempts++;
  }

  get underAttack(): boolean {
    return this.failedAttempts >= MAX_FAILED_ATTEMPTS;
  }

  /**
   * Which timeout, if any, has been reached.
   *
   * The limits relax while a transfer is genuinely under way, because the
   * usual cause of silence mid-transfer is lost signal, not an abandoned
   * phone, and closing would throw away everything already sent.
   */
  dueToClose(now = Date.now()): CloseReason | null {
    if (this.underAttack) return 'abuse';

    const inProgress = this.transferInProgress;
    // "Flowing" needs real data recently, not just heartbeats, or a phone
    // could hold a session open for two hours by announcing a plan and idling.
    const flowing = inProgress && now - this.lastProgressAt < TRANSFER_IDLE_TIMEOUT_MS;

    const lifetime = flowing ? ABSOLUTE_MAX_MS : HARD_TIMEOUT_MS;
    if (now - this.createdAt > lifetime) return 'expired';

    if (!this.claimed && now - this.createdAt > UNCLAIMED_TIMEOUT_MS) return 'unscanned';

    const idleLimit = inProgress ? TRANSFER_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    if (this.claimed && now - this.lastSeenAt > idleLimit) return 'idle';

    return null;
  }

  async close(reason: CloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const f of this.files.values()) {
      if (f.status === 'uploading') await f.abort('Session closed before the upload finished');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// The single active session
// ---------------------------------------------------------------------------

let current: Session | null = null;
let lastClosed: { reason: CloseReason; at: number } | null = null;
let ticker: NodeJS.Timeout | null = null;

/**
 * Apply time-based rules: rotate the token, and close the session if a
 * timeout has been reached. Called both on a timer and on every request, so
 * the rules hold even if the PC page is closed.
 */
export function maintain(now = Date.now()): void {
  if (!current || current.closed) return;

  const reason = current.dueToClose(now);
  if (reason) {
    // Fire and forget: the state change above is synchronous, and nothing
    // here needs to wait for the leftover .part files to be removed.
    closeCurrent(reason).catch((e) => console.error('  Session cleanup failed:', e));
    return;
  }

  if (!current.claimed && now >= current.tokenExpiresAt) current.rotateToken(now);
}

export function getSession(): Session | null {
  maintain();
  return current && !current.closed ? current : null;
}

/** The raw session, timeouts not applied. For the PC page and for tests. */
export function peekSession(): Session | null {
  return current;
}

export function lastCloseReason(): CloseReason | null {
  return lastClosed?.reason ?? null;
}

export async function startSession(): Promise<Session> {
  if (current && !current.closed) await closeCurrent('replaced');
  lastClosed = null;

  current = new Session(await createSessionDir());

  if (!ticker) {
    ticker = setInterval(() => maintain(), 5000);
    ticker.unref(); // never hold the process open
  }
  return current;
}

export async function stopSession(reason: CloseReason = 'done'): Promise<void> {
  await closeCurrent(reason);
}

async function closeCurrent(reason: CloseReason): Promise<void> {
  const session = current;
  if (!session) return;

  // Flip the visible state synchronously. Only the disk cleanup is async, and
  // callers such as maintain() do not wait for it — so if this ran after the
  // await, the PC page could still be told the session is alive.
  current = null;
  lastClosed = { reason, at: Date.now() };
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }

  await session.close(reason);
}

/**
 * Where received files land: Desktop\Received\<date_time>\
 * Falls back sensibly when Desktop has been redirected to OneDrive, or is
 * missing entirely on a stripped-down lab account.
 */
async function createSessionDir(): Promise<string> {
  // Seconds included on purpose: two sessions in the same minute must not
  // share a folder, or a student's second batch mixes into their first.
  const stamp = new Date()
    .toLocaleString('sv-SE') // "2026-09-18 14:32:05", already sortable
    .replace(' ', '_')
    .replace(/:/g, '-');

  const dir = uniquePath(path.join(receivedRoot(), stamp));
  await mkdir(dir, { recursive: true });
  return dir;
}

export function receivedRoot(): string {
  // Explicit override wins, for tests and for anyone who wants a different folder.
  if (process.env.STUFF_TRANSFER_DIR) return path.resolve(process.env.STUFF_TRANSFER_DIR);

  const candidates = [
    path.join(homedir(), 'Desktop'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null,
    homedir(),
  ].filter((p): p is string => Boolean(p));

  const base = candidates.find((p) => existsSync(p)) ?? homedir();
  return path.join(base, 'Received');
}
