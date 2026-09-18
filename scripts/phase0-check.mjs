#!/usr/bin/env node
/**
 * Phase 0 safety-net check.
 *
 * Proves, on a real lab PC, that:
 *   1. cloudflared can be downloaded and run without admin rights
 *   2. the college network allows the outbound tunnel connection
 *   3. a phone on mobile data can reach a page served from this PC
 *
 * Run it with:   node scripts/phase0-check.mjs
 * Stop it with:  Ctrl+C
 *
 * No npm dependencies, so it runs before `npm install`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { homedir, platform, arch } from 'node:os';
import { lookup as dnsLookup, Resolver as DnsResolver } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import path from 'node:path';

const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** Where the cloudflared binary is cached, per user, no admin needed. */
function binDir() {
  const base =
    process.env.LOCALAPPDATA ||
    (platform() === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support')
      : path.join(homedir(), '.local', 'share'));
  return path.join(base, 'stuff-transfer', 'bin');
}

function assetName() {
  const p = platform();
  const a = arch();
  if (p === 'win32') return a === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  if (p === 'darwin') return a === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  return a === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
}

async function ensureCloudflared() {
  const name = assetName();
  if (name.endsWith('.tgz')) {
    throw new Error('On macOS, install cloudflared first with:  brew install cloudflared');
  }
  const dir = binDir();
  const target = path.join(dir, platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared');

  if (existsSync(target) && statSync(target).size > 1_000_000) {
    console.log(`[1/4] cloudflared already present: ${target}`);
    return target;
  }

  mkdirSync(dir, { recursive: true });
  const url = `${CLOUDFLARED_RELEASE}/${name}`;
  console.log(`[1/4] Downloading cloudflared`);
  console.log(`      from ${url}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`\r      ${pct}%  (${(done / 1e6).toFixed(1)} MB)   `);
    }
  });

  const tmp = `${target}.part`;
  await pipeline(body, createWriteStream(tmp));
  await rename(tmp, target);
  if (platform() !== 'win32') await chmod(target, 0o755);

  process.stdout.write('\n');
  console.log(`      Saved to ${target}`);
  return target;
}

/**
 * Local test server.
 *   /     the page the PHONE should load (also what the tunnel exposes)
 *   /pc   a QR page for this PC's own browser
 */
function startTestServer(state) {
  let hits = 0;

  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    if (url === '/pc') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pcPage(state));
      return;
    }

    // Readiness probes land here, so they are not counted as a phone visit.
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hits }));
      return;
    }

    hits++;
    const ua = req.headers['user-agent'] || 'unknown';
    const isPhone = /android|iphone|ipad|mobile/i.test(ua);
    console.log(`\n  >> HIT #${hits} from ${isPhone ? 'a PHONE' : 'a non-phone client'}`);
    console.log(`     ${ua.slice(0, 90)}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(phonePage());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => hits }));
  });
}

const phonePage = () => `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phase 0 OK</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100svh;margin:0;
       background:#0b1020;color:#e8ecff;text-align:center}
  .tick{font-size:4rem}h1{font-size:1.5rem;margin:.5rem 0}p{opacity:.75;line-height:1.6}
</style>
<div>
  <div class="tick">&#9989;</div>
  <h1>Phase 0 passed</h1>
  <p>This page came from the lab PC,<br>over your mobile data.<br><br>The tunnel works.</p>
</div>`;

const pcPage = (state) => `<!doctype html>
<meta charset="utf-8">
<title>Phase 0 — scan this</title>
<style>
  body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100svh;margin:0;
       background:#0b1020;color:#e8ecff;text-align:center}
  #qr{background:#fff;padding:16px;border-radius:12px;display:inline-block;min-height:280px;min-width:280px}
  code{background:#1a2138;padding:.4rem .6rem;border-radius:6px;font-size:.85rem;word-break:break-all}
  .hint{opacity:.7;max-width:34rem;line-height:1.6}
  .ok{color:#4ade80;font-weight:600}
</style>
<div>
  <h1>Scan with your phone</h1>
  <p class="hint">Turn <b>Wi-Fi off</b> on the phone so it uses mobile data. That is the condition we are testing.</p>
  <div id="qr">loading…</div>
  <p><code>${state.url ?? 'waiting for tunnel…'}</code></p>
  <p id="status" class="hint">Waiting for the phone to connect…</p>
</div>
<script type="module">
  const url = ${JSON.stringify(state.url ?? '')};
  if (url) {
    try {
      const { default: QRCode } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
      document.getElementById('qr').innerHTML =
        '<img width="256" height="256" src="' + await QRCode.toDataURL(url, { width: 512, margin: 1 }) + '">';
    } catch {
      document.getElementById('qr').textContent = 'QR library blocked — type the URL below instead.';
    }
  }
  setInterval(async () => {
    const { hits } = await (await fetch('/hits')).json();
    if (hits > 0) document.getElementById('status').innerHTML =
      '<span class="ok">Connected — ' + hits + ' hit(s). Phase 0 passed.</span>';
  }, 1000);
</script>`;

function startTunnel(bin, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(
      () => !settled && reject(new Error('No tunnel URL after 45s — the network may be blocking it')),
      45_000,
    );

    const scan = (buf) => {
      const text = buf.toString();
      const m = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan); // cloudflared prints the URL on stderr
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited early with code ${code}`));
      }
    });
  });
}

