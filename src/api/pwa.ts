import { deflateSync } from 'node:zlib';

/**
 * Installable app shell (Add to Home Screen on iPhone): manifest, service
 * worker and icons. The service worker caches only the static shell; API
 * responses (private data) are never cached on the device.
 */
export const MANIFEST = {
  name: 'Jennifer',
  short_name: 'Jennifer',
  description: "Bruno's executive assistant",
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#141213',
  theme_color: '#141213',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

export const SERVICE_WORKER = `
// Notifications only. The app never serves pages from a cache: a stuck or broken
// cached copy showed as a black screen on the iPhone Home Screen app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Jennifer', { body: d.body || '', tag: d.tag, data: { url: d.url || '/' }, icon: '/icon-192.png', badge: '/icon-192.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if ('focus' in w) { w.navigate(url); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});
`;

/** Minimal RGBA PNG encoder (no image dependencies). */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const iconCache = new Map<number, Buffer>();

/** Deep plum background with a soft rose voice waveform. */
export function appIcon(size: number): Buffer {
  const hit = iconCache.get(size);
  if (hit) return hit;
  const bars = [0.28, 0.52, 0.78, 0.52, 0.28];
  const img = png(size, size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const bg: [number, number, number, number] = [Math.round(36 + 30 * v), 18, Math.round(32 + 20 * u), 255];
    const col = Math.floor((u - 0.2) / 0.12);
    if (u >= 0.2 && u < 0.8 && col >= 0 && col < 5) {
      const inBar = (u - 0.2) % 0.12 < 0.07;
      const h = bars[col]! * 0.6;
      if (inBar && Math.abs(v - 0.5) < h / 2) return [213, 138, 163, 255];
    }
    return bg;
  });
  iconCache.set(size, img);
  return img;
}

/** /reset: removes the background script and caches, then reopens Jennifer (you stay signed in). */
export const RESET_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jennifer</title>
<body style="background:#141213;color:#f2eeeb;font:17px -apple-system,system-ui,sans-serif;padding:48px 24px;text-align:center"><h2>Refreshing Jennifer…</h2><p id="m">One moment.</p>
<script>
(async () => {
  try { for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister(); } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  document.getElementById('m').textContent = 'Done. Opening Jennifer…';
  setTimeout(() => location.replace('/'), 800);
})();
</script></body>`;

/** /hello: the simplest possible page (no manifest, no service worker, no app code), to tell a phone problem from an app problem. */
export const HELLO_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><title>Jennifer test</title></head>
<body style="margin:0;background:#2f6b43;color:#fff;font:20px -apple-system,system-ui,sans-serif;padding:60px 24px;text-align:center">
<h1 style="font-size:34px">It works ✓</h1><p>If you can read this on the Home Screen icon, your iPhone can open web apps.</p>
<p id="info" style="font-size:15px;opacity:.85"></p>
<script>
var s = navigator.standalone ? 'Home Screen app' : 'Safari';
document.getElementById('info').textContent = 'Opened in: ' + s + ' · ' + new Date().toLocaleTimeString();
try { navigator.sendBeacon('/v1/client-log', new Blob([JSON.stringify({ stage: 'ready', msg: 'hello page', mode: navigator.standalone ? 'home-screen app' : 'browser', ua: navigator.userAgent.slice(0, 180), path: '/hello', ms: 0 })], { type: 'text/plain' })); } catch (e) {}
</script></body></html>`;
