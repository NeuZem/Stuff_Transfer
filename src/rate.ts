/**
 * Transfer speed over a sliding window.
 *
 * A lifetime average reacts too slowly to be useful on mobile data, where
 * speed swings wildly as the signal changes. Five seconds is long enough to
 * smooth out bursts and short enough to show a stall almost immediately.
 */

const WINDOW_MS = 5000;

export class RateMeter {
  private events: Array<{ t: number; bytes: number }> = [];

  record(bytes: number, now = Date.now()): void {
    if (bytes <= 0) return;
    this.events.push({ t: now, bytes });
    this.prune(now);
  }

  /** Bytes per second over the recent window. Zero when nothing is moving. */
  bytesPerSecond(now = Date.now()): number {
    this.prune(now);
    if (this.events.length === 0) return 0;

    const total = this.events.reduce((n, e) => n + e.bytes, 0);
    // Early in a transfer the window is only partly filled; dividing by the
    // full 5s would under-report. Floor at 1s so one burst doesn't spike it.
    const span = Math.max(1000, Math.min(WINDOW_MS, now - this.events[0]!.t));
    return (total / span) * 1000;
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.events.length && this.events[0]!.t < cutoff) this.events.shift();
  }
}
