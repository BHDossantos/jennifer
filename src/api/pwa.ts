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
const SHELL = 'jennifer-shell-v2';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
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
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls or anything private: network only.
  if (url.origin !== location.origin || url.pathname.startsWith('/v1/') || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
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
