// Loom phone page service worker — notifications only. Nothing is cached:
// the page is always fetched live (a stale app shell would lie about the
// server's job API, and the design itself lives in the page's own storage).
// Registered by app/mobile.js; the push subscription it yields is attached
// to a running guest build (intent/loom-jobs.js), which pings ONCE when the
// build ends, so the guest can leave for another app and come back.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network as usual */ });

const pageUrl = (path) => new URL(path || './mobile.html', self.registration.scope).href;

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Loom', {
    body: d.body || 'Your design is ready.',
    tag: d.tag || 'loom-build',
    renotify: true,
    icon: new URL('./icons/loom-192.png', self.registration.scope).href,
    data: { url: pageUrl(d.page) },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || pageUrl();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.includes('mobile.html'));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
