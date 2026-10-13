var CACHE_NAME = 'turn-mcp-v3';
var STATIC_ASSETS = ['/', '/app.js', '/styles.css', '/i18n.js', '/manifest.json'];
self.addEventListener('install', function (event) {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
        return cache.addAll(STATIC_ASSETS);
    }).catch(function () { }));
});
self.addEventListener('activate', function (event) {
    event.waitUntil(Promise.all([
        self.clients.claim(),
        caches.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
                .map(function (k) { return caches.delete(k); }));
        }),
    ]));
});
self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.pathname.startsWith('/api/'))
        return;
    event.respondWith(fetch(event.request).then(function (response) {
        if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
        }
        return response;
    }).catch(function () {
        return caches.match(event.request);
    }));
});
self.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'WAIT_CREATED')
        return;
    var data = msg.data || {};
    var title = msg.notifTitle || 'Turn MCP: New wait task';
    var body = msg.notifBody || (data.sessionId ? 'Session: ' + data.sessionId : '') +
        (data.hasQuestion ? ' (has question)' : '');
    self.registration.showNotification(title, {
        body: body || 'A new wait task has been created.',
        tag: 'turn-mcp-wait',
        renotify: true,
    }).catch(function () { });
});
self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
        for (var i = 0; i < clients.length; i++) {
            if (clients[i].url.indexOf('/') !== -1 && 'focus' in clients[i]) {
                return clients[i].focus();
            }
        }
        if (self.clients.openWindow) {
            return self.clients.openWindow('/');
        }
    }));
});
