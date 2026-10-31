import { chromium, expect, type BrowserContext } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from '../tests/harness';
import { asciiSTL, submission, thumbnailPNG } from '../tests/fixtures';

// Opt-in integration test: an installed browser enrolls with its real push
// provider. No Notification, PushManager, service-worker or transport mocks.
const channel = process.env.PUSH_BROWSER_CHANNEL ?? 'chrome';
if (!['chrome', 'msedge'].includes(channel)) throw new Error('Choose PUSH_BROWSER_CHANNEL=chrome or msedge.');
const profile = await mkdtemp(join(tmpdir(), 'printhive-live-push-'));
const h = await startHarness({ push: true });
let context: BrowserContext | undefined;
let operatorPage: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
const report: Record<string, unknown> = { browser: channel, simulatedPush: false, checks: [] as string[] };
const checks = report.checks as string[];
await mkdir('test-results', { recursive: true });

async function notifications() {
  for (const worker of context?.serviceWorkers() ?? []) {
    if (worker.url() !== h.origin + '/sw.js') continue;
    try {
      return await worker.evaluate(async () => {
        const scope = globalThis as unknown as { registration: ServiceWorkerRegistration };
        return (await scope.registration.getNotifications()).map(notification => ({ title: notification.title, body: notification.body, tag: notification.tag, icon: notification.icon, image: (notification as Notification & { image?: string }).image ?? '' }));
      });
    } catch { /* Chrome can stop an idle worker; inspect its next instance. */ }
  }
  return [];
}

