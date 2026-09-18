/** Tuning constants. Sizes are in bytes. */

/**
 * 4 MB chunks. Small enough that a failed chunk is cheap to retry on a weak
 * mobile signal, and far below the 100 MB per-request limit on free tunnels.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024;

/** How many chunks the phone uploads at once. */
export const PARALLEL_CHUNKS = 3;

/** Hard caps. Typical use is well under 100 MB; these stop accidents. */
export const MAX_FILE_BYTES = 1024 ** 3; // 1 GB
export const MAX_SESSION_BYTES = 1024 ** 3; // 1 GB
export const MAX_FILES_PER_SESSION = 200;

/** Keep this much disk free after a transfer. */
export const DISK_HEADROOM_BYTES = 200 * 1024 * 1024;

/**
 * Limits for unpacking a received zip. Documents compress well, so this is
 * far above the 1 GB upload cap, but still stops a zip bomb dead.
 */
export const MAX_EXTRACT_BYTES = Number(process.env.ST_MAX_EXTRACT_BYTES) || 4 * 1024 ** 3;
export const MAX_EXTRACT_ENTRIES = Number(process.env.ST_MAX_EXTRACT_ENTRIES) || 10_000;

/** Default port for the PC's own UI. Falls forward if taken. */
export const PC_PORT = 7777;

/**
 * Session security timings.
 *
 * Overridable by environment variable so tests can run them in milliseconds
 * instead of minutes. Students never need to set these.
 */
const ms = (envVar: string, fallback: number): number => {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/** How long one QR code stays valid while nobody has scanned it. */
export const TOKEN_TTL_MS = ms('ST_TOKEN_TTL_MS', 90_000);

/**
 * A just-replaced token keeps working briefly, because a phone that scanned
 * the QR a moment before it rotated is still loading the page.
 */
export const TOKEN_GRACE_MS = ms('ST_TOKEN_GRACE_MS', 10_000);

/** Closed after this long with no contact from the phone. */
export const IDLE_TIMEOUT_MS = ms('ST_IDLE_TIMEOUT_MS', 3 * 60_000);

/**
 * While a transfer is unfinished, allow a longer silence. Mobile signal dies
 * in lifts and stairwells, and losing 800 MB of progress to a 4-minute dead
 * zone would be worse than the small risk of a paired session idling longer.
 */
export const TRANSFER_IDLE_TIMEOUT_MS = ms('ST_TRANSFER_IDLE_TIMEOUT_MS', 10 * 60_000);

/** Normal session lifetime. */
export const HARD_TIMEOUT_MS = ms('ST_HARD_TIMEOUT_MS', 30 * 60_000);

/**
 * Absolute ceiling, only reachable while data is still flowing. A 1 GB
 * upload on a weak 3 Mbps signal takes ~45 minutes, so the 30 minute limit
 * alone would cut the largest allowed transfer off partway through.
 */
export const ABSOLUTE_MAX_MS = ms('ST_ABSOLUTE_MAX_MS', 2 * 60 * 60_000);

/** Closed if nobody scans the QR at all. */
export const UNCLAIMED_TIMEOUT_MS = ms('ST_UNCLAIMED_TIMEOUT_MS', 10 * 60_000);

/** Wrong-token attempts before the session is killed as a guessing attempt. */
export const MAX_FAILED_ATTEMPTS = Number(process.env.ST_MAX_FAILED_ATTEMPTS) || 5;

/** How often the phone page checks in so the PC knows it is still there. */
export const HEARTBEAT_MS = ms('ST_HEARTBEAT_MS', 30_000);
