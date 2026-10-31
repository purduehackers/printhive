import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startHarness } from '../tests/harness';
import { asciiSTL, thumbnailPNG } from '../tests/fixtures';

const h = await startHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const headers = { Origin: h.origin, 'Content-Type': 'application/json' };
const post = (path: string, body: unknown) => fetch(h.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
const queue = async () => (await fetch(h.origin + '/api/queue')).json();
async function submit(title: string, email: string, count = 3) {
  const response = await post('/api/submissions/batch', {
    title, email, color: 'yellow', layer_height: 0.16, infill: 30,
    items: Array.from({ length: count }, (_, index) => ({
      original_filename: ['base.stl', 'grip.stl', 'mount.stl'][index] ?? `part-${index + 1}.stl`, file_size: new Blob([asciiSTL]).size,
    })),
  });
  expect(response.status).toBe(201);
  const group = await response.json();
  const first = group.items[0];
  expect((await fetch(`${h.origin}/api/submissions/${first.id}/thumbnail`, {
    method: 'PUT', headers: { Origin: h.origin, Authorization: `Bearer ${first.capability}`, 'Content-Type': 'image/png' }, body: thumbnailPNG(),
  })).ok).toBe(true);
  for (const item of group.items) {
    const uploaded = await fetch(`${h.origin}/api/submissions/${item.id}/file?batch=1`, {
      method: 'PUT', headers: { Origin: h.origin, Authorization: `Bearer ${item.capability}` }, body: asciiSTL,
    });
    expect(uploaded.ok).toBe(true);
  }
  expect((await fetch(h.origin + '/api/submissions/batch/finalize', {
    method: 'POST', headers: { Origin: h.origin, Authorization: `Bearer ${group.batchToken}` },
  })).ok).toBe(true);
  const url = h.messages.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
  const token = new URL(url).searchParams.get('token')!;
  expect((await fetch(h.origin + '/confirm', { method: 'POST', headers: { Origin: h.origin }, body: new URLSearchParams({ token }) })).ok).toBe(true);
  return group;
}

try {
  const one = await submit('Robot arm', 'maker@purdue.edu');
  await submit('Other submission', 'other@purdue.edu', 10);
  expect((await fetch(h.origin + '/api/cancellations', {
    method: 'POST', headers: { ...headers, Origin: 'https://untrusted.test' }, body: JSON.stringify({ ids: [one.items[0].id], email: 'maker@purdue.edu' }),
  })).status).toBe(403);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(h.origin);
  const queueLayout = () => page.locator('.queue-list>li').evaluateAll(rows => rows.map(row => {
    const bounds = row.getBoundingClientRect();
    const content = row.querySelector('.queue-job')!.getBoundingClientRect();
    const reference = row.querySelector('.mono')!.getBoundingClientRect();
    return [bounds.height, content.x, content.width, reference.x];
  }));
  const defaultDesktopLayout = await queueLayout();
  const entryButtons = page.getByRole('button', { name: 'Cancel prints', exact: true });
  await expect(entryButtons).toHaveCount(2);
  const [topEntry, bottomEntry] = await Promise.all([entryButtons.first().boundingBox(), entryButtons.last().boundingBox()]);
  expect(Math.abs(topEntry!.x + topEntry!.width - bottomEntry!.x - bottomEntry!.width)).toBeLessThan(1);
  await mkdir('test-results', { recursive: true });
  await page.locator('.queue-section-heading').screenshot({ path: 'test-results/cancellation-heading-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const defaultMobileLayout = await queueLayout();
  await page.locator('.queue-section-heading').screenshot({ path: 'test-results/cancellation-heading-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await entryButtons.last().click();
  await expect(page.getByLabel('Submission email', { exact: true })).toHaveCount(1);
  await page.getByLabel('Submission email', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Submission email', { exact: true })).not.toBeFocused();
  await expect(page.locator('.queue-selection-bar')).toHaveClass(/is-docked/);
  await expect(page.getByRole('button', { name: 'Email cancellation link', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Exit selection', exact: true }).click();
  await expect(entryButtons).toHaveCount(2);
  await entryButtons.first().click();
  expect(await queueLayout()).toEqual(defaultDesktopLayout);
  await expect(page.getByText('Ordered by confirmation time', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Submission email', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continue to email', exact: true })).toBeDisabled();
  await expect(page.getByText('Select prints to cancel from one submission.', { exact: true })).toBeVisible();
  const row = (name: string) => page.locator('.queue-list>li').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const firstCheckbox = page.getByRole('checkbox', { name: /Select Robot arm · base/ });
  await row('Robot arm · base').click({ position: { x: 150, y: 28 } });
  const rowPadding = await row('Robot arm · base').evaluate(element => {
    const style = getComputedStyle(element);
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  });
  expect(rowPadding.left).toBeGreaterThanOrEqual(20);
  expect(rowPadding.right).toBeGreaterThanOrEqual(20);
  await expect(firstCheckbox).toBeChecked();
  await row('Robot arm · base').click({ position: { x: 150, y: 28 } });
  await expect(firstCheckbox).not.toBeChecked();
  await row('Robot arm · base').click({ position: { x: 150, y: 28 } });
  await firstCheckbox.focus();
  await firstCheckbox.press('Space');
  await expect(firstCheckbox).not.toBeChecked();
  await firstCheckbox.press('Space');
  await expect(firstCheckbox).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Select Other submission · base/ })).toBeDisabled();
  await row('Other submission · base').click({ position: { x: 150, y: 28 } });
  await expect(page.locator('.queue-cancel-checkbox:checked')).toHaveCount(1);
  await row('Other submission · mount').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Continue to email', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Select whole group', exact: true }).click();
  await expect(page.locator('.queue-cancel-checkbox:checked')).toHaveCount(3);
  await row('Robot arm · mount').click({ position: { x: 150, y: 28 } });
  await expect(page.locator('.queue-cancel-checkbox:checked')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Select Other submission · base/ })).toBeEnabled();
  await row('Robot arm · base').click({ position: { x: 150, y: 28 } });
  await row('Robot arm · grip').click({ position: { x: 150, y: 28 } });
  const desktopBar = (await page.locator('.queue-selection-bar').boundingBox())!;
  const desktopQueue = (await page.locator('.queue-list').boundingBox())!;
  expect(Math.abs(desktopBar.x - desktopQueue.x)).toBeLessThan(1);
  expect(Math.abs(desktopBar.width - desktopQueue.width)).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/cancellation-selection-bar-desktop.png' });
  await page.locator('.queue-cancellation').scrollIntoViewIfNeeded();
  await expect(page.locator('.queue-selection-bar')).toHaveClass(/is-docked/);
  await expect(page.getByRole('button', { name: 'Email cancellation link', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Submission email', { exact: true })).not.toBeFocused();
  await row('Robot arm · grip').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Continue to email', exact: true }).click();
  await expect(page.getByLabel('Submission email', { exact: true })).toBeFocused();
  await expect(page.locator('.queue-cancellation')).toBeInViewport();
  await expect(page.locator('.queue-selection-bar')).toHaveCount(1);
  await expect(page.locator('.queue-selection-bar')).toHaveClass(/is-docked/);
  expect(Math.abs((await page.locator('.queue-cancellation').boundingBox())!.width - desktopBar.width)).toBeLessThan(1);
  expect(await page.locator('.queue-cancellation').evaluate(form =>
    form.getBoundingClientRect().top >= document.querySelector('.queue-list')!.getBoundingClientRect().bottom)).toBe(true);
  await page.getByLabel('Submission email', { exact: true }).fill('other@purdue.edu');
  await page.getByRole('button', { name: 'Email cancellation link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  expect(h.messages).toHaveLength(2);
  await page.getByLabel('Submission email', { exact: true }).fill('maker@purdue.edu');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/cancellation-selection-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await queueLayout()).toEqual(defaultMobileLayout);
  await row('Robot arm · base').tap({ position: { x: 150, y: 28 } });
  await expect(firstCheckbox).not.toBeChecked();
  await expect(page.locator('.queue-selection-count [role=status]')).toHaveText('1 selected');
  await row('Robot arm · base').tap({ position: { x: 150, y: 28 } });
  await expect(firstCheckbox).toBeChecked();
  await row('Other submission · mount').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Continue to email', exact: true })).toBeInViewport();
  await expect(page.getByLabel('Submission email', { exact: true })).toHaveValue('maker@purdue.edu');
  await expect(page.locator('.queue-selection-count [role=status]')).toHaveText('2 selected');
  const mobileBar = (await page.locator('.queue-selection-bar').boundingBox())!;
  const mobileForm = (await page.locator('.queue-cancellation').boundingBox())!;
  expect(Math.abs(mobileBar.x - mobileForm.x)).toBeLessThan(1);
  expect(Math.abs(mobileBar.width - mobileForm.width)).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/cancellation-controls-mobile.png' });
  await page.screenshot({ path: 'test-results/cancellation-selection-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Continue to email', exact: true }).click();
  await expect(page.getByLabel('Submission email', { exact: true })).toBeFocused();
  await expect(page.locator('.queue-selection-bar')).toHaveCount(1);
  await expect(page.locator('.queue-selection-bar')).toHaveClass(/is-docked/);
  await expect(page.locator('.queue-selection-count [role=status]')).toHaveText('Cancel 2 prints');
  await expect(page.getByRole('button', { name: 'Continue to email', exact: true })).toHaveCount(0);
  const [dockedBar, formBody] = await Promise.all([page.locator('.queue-selection-bar').boundingBox(), page.locator('.queue-cancellation').boundingBox()]);
  expect(Math.abs(dockedBar!.y + dockedBar!.height - formBody!.y)).toBeLessThan(1);
  await expect(page.getByRole('button', { name: 'Email cancellation link', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/cancellation-email-mobile.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Email cancellation link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Check your email' })).toBeInViewport();
  expect(h.messages).toHaveLength(3);
  const cancelUrl = h.messages.at(-1)!.match(/http[^\s]+\/cancel\?token=[^\s]+/)![0];
  expect(h.messages.at(-1)).not.toContain(one.items[2].title);
  expect((await queue()).filter((job: { status: string }) => job.status === 'queued')).toHaveLength(13);
  await h.restart();
  await page.goto(cancelUrl);
  await expect(page.getByRole('heading', { name: 'Confirm cancellation', exact: true })).toBeVisible();
  await expect(page.locator('.batch-confirm-list li')).toHaveCount(2);
  const preview = page.locator('.cancel-preview-list');
  const previewWithThumbnail = preview.locator('li').filter({ hasText: 'Robot arm · base' });
  const previewWithoutThumbnail = preview.locator('li').filter({ hasText: 'Robot arm · grip' });
  await expect(preview.locator('.cancel-preview-settings').first()).toContainText('PLA · yellow');
  await expect(preview.locator('.cancel-preview-settings').first()).toContainText('0.16 mm layer');
  await expect(preview.locator('.cancel-preview-settings').first()).toContainText('30% infill');
  await expect(preview.locator('img')).toHaveCount(1);
  await expect.poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(128);
  await expect(previewWithoutThumbnail.locator('.cancel-preview-placeholder')).toBeVisible();
  const thumbnailSrc = (await preview.locator('img').getAttribute('src'))!;
  expect((await fetch(h.origin + thumbnailSrc)).status).toBe(200);
  expect((await fetch(h.origin + new URL(thumbnailSrc, h.origin).pathname)).status).toBe(401);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await queue()).filter((job: { status: string }) => job.status === 'queued')).toHaveLength(13);
  await page.screenshot({ path: 'test-results/cancellation-confirm-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/cancellation-confirm-desktop.png', fullPage: true });
  await page.route('**/api/print-thumbnails/**', route => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(preview.locator('img')).toBeHidden();
  await expect(previewWithThumbnail.locator('.cancel-preview-placeholder')).toBeVisible();
  await page.unroute('**/api/print-thumbnails/**');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cancellation confirmed', exact: true })).toBeVisible();
  expect(await queue()).toHaveLength(11);
  await page.getByRole('link', { name: 'View queue', exact: true }).click();
  await expect(page.locator('.queue-list>li')).toHaveCount(11);
  await expect(page.locator('.queue-canceled')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Robot arm · base', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Robot arm · grip', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/cancellation-result-mobile.png', fullPage: true });
  await page.goto(cancelUrl);
  await expect(page.getByRole('heading', { name: 'Cancellation already confirmed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm cancellation', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('Cancellation browser flow passed: row clicks, keyboard selection, submission limits, ownership, email, restart persistence, mobile layout, and removal from the public queue.');
} finally { await browser?.close(); await h.close(); }
