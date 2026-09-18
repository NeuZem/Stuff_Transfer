/**
 * Writing incoming files to disk.
 *
 * Chunks arrive out of order and in parallel, so each file is written as a
 * sparse `.part` file with every chunk placed at its own offset. The final
 * rename only happens once every chunk is present and verified, which means a
 * half-finished transfer can never look like a complete file.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, unlink, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_SIZE, MAX_FILE_BYTES } from './config.js';
import { safeFileName, safeJoin, uniquePath } from './safety.js';

export type FileStatus = 'uploading' | 'done' | 'error';

/** The PC's disk filled up mid-transfer. Reported to the phone as HTTP 507. */
export class DiskFullError extends Error {
  constructor() {
    super('The PC ran out of disk space');
  }
}

export class IncomingFile {
  readonly id: string;
  readonly displayName: string;
  readonly size: number;
  readonly totalChunks: number;
  /**
   * Identifies the same file across a page reload: path, size and
   * modification time. Lets a student re-pick a file and carry on from where
   * the upload stopped, instead of starting again.
   */
  readonly fingerprint: string | null;
  readonly startedAt = Date.now();

  status: FileStatus = 'uploading';
  error: string | null = null;
  finalPath: string | null = null;
  sha256: string | null = null;
  /** Where a received .zip was unpacked, once the student asks for it. */
  extractedTo: string | null = null;
  extracting = false;

  /** Bytes of chunks still arriving. Makes progress smooth, not 4 MB steps. */
  inflightBytes = 0;

  /** Indices of chunks fully written. Drives both progress and resume. */
  private readonly received = new Set<number>();
  private handle: FileHandle | null = null;
  private readonly partPath: string;
  private readonly targetPath: string;

  private constructor(opts: {
    id: string;
    displayName: string;
    size: number;
    targetPath: string;
    fingerprint: string | null;
  }) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.size = opts.size;
    this.targetPath = opts.targetPath;
    this.fingerprint = opts.fingerprint;
    this.partPath = `${opts.targetPath}.part`;
    this.totalChunks = Math.max(1, Math.ceil(opts.size / CHUNK_SIZE));
  }

  static async create(opts: {
    id: string;
    sessionDir: string;
    name: string;
    relPath?: string;
    size: number;
    fingerprint?: string;
  }): Promise<IncomingFile> {
    if (!Number.isFinite(opts.size) || opts.size < 0) throw new Error('Invalid file size');
    if (opts.size > MAX_FILE_BYTES) throw new Error('File is larger than the 1 GB limit');

    // A folder upload sends a relative path; a plain file upload sends only a name.
    const desired = opts.relPath
      ? safeJoin(opts.sessionDir, opts.relPath)
      : path.join(opts.sessionDir, safeFileName(opts.name));

    await mkdir(path.dirname(desired), { recursive: true });

    const target = uniquePath(desired);
    const file = new IncomingFile({
      id: opts.id,
      displayName: path.basename(target),
      size: opts.size,
      targetPath: target,
      // Bounded, so a hostile client cannot make us hold a huge string.
      fingerprint: opts.fingerprint ? String(opts.fingerprint).slice(0, 600) : null,
    });
    file.handle = await open(file.partPath, 'w+');
    return file;
  }

  /** Bytes in chunks that are fully written and verified. */
  get bytesReceived(): number {
    if (this.received.size === 0) return 0;
    const hasLast = this.received.has(this.totalChunks - 1);
    const lastSize = this.size - (this.totalChunks - 1) * CHUNK_SIZE;
    const fullChunks = this.received.size - (hasLast ? 1 : 0);
    return fullChunks * CHUNK_SIZE + (hasLast ? lastSize : 0);
  }

  /** Written plus still arriving, for progress bars. Never exceeds the size. */
  get bytesProgress(): number {
    if (this.status === 'done') return this.size;
    return Math.min(this.size, this.bytesReceived + this.inflightBytes);
  }

  get receivedChunks(): number[] {
    return [...this.received].sort((a, b) => a - b);
  }

  /** Expected byte length of a given chunk index. */
  expectedChunkSize(index: number): number {
    const last = this.totalChunks - 1;
    if (!Number.isInteger(index) || index < 0 || index > last) {
      throw new Error('Chunk index out of range');
    }
    return index === last ? this.size - last * CHUNK_SIZE : CHUNK_SIZE;
  }

  async writeChunk(index: number, data: Buffer, expectedSha256?: string): Promise<void> {
    if (this.status !== 'uploading') throw new Error('File is no longer accepting chunks');
    if (!this.handle) throw new Error('File is not open');

    const expectedLength = this.expectedChunkSize(index);
    if (data.length !== expectedLength) {
      throw new Error(`Chunk ${index} has ${data.length} bytes, expected ${expectedLength}`);
    }

    // Verify before writing, so corrupt data never reaches the disk.
    if (expectedSha256) {
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual !== expectedSha256) throw new Error(`Chunk ${index} failed its integrity check`);
    }

    try {
      await this.handle.write(data, 0, data.length, index * CHUNK_SIZE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new DiskFullError();
      throw e;
    }

    // Writing the same chunk twice is harmless: same bytes, same offset. That
    // happens when a reply is lost and the phone resends a chunk we already had.
    this.received.add(index);
  }

  /**
   * Verify completeness, hash the result, then publish it under its real name.
   *
   * Idempotent: if the phone's signal drops after we finish but before it
   * hears back, it will ask again. That must succeed, not report an error for
   * a transfer that actually worked.
   */
  async finish(): Promise<{ path: string; sha256: string }> {
    if (this.status === 'done' && this.finalPath && this.sha256) {
      return { path: this.finalPath, sha256: this.sha256 };
    }
    if (this.status !== 'uploading') throw new Error(this.error ?? 'This file failed');

    if (this.received.size !== this.totalChunks) {
      const missing = this.totalChunks - this.received.size;
      throw new Error(`Cannot finish: ${missing} chunk(s) still missing`);
    }

    await this.handle?.sync();
    await this.handle?.close();
    this.handle = null;

    const sha256 = await hashFile(this.partPath);

    // uniquePath again: something may have appeared while we were uploading.
    const finalPath = uniquePath(this.targetPath);
    await rename(this.partPath, finalPath);

    this.finalPath = finalPath;
    this.sha256 = sha256;
    this.status = 'done';
    return { path: finalPath, sha256 };
  }

  async abort(reason: string): Promise<void> {
    this.status = 'error';
    this.error = reason;
    try {
      await this.handle?.close();
    } catch {
      /* already closed */
    }
    this.handle = null;
    try {
      await unlink(this.partPath);
    } catch {
      /* never created, or already gone */
    }
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
