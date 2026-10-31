// Push only: operator pages, uploads and preview assets are never cached here.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data?.json() ?? {}; } catch { /* Show a safe fallback. */ }
  if (!message || typeof message !== 'object') message = {};
  const eventId = typeof message.eventId === 'string' ? message.eventId.slice(0, 80) : 'queue';
  // Only our scoped, encrypted thumbnail links may supply notification artwork.
  const thumbnail = typeof message.thumbnail === 'string' &&
    /^\/api\/print-thumbnails\/[a-f0-9-]{36}\?token=[A-Za-z0-9_-]{1,2048}$/.test(message.thumbnail) ? message.thumbnail : null;
  const artwork = thumbnail ? new URL(thumbnail, self.location.origin).href : null;
  event.waitUntil((async () => {
    await self.registration.showNotification(
      typeof message.title === 'string' ? message.title.slice(0, 200) : 'PrintHive: new prints available',
      {
        body: typeof message.body === 'string' ? message.body.slice(0, 350) : 'Open the operator queue to review prints.',
        badge: '/icons/badge-96.png',
        ...(artwork ? { icon: artwork } : {}),
        // Windows owns the app icon slot; its picture area makes the model visible too.
        ...(artwork && /Windows/.test(self.navigator?.userAgent ?? '') ? { image: artwork } : {}),
        tag: `printhive-${eventId}`,
        renotify: false,
        data: { url: '/operator' },
      },
    );
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'printhive:queue-updated' });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const operator = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname === '/operator';
    });
    if (operator) {
      operator.postMessage({ type: 'printhive:queue-updated' });
      await operator.focus();
    } else await self.clients.openWindow('/operator');
  })());
});
