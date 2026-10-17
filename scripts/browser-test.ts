import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startHarness } from '../tests/harness';
import { asciiSTL } from '../tests/fixtures';

const h = await startHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(h.origin);
  await expect(page.getByRole('heading', { name: /Big ideas/ })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/queue-desktop.png', fullPage: true });
  await page.goto(h.origin + '/submit');
  await page.getByLabel('Project / part title').fill('Browser test bracket');
  await page.getByLabel('STL file', { exact: true }).setInputFiles({ name: 'bracket.stl', mimeType: 'application/octet-stream', buffer: Buffer.from(asciiSTL) });
  await expect(page.getByText('10.0 × 10.0 × 0.0 mm')).toBeVisible();
  await expect(page.locator('.preview-viewport canvas')).toBeVisible();
  await page.getByRole('radio', { name: 'yellow' }).check();
  await page.getByLabel('Mirror the part').check();
  await page.getByLabel('Purdue email').fill('browser@purdue.edu');
  await page.screenshot({ path: 'test-results/submit-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox.' })).toBeVisible();
  const link = h.messages[0].match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
  await page.goto(link); await expect(page.getByRole('button', { name: 'Confirm print' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm print' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in the queue.' })).toBeVisible();
  await page.goto(h.origin); await expect(page.getByRole('heading', { name: 'Browser test bracket' })).toBeVisible();
  await page.goto(h.origin + '/operator/login');
  await page.getByLabel('Username').fill('operator'); await page.getByLabel('Password', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Keep the hive moving.' })).toBeVisible();
  await page.getByRole('link', { name: 'Manage Browser test bracket' }).click();
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText('Status saved and notification email accepted for delivery.')).toBeVisible();
  await expect(page.getByText('Current status:')).toContainText('printing');
  h.rejectMail(true);
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText(/Status saved, but the notification email failed/)).toBeVisible();
  await expect(page.getByText('Current status:')).toContainText('completed');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/submit', '/operator']) {
    await page.goto(h.origin + path);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'absolute').map(el => `${el.tagName}.${el.className}: ${Math.round(el.getBoundingClientRect().right)}`).slice(0, 15));
    await page.screenshot({ path: `test-results/mobile-${path.replaceAll('/', '') || 'queue'}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path}: ${overflow.join(', ')}`).toBe(true);
  }
  await page.goto(h.origin + '/submit'); await page.screenshot({ path: 'test-results/submit-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('Browser flow passed: worker/WebGL preview, submit/confirm, operator updates, email warning, and mobile layout.');
} finally { await browser?.close(); await h.close(); }
