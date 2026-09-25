self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Logbuch', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Logbuch';
  const options = {
    body: payload.body || '',
    data: { url: payload.url || './logbuch.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Die URL einer Benachrichtigung trägt ihr Ziel (?view=...&date=..., siehe
// send-notifications). Ist die App schon offen, wird sie nur nach vorne geholt und
// per postMessage zum Ziel geschickt (kein Neuladen - das würde ggf. ein erneutes
// Entsperren des Verschlüsselungs-Schlüssels erzwingen), sonst mit dieser URL geöffnet.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : './logbuch.html';
  const targetUrl = new URL(rawUrl, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if (client.url.includes('logbuch.html') && 'focus' in client) {
          const focused = await client.focus();
          (focused || client).postMessage({ type: 'logbuch-navigate', url: targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
