self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { }
  e.waitUntil(self.registration.showNotification(d.title || 'Papppy Stays', { body: d.body || '', icon: d.icon || '/icon-192.png', badge: '/favicon.png', tag: d.tag, data: { url: d.url || '#/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = '/' + (e.notification.data?.url || '#/');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async cs => {
    const c = cs[0];
    if (c) { try { await c.focus(); await c.navigate(url); return; } catch { } }
    return self.clients.openWindow(url);
  }));
});
