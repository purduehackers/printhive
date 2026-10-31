import { chromium, expect } from '@playwright/test';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startHarness } from '../tests/harness';

const h = await startHarness({ push: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['notifications'] });
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  // Exercise real registration and HTTP endpoints with simulated browser permission
  // and push-service enrollment. Headless Chromium cannot validate OS delivery.
  await context.addInitScript(({ origin, keys }) => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    let subscription: PushSubscription | null = null;
    PushManager.prototype.getSubscription = async () => subscription;
    PushManager.prototype.subscribe = async (options) => {
      subscription = {
        endpoint: `${origin}/unused`,
        options,
        unsubscribe: async () => { subscription = null; return true; },
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/browser-test', keys }),
      } as unknown as PushSubscription;
      // Match the endpoint persisted by the server.
      Object.defineProperty(subscription, 'endpoint', { value: 'https://fcm.googleapis.com/fcm/send/browser-test' });
      return subscription;
    };
  }, { origin: h.origin, keys });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const path of ['/api/push', '/api/operator/queue']) expect((await fetch(h.origin + path)).status).toBe(401);
  expect((await fetch(h.origin + '/api/push/test', { method: 'POST', headers: { Origin: h.origin } })).status).toBe(401);
  const login = await context.request.post(h.origin + '/api/login', {
    headers: { Origin: h.origin }, data: { username: 'operator', password: 'test-password-12345' },
  });
  expect(login.status()).toBe(200);
  expect((await context.request.post(h.origin + '/api/push', { headers: { Origin: 'https://evil.test' }, data: {} })).status()).toBe(403);
  expect((await context.request.post(h.origin + '/api/push', { headers: { Origin: h.origin }, data: { endpoint: 'http://localhost/private', keys } })).status()).toBe(400);
  await page.goto(h.origin + '/operator');
  await expect(page.getByText('Install on Android', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Get a notification when confirmed prints join the queue. Enable each device separately.')).toHaveCount(0);
  const pagination = await page.locator('.pagination').boundingBox();
  const alerts = await page.locator('.operator-notifications').boundingBox();
  expect(alerts!.y).toBeGreaterThan(pagination!.y + pagination!.height);
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeEnabled({ timeout: 10000 }).catch(async error => {
    console.log('Notification panel:', await page.locator('.operator-notifications').innerText());
    console.log('Browser errors:', errors);
    console.log('Browser support:', await page.evaluate(() => ({ secure: isSecureContext, serviceWorker: 'serviceWorker' in navigator, push: 'PushManager' in window, notification: 'Notification' in window })));
    throw error;
  });
  expect(await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/')))).toBe(true);
  const manifest = await (await fetch(h.origin + '/manifest.webmanifest')).json();
  expect(manifest.start_url).toBe('/operator');
  expect(manifest.theme_color).toBe('#f7f7ef');
  expect(manifest.background_color).toBe('#f7f7ef');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f7f7ef');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  for (const icon of manifest.icons) expect((await fetch(h.origin + icon.src)).status).toBe(200);

  // Replacing an already active worker must not leave the new push implementation waiting for every tab to close.
  const oldWorker = `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('message', event => event.ports[0]?.postMessage('old-worker'));`;
  let upgradeSource = oldWorker;
  const upgradeServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(
    new URL(request.url).pathname === '/sw.js' ? upgradeSource : '<!doctype html><title>Worker update check</title>',
    { headers: { 'Content-Type': new URL(request.url).pathname === '/sw.js' ? 'application/javascript' : 'text/html', 'Cache-Control': 'no-store' } },
  ) });
  const upgradePage = await context.newPage();
  try {
    await upgradePage.goto(`http://127.0.0.1:${upgradeServer.port}/`);
    await upgradePage.evaluate(async () => { await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); await navigator.serviceWorker.ready; });
    await expect.poll(() => upgradePage.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration('/'))!;
      return new Promise<string>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolve(event.data);
        registration.active!.postMessage('version', [channel.port2]);
        setTimeout(() => resolve('not-old'), 200);
      });
    })).toBe('old-worker');
    upgradeSource = await Bun.file('public/sw.js').text();
    await upgradePage.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); });
    await expect.poll(() => upgradePage.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration('/'))!;
      return registration.waiting === null && registration.installing === null && registration.active?.state === 'activated';
    })).toBe(true);
  } finally { await upgradePage.close(); upgradeServer.stop(true); }

  await page.evaluate(() => {
    const subscribe = PushManager.prototype.subscribe;
    let failed = false;
    PushManager.prototype.subscribe = async function (options) {
      if (!failed) { failed = true; throw new DOMException('Registration failed - push service error', 'AbortError'); }
      return subscribe.call(this, options);
    };
  });
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('alert')).toContainText('Your browser could not register with its push service.');
  expect((await (await context.request.get(h.origin + '/api/push')).json()).enabled).toBe(false);
  // Retrying after a browser/provider failure must still allow enrollment.
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByText('Notifications enabled.', { exact: true })).toBeVisible();
  expect((await (await context.request.get(h.origin + '/api/push')).json()).enabled).toBe(true);
  await page.route('**/api/push/test', route => route.fulfill({ json: { accepted: true } }));
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test sent.')).toBeVisible();
  await page.getByRole('button', { name: 'Disable notifications' }).click();
  await expect(page.getByText('Notifications disabled.')).toBeVisible();
  expect((await (await context.request.get(h.origin + '/api/push')).json()).enabled).toBe(false);

  // A queue change is detected without requiring notification permission.
  const snapshot = await (await context.request.get(h.origin + '/api/operator/queue')).json();
  await page.route('**/api/operator/queue?*', route => route.fulfill({ json: { ...snapshot, revision: 'new-print-arrived' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Refresh queue' })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/operator-notifications-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Install on Android', { exact: true })).toHaveCount(0);
  const mobilePagination = await page.locator('.pagination').boundingBox();
  const mobileAlerts = await page.locator('.operator-notifications').boundingBox();
  expect(mobileAlerts!.y).toBeGreaterThan(mobilePagination!.y + mobilePagination!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/operator-notifications-mobile.png', fullPage: true });

  await page.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeDisabled();
  await expect(page.getByText(/Notifications are blocked/)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeEnabled();

  // Signing out also revokes this device when a subscription is enabled.
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('button', { name: 'Disable notifications' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(h.origin + '/operator/login');
  expect(errors).toEqual([]);
  console.log('Notification browser/HTTP checks passed: permission flow, registration, subscription, test UI, disable, logout, access controls, queue updates, icons and mobile layout.');
} finally { await browser?.close(); await h.close(); }
