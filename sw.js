/* Service worker: aplikacja działa bez internetu.
   Zmieniając pliki aplikacji, podnieś numer wersji poniżej, żeby telefon pobrał nowe pliki. */
var VERSION = 'espe-v1';
var FILES = [
  './', 'index.html', 'manifest.webmanifest', 'pdf.js',
  'assets/logo.png', 'assets/circle.png', 'assets/book.png',
  'fonts/Carlito-Regular.subset.ttf', 'fonts/Carlito-Bold.subset.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

// Najpierw z pamięci telefonu (szybko i offline), a w tle odświeżenie z sieci.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return hit || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()); });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net;
    })
  );
});