async function confirmLatest() {
  const url = h.messages.at(-1)?.match(/http[^\s]+\/confirm\?token=[^\s]+/)?.[0];
  if (!url) throw new Error('The isolated mail inbox did not receive confirmation.');
  const token = new URL(url).searchParams.get('token')!;
  const response = await context!.request.post(h.origin + '/confirm', { headers: { Origin: h.origin }, form: { token } });
  expect(response.status()).toBe(200);
  return token;
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel, headless: false, viewport: { width: 1100, height: 850 },
    // Let the real browser contact its push provider. Playwright normally turns
    // background networking off, which is unsuitable for this integration test.
    ignoreDefaultArgs: ['--disable-background-networking'],
    permissions: ['notifications'],
  });
  const login = await context.request.post(h.origin + '/api/login', {
    headers: { Origin: h.origin }, data: { username: 'operator', password: 'test-password-12345' },
  });
  expect(login.status()).toBe(200);
  const page = context.pages()[0] ?? await context.newPage();
  operatorPage = page;
  await page.goto(h.origin + '/operator');
  await page.evaluate(() => {
    const state = globalThis as unknown as { receivedPushMessages: number };
    state.receivedPushMessages = 0;
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'printhive:queue-updated') state.receivedPushMessages++;
    });
  });
  const diagnostics = await context.newCDPSession(page);
  const workerErrors: unknown[] = [];
  diagnostics.on('ServiceWorker.workerErrorReported', event => workerErrors.push(event.errorMessage));
  await diagnostics.send('ServiceWorker.enable');
  report.workerErrors = workerErrors;
  report.permission = await page.evaluate(() => Notification.permission);
  expect(report.permission).toBe('granted');
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeEnabled({ timeout: 15000 });
  console.log(`LIVE_PUSH ${channel}: native permission granted; enrolling with push provider.`);
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect.poll(async () => {
    if (await page.getByRole('alert').isVisible()) throw new Error(await page.getByRole('alert').innerText());
    return page.getByRole('button', { name: 'Send test' }).isVisible();
  }, { timeout: 90000 }).toBe(true);
  const settings = await (await context.request.get(h.origin + '/api/push')).json();
  expect(settings.enabled).toBe(true);
  report.pushProvider = new URL(settings.endpoint).hostname;
  checks.push('native push-service enrollment');
  console.log(`LIVE_PUSH ${channel}: enrolled with ${report.pushProvider}.`);

  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText('Test sent.')).toBeVisible({ timeout: 15000 });
  console.log(`LIVE_PUSH ${channel}: provider accepted test; awaiting browser delivery.`);
  await expect.poll(async () => {
    report.receivedPushMessages = await page.evaluate(() => (globalThis as unknown as { receivedPushMessages: number }).receivedPushMessages);
    report.activeWorkers = context!.serviceWorkers().map(worker => worker.url());
    report.lastNotifications = await notifications();
    return (report.lastNotifications as { title: string }[]).some(item => item.title === 'PrintHive notifications enabled');
  }, { timeout: 45000, intervals: [500, 1000, 2000] }).toBe(true);
  checks.push('real encrypted push received and persistent test notification created');
  console.log(`LIVE_PUSH ${channel}: real test notification received.`);
  await page.screenshot({ path: `test-results/push-live-${channel}.png` });

  // Keep Chrome itself running while every PrintHive tab is closed.
  const keeper = await context.newPage(); await keeper.goto('about:blank');
  await page.close();
  expect(context.pages().every(tab => !tab.url().startsWith(h.origin))).toBe(true);

  const reservedResponse = await context.request.post(h.origin + '/api/submissions', {
    headers: { Origin: h.origin }, data: submission({ title: 'Live background notification test' }),
  });
  expect(reservedResponse.status()).toBe(201);
  const reserved = await reservedResponse.json();
  expect((await context.request.put(`${h.origin}/api/submissions/${reserved.id}/thumbnail`, {
    headers: { Origin: h.origin, Authorization: `Bearer ${reserved.capability}`, 'Content-Type': 'image/png' }, data: thumbnailPNG(),
  })).status()).toBe(200);
  const uploaded = await context.request.put(`${h.origin}/api/submissions/${reserved.id}/file`, {
    headers: { Origin: h.origin, Authorization: `Bearer ${reserved.capability}`, 'Content-Type': 'application/octet-stream' }, data: asciiSTL,
  });
  expect(uploaded.status()).toBe(200);
  const token = await confirmLatest();
  await expect.poll(async () => (await notifications()).some(item => item.title === 'Live background notification test' && item.body === '1 file · test@purdue.edu'),
    { timeout: 90000, intervals: [500, 1000, 2000] }).toBe(true);
  checks.push('confirmed print delivered with all PrintHive tabs closed');
  const preview = (await notifications()).find(item => item.title === 'Live background notification test')!;
  expect(new URL(preview.icon).pathname).toBe(`/api/print-thumbnails/${reserved.id}`);
  if (process.platform === 'win32') expect(preview.image).toBe(preview.icon);
  const artwork = await fetch(preview.icon);
  expect(artwork.status).toBe(200); expect((await artwork.arrayBuffer()).byteLength).toBe(thumbnailPNG().length);
  checks.push('model thumbnail attached to the real notification and fetched without session cookies');
  console.log(`LIVE_PUSH ${channel}: background print notification received with PrintHive tab closed.`);

  const batchResponse = await context.request.post(h.origin + '/api/submissions/batch', {
    headers: { Origin: h.origin }, data: {
      title: 'Live batch notification test', email: 'batch@purdue.edu',
      items: ['left.stl', 'right.stl'].map(original_filename => ({ original_filename, file_size: new Blob([asciiSTL]).size })),
    },
  });
  expect(batchResponse.status()).toBe(201);
  const batch = await batchResponse.json();
  for (const item of batch.items) {
    const uploaded = await context.request.put(`${h.origin}/api/submissions/${item.id}/file?batch=1`, {
      headers: { Origin: h.origin, Authorization: `Bearer ${item.capability}`, 'Content-Type': 'application/octet-stream' }, data: asciiSTL,
    });
    expect(uploaded.status()).toBe(200);
  }
  const finalized = await context.request.post(h.origin + '/api/submissions/batch/finalize', {
    headers: { Origin: h.origin, Authorization: `Bearer ${batch.batchToken}` },
  });
  expect(finalized.status()).toBe(200);
  const batchToken = await confirmLatest();
  await expect.poll(async () => (await notifications()).filter(item => item.title === 'Live batch notification test' && item.body === '2 files · batch@purdue.edu').length,
    { timeout: 90000, intervals: [500, 1000, 2000] }).toBe(1);
  checks.push('two-print batch produced one real background notification');
  const beforeReplay = (await notifications()).map(item => item.tag).sort();
  for (const confirmationToken of [token, batchToken]) {
    expect((await context.request.post(h.origin + '/confirm', { headers: { Origin: h.origin }, form: { token: confirmationToken } })).status()).toBe(200);
  }
  await new Promise(resolve => setTimeout(resolve, 4000));
  expect((await notifications()).map(item => item.tag).sort()).toEqual(beforeReplay);
  checks.push('confirmation replay produced no additional notification');
  report.notifications = (await notifications()).map(item => ({ ...item, icon: item.icon ? new URL(item.icon).pathname : '', image: item.image ? new URL(item.image).pathname : '' })); report.passed = true;
  console.log(`LIVE_PUSH ${channel}: PASS — ${checks.join('; ')}.`);
  const hold = Math.min(30000, Math.max(0, Number(process.env.PUSH_TEST_HOLD_MS) || 0));
  if (hold) await new Promise(resolve => setTimeout(resolve, hold));
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message.slice(0, 2500) : 'Unknown failure';
  if (operatorPage && !operatorPage.isClosed()) {
    report.localDisplayProbe = await operatorPage.evaluate(async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification('PrintHive local display diagnostic', { tag: 'local-display-probe' });
        return { displayed: true, notifications: (await registration.getNotifications()).map(item => ({ title: item.title, tag: item.tag })) };
      } catch (cause) { return { displayed: false, error: String(cause) }; }
    }).catch(() => ({ unavailable: true }));
    await operatorPage.screenshot({ path: `test-results/push-live-${channel}-failure.png` }).catch(() => {});
  }
  if (context) {
    const diagnosticPage = await context.newPage().catch(() => null);
    if (diagnosticPage) {
      await diagnosticPage.goto(channel === 'chrome' ? 'chrome://gcm-internals' : 'edge://push-internals').catch(() => {});
      const diagnostics = await diagnosticPage.locator('body').innerText().catch(() => 'unavailable');
      report.browserPushDiagnostics = diagnostics.replace(/https?:\/\/[^\s]+/g, '[URL omitted]').replace(/[A-Za-z0-9_\-:]{32,}/g, '[identifier omitted]').slice(0, 16000);
    }
  }
  throw error;
} finally {
  // Revoke test subscriptions without touching an existing browser profile.
  if (context) {
    await context.request.delete(h.origin + '/api/push', { headers: { Origin: h.origin } }).catch(() => {});
    for (const worker of context.serviceWorkers()) {
      await worker.evaluate(async () => {
        const scope = globalThis as unknown as { registration: ServiceWorkerRegistration };
        const subscription = await scope.registration.pushManager.getSubscription();
        await subscription?.unsubscribe();
        for (const notification of await scope.registration.getNotifications()) notification.close();
      }).catch(() => {});
    }
    await context.close();
  }
  await writeFile(`test-results/push-live-${channel}.json`, JSON.stringify(report, null, 2));
  await h.close(); await rm(profile, { recursive: true, force: true });
}