/**
 * Ask a Cloudflare edge IP directly, naming our host via TLS SNI, so our
 * hostname is never looked up in DNS. Requires an unbroken run of successes
 * on fresh connections: right after the first success the route is patchy
 * for ~30s while Cloudflare's servers learn it one by one.
 */
async function waitForStableRoute(host, timeoutMs = 150_000) {
  const edgeIps = (await dnsLookup('trycloudflare.com', { all: true })).map((a) => a.address);
  const started = Date.now();
  let streak = 0;
  for (let i = 0; Date.now() - started < timeoutMs; i++) {
    const status = await new Promise((resolve) => {
      const req = httpsGet(
        { host: edgeIps[i % edgeIps.length], servername: host, path: '/health', headers: { host }, timeout: 8000, agent: false },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(0));
    });
    streak = status === 200 ? streak + 1 : 0;
    if (streak >= 15) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Ask trycloudflare.com's own nameservers, which never cache a "not found",
 * whether our name is published yet. Falls back to a fixed wait if this
 * network blocks direct DNS.
 */
async function waitForPublicDns(host, timeoutMs = 90_000) {
  const started = Date.now();
  try {
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=trycloudflare.com&type=NS', {
      headers: { accept: 'application/dns-json' },
    });
    const names = ((await res.json()).Answer ?? []).map((a) => a.data.replace(/\.$/, ''));
    const ips = (await Promise.all(names.map((n) => dnsLookup(n).catch(() => null)))).filter(Boolean).map((a) => a.address);
    const resolver = new DnsResolver({ timeout: 3000, tries: 1 });
    resolver.setServers(ips);

    let networkFailures = 0;
    while (Date.now() - started < timeoutMs) {
      try {
        if ((await resolver.resolve4(host)).length) return true;
      } catch (e) {
        if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA' && ++networkFailures >= 3) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (Date.now() - started >= timeoutMs) return false;
  } catch {
    /* direct DNS unavailable on this network: fall through */
  }
  console.log('      (direct DNS blocked on this network; using a fixed wait instead)');
  await new Promise((r) => setTimeout(r, Math.max(0, 35_000 - (Date.now() - started))));
  return true;
}

function openBrowser(url) {
  const p = platform();
  const cmd = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open';
  const args = p === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function main() {
  console.log('\n=== Stuff Transfer — Phase 0 check ===\n');

  const bin = await ensureCloudflared();

  const state = { url: null };
  const { server, port, hits } = await startTestServer(state);
  console.log(`[2/4] Local test server on http://127.0.0.1:${port}`);

  console.log('[3/4] Starting tunnel (a few seconds)...');
  const { child, url } = await startTunnel(bin, port);
  state.url = url;
  console.log(`      Public URL: ${url}`);

  // Do NOT simply fetch the URL until it works. The name does not exist in
  // DNS for the first few seconds, and a lookup then caches "no such name"
  // for up to 30 minutes -- a false failure that looks exactly like a
  // blocked network. Same two cache-proof checks as the real app.
  console.log('[4/4] Waiting until phones can reliably reach it (about 40s)...');
  const host = new URL(url).hostname;
  const started = Date.now();
  const [route, dnsReady] = await Promise.all([waitForStableRoute(host), waitForPublicDns(host)]);
  const reachable = route && dnsReady;
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`      Cloudflare route: ${route ? 'stable' : 'NEVER SETTLED'}`);
  console.log(`      Public DNS:       ${dnsReady ? 'published' : 'NOT PUBLISHED'}`);
  console.log(reachable ? `      Ready after ${secs}s` : '\n      Not reachable within the time limit.');

  // Non-interactive mode: stop after the self-check instead of waiting for a phone.
  if (process.env.PHASE0_ONESHOT) {
    console.log(reachable ? '\nOneshot: tunnel reachable. PASS' : '\nOneshot: tunnel NOT reachable. FAIL');
    child.kill();
    server.close();
    process.exit(reachable ? 0 : 1);
  }

  console.log('\n--------------------------------------------------');
  console.log('  NOW THE REAL TEST');
  console.log('  Turn Wi-Fi OFF on the phone, use mobile data,');
  console.log('  then scan the QR in the browser window that just');
  console.log('  opened, or type this URL:\n');
  console.log(`  ${url}\n`);
  console.log('--------------------------------------------------');
  console.log('  Waiting for a phone to connect... (Ctrl+C to stop)\n');

  openBrowser(`http://127.0.0.1:${port}/pc`);

  const shutdown = () => {
    console.log(`\nStopping. Total hits: ${hits()}`);
    child.kill();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}\n`);
  process.exit(1);
});
