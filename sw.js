/* ==========================================================================
   OFFPEDIA — service worker
   Bump CACHE_VERSION after every deploy that changes the shell files.
   ========================================================================== */
'use strict';

var CACHE_VERSION = 'v1';
var SHELL_CACHE = 'offpedia-shell-' + CACHE_VERSION;
var DATA_CACHE = 'offpedia-data-' + CACHE_VERSION;
var IMAGE_CACHE = 'offpedia-img-' + CACHE_VERSION;
var CURRENT_CACHES = [SHELL_CACHE, DATA_CACHE, IMAGE_CACHE];
var OWNED_CACHE = /^offpedia-(shell|data|img)-/;

var IMAGE_CACHE_LIMIT = 150;
var IMAGE_TIMEOUT_MS = 8000;

var CATEGORY_FILES = [
  'science.json', 'technology.json', 'history.json', 'geography.json', 'space.json',
  'animals.json', 'human-body.json', 'sports.json', 'countries.json', 'culture.json'
];

var SHELL_FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './language.json'];
var DATA_FILES = CATEGORY_FILES.map(function (name) { return './' + name; });

/* Scope root, used to tell our own files apart from anything else same-origin. */
var SCOPE_PATH = new URL('./', self.location.href).pathname;

var PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img" aria-label="Image unavailable offline">' +
  '<rect width="640" height="360" fill="#e7ebf3"/>' +
  '<g fill="#9aa6bd">' +
  '<path d="M196 232l60-74 44 54 30-36 74 92z"/>' +
  '<circle cx="243" cy="140" r="18"/>' +
  '</g>' +
  '<rect x="1" y="1" width="638" height="358" fill="none" stroke="#cdd5e4" stroke-width="2"/>' +
  '</svg>';

function placeholderResponse() {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/* ------------------------------------------------------------------ install */

self.addEventListener('install', function (event) {
  event.waitUntil(
    Promise.all([
      addAllIndividually(SHELL_CACHE, SHELL_FILES),
      addAllIndividually(DATA_CACHE, DATA_FILES)
    ]).then(function () { return self.skipWaiting(); })
  );
});

/* One unreachable file must never abort the whole install. */
function addAllIndividually(cacheName, urls) {
  return caches.open(cacheName).then(function (cache) {
    return Promise.all(urls.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' }))['catch'](function (err) {
        console.warn('OFFPEDIA SW: could not precache ' + url, err);
      });
    }));
  })['catch'](function (err) {
    console.warn('OFFPEDIA SW: cache open failed for ' + cacheName, err);
  });
}

/* ----------------------------------------------------------------- activate */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        /* Only ever delete caches that belong to OFFPEDIA. */
        if (OWNED_CACHE.test(key) && CURRENT_CACHES.indexOf(key) === -1) {
          return caches['delete'](key);
        }
        return Promise.resolve(false);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') { self.skipWaiting(); }
});

/* -------------------------------------------------------------- strategies */

function cacheFirstWithRefresh(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) { cache.put(request, response.clone())['catch'](function () {}); }
        return response;
      })['catch'](function () { return null; });

      if (cached) { return cached; }
      return network.then(function (response) {
        return response || cache.match('./index.html').then(function (shell) {
          return shell || Response.error();
        });
      });
    });
  });
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) { cache.put(request, response.clone())['catch'](function () {}); }
        return response;
      })['catch'](function () { return null; });

      if (cached) { return cached; }
      return network.then(function (response) {
        /* No cache, no network: hand back an empty-but-valid payload so the app
           can show its translated empty state instead of crashing. */
        return response || new Response('{"category":"","articles":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });
    });
  });
}

function handleNavigation(request) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match('./index.html').then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) { cache.put('./index.html', response.clone())['catch'](function () {}); }
        return response;
      })['catch'](function () { return null; });

      if (cached) { return cached; }
      return network.then(function (response) { return response || placeholderNavigation(); });
    });
  });
}

function placeholderNavigation() {
  return new Response('<!DOCTYPE html><meta charset="utf-8"><title>OFFPEDIA</title><p>OFFPEDIA is offline and has nothing cached yet.</p>', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function fetchWithTimeout(request, ms) {
  if (typeof AbortController === 'undefined') { return fetch(request); }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, ms);
  /* A Request cannot carry a foreign signal, so rebuild it with the same mode. */
  return fetch(request.url, {
    mode: request.mode === 'navigate' ? 'no-cors' : request.mode,
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal: controller.signal
  })['finally'](function () { clearTimeout(timer); });
}

function handleImage(request) {
  return caches.open(IMAGE_CACHE).then(function (cache) {
    return cache.match(request, { ignoreVary: true }).then(function (cached) {
      if (cached) { return cached; }
      /* Offline and not cached: answer instantly, never touch the network. */
      if (self.navigator && self.navigator.onLine === false) { return placeholderResponse(); }

      /* Online: a failure is reported back to the page, which then swaps in its
         own translated placeholder. Only good (or opaque) responses are cached. */
      return fetchWithTimeout(request, IMAGE_TIMEOUT_MS).then(function (response) {
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(request, response.clone())
            .then(function () { return trimCache(cache, IMAGE_CACHE_LIMIT); })
            ['catch'](function () {});
          return response;
        }
        return Response.error();
      })['catch'](function () { return Response.error(); });
    });
  })['catch'](function () { return placeholderResponse(); });
}

/* Oldest entries first — cache.keys() preserves insertion order. */
function trimCache(cache, limit) {
  return cache.keys().then(function (keys) {
    if (keys.length <= limit) { return null; }
    var excess = keys.slice(0, keys.length - limit);
    return Promise.all(excess.map(function (key) { return cache['delete'](key); }));
  });
}

/* ------------------------------------------------------------------- fetch */

function isCategoryData(pathname) {
  var name = pathname.slice(pathname.lastIndexOf('/') + 1);
  return CATEGORY_FILES.indexOf(name) !== -1;
}

function isShellAsset(pathname) {
  return /\.(?:html|css|js|webmanifest)$/i.test(pathname) ||
    pathname.endsWith('/manifest.json') ||
    pathname.endsWith('/language.json') ||
    pathname === SCOPE_PATH;
}

function looksLikeImage(request, url) {
  if (request.destination === 'image') { return true; }
  return /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:$|\?)/i.test(url.pathname + url.search);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') { return; }

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  var sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    if (request.mode === 'navigate') {
      event.respondWith(handleNavigation(request));
      return;
    }
    if (isCategoryData(url.pathname)) {
      event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
      return;
    }
    if (isShellAsset(url.pathname)) {
      event.respondWith(cacheFirstWithRefresh(request, SHELL_CACHE));
      return;
    }
    if (looksLikeImage(request, url)) {
      event.respondWith(handleImage(request));
      return;
    }
    return; /* anything else same-origin: straight to the network */
  }

  /* Cross-origin: only encyclopedia images are ever touched. */
  if (looksLikeImage(request, url)) {
    event.respondWith(handleImage(request));
  }
});
