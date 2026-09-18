/**
 * Unpacking a received .zip on the PC.
 *
 * iPhones cannot pick folders in the browser, so the way to send a folder
 * from one is to zip it first. This unpacks it at the student's request.
 *
 * A zip from a phone is untrusted input, and zips have two classic attacks:
 *
 *   - "zip slip": an entry named ../../Windows/evil.dll writes outside the
 *     target folder. yauzl rejects such names, and every path also goes
 *     through our own safeJoin() as a second, independent check.
 *
 *   - "zip bomb": a tiny zip that expands to terabytes. yauzl verifies that
 *     each entry decompresses to exactly the size it declares, so the
 *     declared sizes can be totalled and refused BEFORE writing anything.
 *
 * Extraction goes to a temporary folder that is renamed only on success,
 * so a failure never leaves a half-unpacked mess behind.
 */

import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { DISK_HEADROOM_BYTES, MAX_EXTRACT_BYTES, MAX_EXTRACT_ENTRIES } from './config.js';
import { formatBytes, freeSpace, safeFileName, safeJoin, uniquePath } from './safety.js';

/** A problem worth showing the student as-is. */
export class ExtractError extends Error {}

export interface ExtractResult {
  folder: string;
  files: number;
  bytes: number;
  skipped: number;
}

export async function extractZip(zipPath: string, parentDir: string): Promise<ExtractResult> {
  let zip: ZipFile;
  try {
    zip = await openZip(zipPath);
  } catch (e) {
    // Most often: not a zip at all. Opening is where yauzl notices that.
    throw new ExtractError(friendlyZipError(e));
  }

  try {
    const entries = await readAllEntries(zip);

    // --- inspect everything before writing anything ---
    const files: Entry[] = [];
    let skipped = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue; // folders are created as needed
      if (isSymlink(entry)) {
        skipped++; // a link could point anywhere on the PC; never recreate it
        continue;
      }
      if (entry.isEncrypted()) {
        throw new ExtractError('This zip is password-protected. Unzip it on the phone instead.');
      }
      files.push(entry);
      totalBytes += entry.uncompressedSize;
    }

    if (files.length > MAX_EXTRACT_ENTRIES) {
      throw new ExtractError(`This zip has ${files.length} files, more than the ${MAX_EXTRACT_ENTRIES} limit.`);
    }
    if (totalBytes > MAX_EXTRACT_BYTES) {
      throw new ExtractError(
        `This zip would unpack to ${formatBytes(totalBytes)}, more than the ${formatBytes(MAX_EXTRACT_BYTES)} limit.`,
      );
    }
    const free = await freeSpace(parentDir);
    if (free !== null && free - totalBytes < DISK_HEADROOM_BYTES) {
      throw new ExtractError(`Not enough free space on the PC to unpack ${formatBytes(totalBytes)}.`);
    }

    // Compressing a folder (as an iPhone does) puts that folder at the top of
    // the zip. Unpacking it into a folder named after the zip would give
    // "Semester 3/Semester 3/...", so use the zip's own top folder instead.
    const roots = new Set(entries.map((e) => e.fileName.split('/')[0]));
    const [onlyRoot] = roots;
    const singleRoot =
      roots.size === 1 && onlyRoot && entries.every((e) => e.fileName.startsWith(`${onlyRoot}/`))
        ? onlyRoot
        : null;

    // --- unpack into a temporary folder, publish only on success ---
    const baseName = singleRoot ?? (path.basename(zipPath).replace(/\.zip$/i, '') || 'unzipped');
    const finalDir = uniquePath(path.join(parentDir, safeFileName(baseName)));
    const workDir = `${finalDir}.unpacking`;

    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    try {
      for (const entry of files) {
        // Second, independent guard on top of yauzl's own name validation.
        const relative = singleRoot ? entry.fileName.slice(singleRoot.length + 1) : entry.fileName;
        const target = safeJoin(workDir, relative);
        await mkdir(path.dirname(target), { recursive: true });
        const stream = await openEntry(zip, entry);
        await pipeline(stream, createWriteStream(uniquePath(target)));
      }
      await rename(workDir, finalDir);
    } catch (e) {
      await rm(workDir, { recursive: true, force: true });
      throw e;
    }

    return { folder: finalDir, files: files.length, bytes: totalBytes, skipped };
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError(friendlyZipError(e));
  } finally {
    zip.close();
  }
}

function isSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

function friendlyZipError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/invalid relative path|absolute path|\.\./i.test(msg)) {
    return 'This zip contains unsafe file paths, so it was not unpacked.';
  }
  if (/end of central directory|not a zip|invalid (signature|comment)/i.test(msg)) {
    return 'This file is not a valid zip, or it is damaged.';
  }
  if (/too many bytes|too few bytes|uncompressed size/i.test(msg)) {
    return 'This zip is damaged: its contents do not match its own description.';
  }
  return `Could not unpack this zip (${msg}).`;
}

// --- promise wrappers around yauzl's callback API ---

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      // autoClose off: entries are read in one pass and streamed in another.
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true },
      (err, zip) => (err || !zip ? reject(err ?? new Error('Could not open zip')) : resolve(zip)),
    );
  });
}

function readAllEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      entries.push(entry);
      // Refuse absurd entry counts while reading, not after.
      if (entries.length > MAX_EXTRACT_ENTRIES + 1) {
        reject(new ExtractError(`This zip has more than ${MAX_EXTRACT_ENTRIES} files.`));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) =>
      err || !stream ? reject(err ?? new Error('Could not read zip entry')) : resolve(stream),
    );
  });
}
