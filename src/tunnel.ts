/**
 * Public HTTPS address for the phone, via a Cloudflare quick tunnel.
 *
 * The PC only ever makes an outgoing connection, so there is no firewall
 * prompt, no port to open and no router change. Phase 6 can swap this module
 * for our own relay without touching anything else.
 *
 * cloudflared prints the URL well before phones can use it, and checking
 * too early is actively harmful. See "Readiness checks" below.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { lookup as dnsLookup, Resolver as DnsResolver } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const URL_PATTERN = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;

export interface Tunnel {
  url: string;
  stop(): void;
}

function binDir(): string {
  const base =
    process.env.LOCALAPPDATA ||
    (platform() === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support')
      : path.join(homedir(), '.local', 'share'));
  return path.join(base, 'stuff-transfer', 'bin');
}

function assetName(): string {
  const p = platform();
  const a = arch();
  if (p === 'win32') return a === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  if (p === 'linux') return a === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  throw new Error('On macOS, install cloudflared first:  brew install cloudflared');
}

/** Download cloudflared once per user. No admin rights needed. */
export async function ensureCloudflared(onProgress?: (pct: number) => void): Promise<string> {
  const dir = binDir();
  const target = path.join(dir, platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared');

  if (existsSync(target) && statSync(target).size > 1_000_000) return target;

  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${RELEASE_BASE}/${assetName()}`, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Could not download cloudflared (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -1;

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    done += chunk.length;
    if (!total || !onProgress) return;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      onProgress(pct);
    }
  });

  const tmp = `${target}.part`;
  await pipeline(body, createWriteStream(tmp));
  await rename(tmp, target);
  if (platform() !== 'win32') await chmod(target, 0o755);

  return target;
}

/** Start a tunnel to a local port and wait until phones can actually reach it. */
export async function startTunnel(localPort: number, probePath = '/health'): Promise<Tunnel> {
  const bin = await ensureCloudflared();

  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // If the app exits for any reason, even mid-startup before the caller holds
  // a reference, take the tunnel with it. Otherwise (notably on Linux) the
  // tunnel keeps a public URL pointed at this PC after the app is gone.
  const killOnExit = () => child.kill();
  process.once('exit', killOnExit);
  child.once('exit', () => process.removeListener('exit', killOnExit));

  try {
    const url = await readUrl(child);
    const host = new URL(url).hostname;

    // Both must hold before the QR is shown: Cloudflare routes the name to
    // us, AND public DNS knows the name, so a phone's first lookup succeeds.
    await Promise.all([waitForEdgeRoute(host, probePath), waitForPublicDns(host)]);

    return {
      url,
      stop() {
        child.kill();
      },
    };
  } catch (e) {
    child.kill(); // never leave an orphaned tunnel running after a failure
    throw e;
  }
}

function readUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('cloudflared gave no URL within 45s — the network may be blocking it'))),
      45_000,
    );

    // cloudflared prints the URL on stderr, not stdout.
    const scan = (buf: Buffer) => {
      const match = buf.toString().match(URL_PATTERN);
      if (match) finish(() => resolve(match[0]));
    };

    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code) =>
      finish(() => reject(new Error(`cloudflared exited early (code ${code})`))),
    );
  });
}

// ---------------------------------------------------------------------------
// Readiness checks
//
// Why this is not simply "fetch the URL until it works":
//
// A new quick-tunnel name does not exist in DNS for somewhere between a few
// and 20+ seconds. A lookup in that window gets "no such name", and
// trycloudflare.com tells resolvers to remember that answer for 1800s. So an
// early fetch poisons this PC's DNS cache for up to 30 minutes, and the app
// then reports a broken tunnel that is actually working fine. Any fixed
// "wait N seconds first" is a guess that sometimes loses.
//
// Worse, if a PHONE looked the name up too early, its mobile carrier's DNS
// would refuse it for 30 minutes and that student could not connect at all.
//
// So neither check below goes near a caching resolver for our hostname.
// ---------------------------------------------------------------------------

const debug = (msg: string) => {
  if (process.env.STUFF_TRANSFER_DEBUG) console.log(`  [probe] ${msg}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Is Cloudflare routing our hostname to this PC yet — everywhere?
 *
 * Connects to a Cloudflare edge IP and names our host via TLS SNI, so our
 * hostname is never looked up in DNS. Before the route exists the edge says
 * HTTP 530; afterwards our /health answers 200. Neither answer is cached.
 *
 * One 200 is not enough. Measured on fresh tunnels: after the first success
 * the route stays patchy for ~30 seconds (sometimes a minute) as Cloudflare's
 * servers learn it one by one, with lucky runs of up to 4 successes in a
 * row. A student arriving then gets a Cloudflare error page. So we require
 * a long unbroken run, each on a NEW connection — reusing one would keep
 * hitting the same server and look falsely stable.
 */
const STABLE_RUN = 15;

async function waitForEdgeRoute(host: string, probePath: string, timeoutMs = 150_000): Promise<void> {
  // The apex name is long-established, so looking it up is safe.
  const edgeIps = (await dnsLookup('trycloudflare.com', { all: true })).map((a) => a.address);
  if (edgeIps.length === 0) throw new Error('Could not find Cloudflare on this network');

  const started = Date.now();
  let streak = 0;
  let last = 'no answer';
  let marks = '';

  for (let i = 0; Date.now() - started < timeoutMs; i++) {
    last = await edgeGet(edgeIps[i % edgeIps.length]!, host, probePath);
    streak = last === '200' ? streak + 1 : 0;
    marks += last === '200' ? '+' : '-';

    if (streak >= STABLE_RUN) {
      debug(`edge route stable after ${Math.round((Date.now() - started) / 1000)}s: ${marks}`);
      return;
    }
    await sleep(400);
  }
  debug(`edge route never settled: ${marks}`);
  throw new Error(`Cloudflare never routed the tunnel reliably (last answer: ${last})`);
}

function edgeGet(ip: string, host: string, path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = httpsGet(
      // agent:false = a fresh connection per probe, as separate phones would make
      { host: ip, servername: host, path, headers: { host }, timeout: 8000, agent: false },
      (res) => {
        res.resume();
        resolve(String(res.statusCode));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
}

/**
 * Does public DNS know our hostname yet?
 *
 * Asks Cloudflare's authoritative nameservers directly. They hold the
 * record themselves and never cache a "no such name", so polling them is
 * safe. Only once they answer do we show a QR that a phone will look up.
 *
 * Direct DNS on port 53 may be blocked on some networks. Then we fall back
 * to waiting a generous fixed time, which is a guess, but a conservative one.
 */
async function waitForPublicDns(host: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();

  let resolver: DnsResolver | null = null;
  try {
    resolver = await authoritativeResolver();
  } catch (e) {
    debug(`authoritative lookup unavailable: ${(e as Error).message}`);
  }

  if (resolver) {
    let networkFailures = 0;
    while (Date.now() - started < timeoutMs) {
      try {
        const ips = await resolver.resolve4(host);
        if (ips.length) {
          debug(`authoritative DNS has ${host} after ${Math.round((Date.now() - started) / 1000)}s`);
          return;
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        debug(`authoritative DNS -> ${code}`);
        // ENOTFOUND/ENODATA mean "not yet": keep asking. Anything else means
        // we cannot reach the nameservers at all.
        if (code !== 'ENOTFOUND' && code !== 'ENODATA' && ++networkFailures >= 3) break;
      }
      await sleep(1000);
    }
    if (Date.now() - started >= timeoutMs) throw new Error('Public DNS never published the tunnel name');
  }

  // Fallback: port 53 blocked. Empirically the name appears within ~20s.
  const FALLBACK_MS = 35_000;
  debug(`falling back to a fixed ${FALLBACK_MS / 1000}s wait for DNS`);
  await sleep(Math.max(0, FALLBACK_MS - (Date.now() - started)));
}

/** A resolver pointed straight at trycloudflare.com's own nameservers. */
async function authoritativeResolver(): Promise<DnsResolver> {
  // Find the nameservers over HTTPS, which works on networks that block DNS.
  const res = await fetch('https://cloudflare-dns.com/dns-query?name=trycloudflare.com&type=NS', {
    headers: { accept: 'application/dns-json' },
  });
  const body = (await res.json()) as { Answer?: Array<{ data: string }> };
  const names = (body.Answer ?? []).map((a) => a.data.replace(/\.$/, ''));
  if (names.length === 0) throw new Error('no nameservers listed');

  const ips = (await Promise.all(names.map((n) => dnsLookup(n).catch(() => null))))
    .filter((a): a is { address: string; family: number } => a !== null)
    .map((a) => a.address);
  if (ips.length === 0) throw new Error('could not resolve the nameservers');

  const resolver = new DnsResolver({ timeout: 3000, tries: 1 });
  resolver.setServers(ips);
  return resolver;
}
