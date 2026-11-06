const VERSION = 'v10';
const CACHE = `gatepass-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/db.js',
  '/js/sync.js',
  '/js/records.js',
  '/js/config.js',
  '/js/ui.js',
  '/js/photos.js',
  '/js/scanner.js',
  '/js/verify.js',
  '/js/visits.js',
  '/js/signature.js',
  '/js/devicekey.js',
  '/js/feedback.js',
  '/js/session.js',
  '/js/testmode.js',
  '/js/views/guide.js',
  '/js/theme.js',
  '/js/qr.js',
  '/js/views/spotcheck.js',
  '/js/views/incidents.js',
  '/js/views/checks.js',
  '/js/views/report.js',
  '/js/views/shift.js',
  '/js/views/onboarding.js',
  '/js/views/gate.js',
  '/js/views/checkin.js',
  '/js/views/onsite.js',
  '/js/views/muster.js',
  '/js/views/log.js',
  '/js/views/settings.js',
  '/data/site.json',
  '/vendor/jsQR.js',
  '/vendor/qrcode.js',
  '/manifest.webmanifest',
  '/icons/icon.svg'
];

const BYPASS = ['/api/', '/photos/', '/dashboard', '/pass'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), 3000);
    if (response.ok) cache.put('/index.html', response.clone());
    return response;
  } catch {
    return (await cache.match('/index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || network;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.some(prefix => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
