import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';

const source = await Bun.file('public/sw.js').text();
function worker(windows: { url: string; postMessage: (message: unknown) => void; focus: () => Promise<void> }[] = [], userAgent = 'Android') {
  const handlers = new Map<string, (event: unknown) => void>();
  const notifications: { title: string; options: { tag: string; data: { url: string } } }[] = [];
  const opened: string[] = [];
  let skipped = false, claimed = false;
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    registration: { showNotification: async (title: string, options: typeof notifications[number]['options']) => { notifications.push({ title, options }); } },
    location: { origin: 'https://printhive.test' },
    navigator: { userAgent },
    skipWaiting: async () => { skipped = true; },
    clients: { claim: async () => { claimed = true; }, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
  };
  runInNewContext(source, { self, URL });
  async function dispatch(type: string, event: object) {
    let pending: Promise<unknown> | undefined;
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { handlers, notifications, opened, dispatch, activated: () => skipped && claimed };
}

test('worker displays persistent alerts with stable tags and only opens the operator queue', async () => {
  const messages: unknown[] = [];
  const instance = worker([{ url: 'https://printhive.test/operator', postMessage: message => messages.push(message), focus: async () => {} }]);
  await instance.dispatch('push', { data: { json: () => ({ eventId: 'batch-1', title: 'Robot arm', body: '2 files · student@purdue.edu', url: 'https://evil.test' }) } });
  expect(instance.notifications[0]).toMatchObject({ title: 'Robot arm', options: { body: '2 files · student@purdue.edu', tag: 'printhive-batch-1', renotify: false, data: { url: '/operator' } } });
  expect(instance.notifications[0].options).not.toHaveProperty('icon');
  expect(instance.notifications[0].options).toHaveProperty('badge', '/icons/badge-96.png');
  expect(messages).toEqual([{ type: 'printhive:queue-updated' }]);
  expect(instance.handlers.has('fetch')).toBe(false);
});

test('worker shows a safe notification even for invalid or empty payloads', async () => {
  const instance = worker();
  for (const data of [undefined, { json: () => null }, { json: () => { throw new Error(); } }]) await instance.dispatch('push', { data });
  expect(instance.notifications).toHaveLength(3);
  expect(instance.notifications.every(notification => notification.title.includes('PrintHive'))).toBe(true);
});

test('worker uses the model thumbnail as its icon and ignores unrelated image addresses', async () => {
  const instance = worker();
  const thumbnail = '/api/print-thumbnails/12345678-1234-1234-1234-123456789abc?token=encrypted-capability';
  await instance.dispatch('push', { data: { json: () => ({ thumbnail }) } });
  expect(instance.notifications[0].options).toHaveProperty('icon', 'https://printhive.test' + thumbnail);
  expect(instance.notifications[0].options).not.toHaveProperty('image');
  for (const thumbnail of ['https://evil.test/image.png', '//evil.test/image.png', '/api/print-thumbnails/id', '/icons/app-192.png']) {
    await instance.dispatch('push', { data: { json: () => ({ thumbnail }) } });
    expect(instance.notifications.at(-1)!.options).not.toHaveProperty('icon');
  }
});

test('worker updates take effect with existing app windows open', async () => {
  const instance = worker();
  await instance.dispatch('install', {});
  await instance.dispatch('activate', {});
  expect(instance.activated()).toBe(true);
  expect(instance.handlers.has('fetch')).toBe(false);
});

test('Windows receives the same small model image in the notification picture area', async () => {
  const instance = worker([], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  const thumbnail = '/api/print-thumbnails/12345678-1234-1234-1234-123456789abc?token=encrypted-capability';
  await instance.dispatch('push', { data: { json: () => ({ thumbnail }) } });
  expect(instance.notifications[0].options).toHaveProperty('image', 'https://printhive.test' + thumbnail);
});

test('click focuses an operator queue without navigating away from another edit page', async () => {
  let focused = false, closed = false;
  const instance = worker([{ url: 'https://printhive.test/operator', postMessage: () => {}, focus: async () => { focused = true; } }]);
  await instance.dispatch('notificationclick', { notification: { close: () => { closed = true; } } });
  expect(focused && closed).toBe(true); expect(instance.opened).toHaveLength(0);
  const editing = worker([{ url: 'https://printhive.test/operator/jobs/editing', postMessage: () => {}, focus: async () => {} }]);
  await editing.dispatch('notificationclick', { notification: { close: () => {} } });
  expect(editing.opened).toEqual(['/operator']);
});
