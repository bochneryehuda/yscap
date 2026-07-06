/* YS Capital Group portal — service worker.
 * Caches ONLY the static app shell + build assets so the installed app opens
 * fast and survives a flaky connection. It NEVER caches API/auth responses,
 * documents, or anything that could hold borrower PII (SSNs, files). Those are
 * always fetched live over the network. */
// v4: purges caches poisoned by the bad-merge window where a missing CSS file
// was answered with the marketing homepage HTML (and cached as a "stylesheet").
const CACHE = 'ys-portal-shell-v4';
const SHELL = ['/portal/', '/portal/index.html', '/portal/manifest.webmanifest', '/portal/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Allow the page to force a full cache wipe on logout.
self.addEventListener('message', (e) => {
  if (e.data === 'ys-clear-cache') caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
});

const isSensitive = (url) =>
  url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') ||
  url.pathname.includes('/download') || url.pathname.startsWith('/api/address');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                         // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // let cross-origin pass through
  if (isSensitive(url)) return;                             // NEVER cache PII/API — go straight to network
  if (!url.pathname.startsWith('/portal/')) return;         // only manage the portal shell

  // App navigations: network-first, fall back to the cached shell when offline.
  // Keep the cached shell CURRENT on every successful load — a stale cached
  // index.html points at build assets that no longer exist after a deploy
  // (the classic "app broken until you clear your cache" bug).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => { c.put('/portal/index.html', copy); }).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/portal/index.html').then((r) => r || caches.match('/portal/'))));
    return;
  }
  // Build assets (hashed, immutable): cache-first, then populate the cache.
  // NEVER answer a failed script/style fetch with index.html — handing HTML to
  // a <script> tag hard-breaks the app with "Unexpected token '<'".
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })));
});
