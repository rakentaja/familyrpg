// Sleighbound service worker. build.ts fills in the version, the app shell list and the game asset list.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const ASSETS = __ASSETS__;
const SHELL_CACHE = 'sb2-shell-' + VERSION;
const ASSET_CACHE = 'sb2-assets';          // content-addressed by path; survives updates, pruned on activate
const PACK_CACHE = 'sb2-packs-' + VERSION;
const FONT_CACHE = 'sb2-fonts';
const KEEP = [SHELL_CACHE, ASSET_CACHE, PACK_CACHE, FONT_CACHE];
const BASE = new URL('./', self.location).href;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL.map((u) => new Request(new URL(u, BASE), { cache: 'reload' })));
    // First install: take over straight away. Updates wait until the player taps "reload".
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('sb2-') && !KEEP.includes(k)) || (k.startsWith('sb-') && !self.registration.scope.endsWith('/v2/'))) await caches.delete(k); // v1 caches go once v2 is live at the root
    // drop assets that are no longer part of the game
    const wanted = new Set(ASSETS.map((u) => new URL(u, BASE).href));
    const ac = await caches.open(ASSET_CACHE);
    for (const r of await ac.keys()) if (!wanted.has(r.url)) await ac.delete(r);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'skipWaiting') self.skipWaiting();
  if (msg.type === 'cacheAll') e.waitUntil(cacheAll(e.source));
  if (msg.type === 'offlineStatus') e.waitUntil(offlineStatus(e.source));
});

async function offlineStatus(client) {
  const ac = await caches.open(ASSET_CACHE);
  let have = 0;
  for (const u of ASSETS) if (await ac.match(new URL(u, BASE).href)) have++;
  client && client.postMessage({ type: 'offline', done: have, total: ASSETS.length });
}

async function cacheAll(client) {
  const ac = await caches.open(ASSET_CACHE);
  let done = 0;
  for (const u of ASSETS) {
    const url = new URL(u, BASE).href;
    try { if (!(await ac.match(url))) { const r = await fetch(url); if (r.ok) await ac.put(url, r); } } catch (err) { /* keep going */ }
    done++;
    client && client.postMessage({ type: 'offline', done, total: ASSETS.length });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') { e.respondWith(cacheFirst(req, FONT_CACHE)); return; }
  if (!url.href.startsWith(BASE)) return;                       // relays, other sites: straight to network
  const rel = url.href.slice(BASE.length);
  if (rel.startsWith('v2/')) return;                              // the v2 preview has its own service worker
  if (rel.startsWith('assets/')) { e.respondWith(cacheFirst(req, ASSET_CACHE)); return; }
  if (rel.startsWith('packs/')) { e.respondWith(networkFirst(req, PACK_CACHE)); return; }
  if (req.mode === 'navigate') { e.respondWith(shellNavigate(req)); return; }
  e.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone()).catch(() => {});
  return r;
}

async function networkFirst(req, name) {
  const c = await caches.open(name);
  try {
    const r = await fetch(req, { cache: 'no-cache' });
    if (r.ok) c.put(req, r.clone()).catch(() => {});
    return r;
  } catch (err) {
    const hit = (await c.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    throw err;
  }
}

async function shellNavigate(req) {
  const c = await caches.open(SHELL_CACHE);
  const hit = await c.match(new URL('./', BASE).href) || await c.match(new URL('index.html', BASE).href);
  if (hit) return hit;
  return fetch(req);
}
