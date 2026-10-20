/* ================================================================
   Vantage Mission Console — app-shell service worker
   ================================================================
   Registered by the console itself, and only when the page is served
   over a real http(s) origin: file:// has no scope to register into
   and a blob: script may not register one, so the console degrades to
   normal network behaviour there with no error.

   Caching policy, deliberately narrow:

     • the app shell (this page) is network-first, so an update always
       wins when the network is up, with the cache as its offline floor;
     • static libraries and fonts (Leaflet, Chart.js, Google Fonts,
       thumbnails) are cache-first with a background refresh;
     • every live API host is passed straight through to the network.
       A cached asteroid list or launch manifest is not a substitute
       for a current one, and each feed already has its own sample-data
       and retry fallback inside the page.

   To ship a new build, bump VERSION — activate clears every older key.
   ================================================================ */

const VERSION = 'vantage-v1';
const SHELL = ['./', './index.html'];

/* Requested live data must never be answered from cache, even stale. */
const LIVE_HOSTS = /(^|\.)(api\.nasa\.gov|eonet\.gsfc\.nasa\.gov|services\.swpc\.noaa\.gov|ll\.thespacedevs\.com|sat\.terrestre\.ar|api\.wheretheiss\.at|api\.open-notify\.org)$/i;

/* Third-party assets worth keeping: the console depends on these to render at all. */
const STATIC_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|i\.ytimg\.com|youtube\.com|www\.youtube\.com)$/i;

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* addAll rejects the whole batch if one URL fails; allSettled keeps a partial shell
       cached rather than losing the ones that did arrive */
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    await announceCount();
  })());
});

/* The page shows a status line; this is the only honest way for it to know the cache is
   actually warm rather than merely registered. */
async function announceCount() {
  try {
    const cache = await caches.open(VERSION);
    const keys = await cache.keys();
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'cached', count: keys.length }));
  } catch (_e) { /* status line is cosmetic — never let it break activation */ }
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'count') announceCount();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_e) { return; }

  /* live endpoints: hand straight back to the network and its own fallbacks */
  if (LIVE_HOSTS.test(url.hostname)) return;

  const sameOrigin = url.origin === self.location.origin;
  const isStatic = sameOrigin || STATIC_HOSTS.test(url.hostname);
  if (!isStatic) return;

  /* navigations are network-first so a redeploy is picked up immediately */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_e) {
        return (await cache.match('./index.html')) || (await cache.match('./')) ||
          new Response('Offline and no cached copy of the console yet.', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  /* static libraries and fonts: cache-first, refreshed in the background */
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(network); return hit; }
    const res = await network;
    return res || new Response('', { status: 504 });
  })());
});
