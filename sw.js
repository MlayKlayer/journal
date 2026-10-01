// Offline: serve the app shell from the cache, never from the network once installed.
// Bump CACHE when any file changes so phones pick up the new version.
const CACHE = 'journal-v1';
const FILES = ['./', './index.html', './app.js', './core.js', './style.css', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit ?? fetch(e.request)));
});
