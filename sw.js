self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Feldnamen sind verschlüsselt, der Server kennt sie nicht - eine Erinnerung an ein
// bestimmtes Feld kommt deshalb nur mit dessen ID (payload.fieldIds) und einem
// allgemeinen Text. Die App legt auf dem Gerät eine Liste ID → Name plus die passende
// Textvorlage in ihrer Sprache ab (IndexedDB 'logbuch-push', siehe
// saveFieldNamesForPush in logbuch.html); damit wird der Name hier lokal eingesetzt.
// Fehlt die Liste oder eine ID (neues Gerät, gelöschte Browserdaten, gerade erst
// angelegtes Feld), bleibt es beim allgemeinen Text. Genauso bei Erinnerungen an eine
// Gruppe (payload.sectionId, Liste sectionNames + sectionTemplate im selben Eintrag).
function openPushDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('logbuch-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadStoredNames() {
  const db = await openPushDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get('fieldNames');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function personalizedSectionBody(sectionId, fallback) {
  try {
    const stored = await loadStoredNames();
    const name = stored && stored.sectionNames && stored.sectionNames[sectionId];
    if (!name || !stored.sectionTemplate) return fallback;
    return stored.sectionTemplate.replace('{name}', () => name);
  } catch {
    return fallback;
  }
}
async function personalizedBody(fieldIds, fallback) {
  try {
    const stored = await loadStoredNames();
    if (!stored || !stored.template || !stored.names) return fallback;
    const names = fieldIds.map((id) => stored.names[id]);
    if (names.some((n) => !n)) return fallback;
    // Funktion statt String als Ersatz: sonst würden Zeichenfolgen wie "$&" in einem
    // Feldnamen als Ersetzungsmuster interpretiert.
    return stored.template.replace('{names}', () => names.join(', '));
  } catch {
    return fallback;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Logbuch', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Logbuch';
  event.waitUntil((async () => {
    const body = typeof payload.sectionId === 'string'
      ? await personalizedSectionBody(payload.sectionId, payload.body || '')
      : Array.isArray(payload.fieldIds) && payload.fieldIds.length
        ? await personalizedBody(payload.fieldIds, payload.body || '')
        : payload.body || '';
    await self.registration.showNotification(title, {
      body,
      data: { url: payload.url || './logbuch.html' },
    });
  })());
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
