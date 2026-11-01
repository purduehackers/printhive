import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startHarness } from '../tests/harness';
import { asciiSTL } from '../tests/fixtures';

const h = await startHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const headers = { Origin: h.origin, 'Content-Type': 'application/json' };
async function seed(parts: string[]) {
  const response = await fetch(h.origin + '/api/submissions/batch', {
    method: 'POST', headers, body: JSON.stringify({
      title: 'Robot', email: 'maker@purdue.edu',
      items: parts.map((part, index) => ({ original_filename: `${part}.stl`, file_size: new Blob([asciiSTL]).size, copies: index + 1 })),
    }),
  });
  expect(response.status).toBe(201);
  const group = await response.json();
  for (const item of group.items) {
    expect((await fetch(`${h.origin}/api/submissions/${item.id}/file?batch=1`, {
      method: 'PUT', headers: { Origin: h.origin, Authorization: `Bearer ${item.capability}` }, body: asciiSTL,
    })).ok).toBe(true);
  }
  expect((await fetch(h.origin + '/api/submissions/batch/finalize', {
    method: 'POST', headers: { Origin: h.origin, Authorization: `Bearer ${group.batchToken}` },
  })).ok).toBe(true);
  const token = new URL(h.messages.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0]).searchParams.get('token')!;
  expect((await fetch(h.origin + '/confirm', {
    method: 'POST', headers: { Origin: h.origin }, body: new URLSearchParams({ token }),
  })).ok).toBe(true);
}

try {
  await seed(['part-1', 'part-10']);
  await seed(['part-2', 'part-3']);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(h.origin + '/operator/login');
  await page.getByLabel('Username').fill('operator');
  await page.getByLabel('Password', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Print jobs', exact: true })).toBeVisible();
  const names = () => page.locator('.operator-print-row .job-title').allTextContents();
  const queueOrder = await names();
  const row = (part: string) => page.locator('.operator-print-row').filter({ has: page.getByRole('link', { name: `Robot · ${part}`, exact: true }) });
  const count = (number: number) => expect(page.locator('.operator-print-row.selected-row')).toHaveCount(number);
  await page.getByLabel('Sort by:').selectOption('title');
  expect(await names()).toEqual(['Robot · part-1', 'Robot · part-2', 'Robot · part-3', 'Robot · part-10']);
  await row('part-1').locator('td').nth(3).click();
  await row('part-10').getByRole('checkbox').click({ modifiers: ['Shift'] });
  await count(4);
  await row('part-2').locator('td').nth(3).click({ modifiers: ['Control'] });
  await count(3);
  await row('part-2').getByRole('link').click({ modifiers: ['Meta'] });
  await count(4);
  await row('part-3').getByRole('checkbox').click({ modifiers: ['Shift'] });
  await count(2);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await count(0);
  await page.getByRole('button', { name: 'Reverse sort order', exact: true }).click();
  expect(await names()).toEqual(['Robot · part-10', 'Robot · part-3', 'Robot · part-2', 'Robot · part-1']);
  await row('part-10').locator('td').nth(3).click();
  await row('part-2').locator('td').nth(3).click({ modifiers: ['Shift'] });
  await count(3);
  await expect(row('part-1')).not.toHaveClass(/selected-row/);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByLabel('Group by:').selectOption('batch');
  await expect(page.locator('.group-header-row')).toHaveCount(2);
  expect(new Set(await page.locator('.operator-group-selection>span').allTextContents()).size).toBe(2);
  const groupCheckboxes = page.getByRole('checkbox', { name: /^Select group/ });
  await groupCheckboxes.first().check();
  await count(2);
  await page.locator('.operator-print-row').first().getByRole('checkbox').uncheck();
  await count(1);
  await expect(groupCheckboxes.first()).toHaveJSProperty('indeterminate', true);
  await groupCheckboxes.first().check();
  await count(2);
  await groupCheckboxes.last().check();
  await count(4);
  await groupCheckboxes.first().uncheck();
  await count(2);
  await expect(groupCheckboxes.last()).toBeChecked();
  await expect(page.getByRole('button', { name: /Download group STLs|Deselect group|Select group|Update group status/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByLabel('Group by:').selectOption('none');
  await page.getByLabel('Sort by:').selectOption('queue');
  expect(await names()).toEqual(queueOrder);

  const badge = (part: string) => row(part).getByRole('combobox', { name: /^Change status of/ });
  await row('part-1').getByRole('checkbox').check();
  await row('part-10').getByRole('checkbox').check();
  await expect(badge('part-1').locator('option[value="completed"]')).toHaveCount(0);
  await badge('part-1').selectOption('printing');
  await expect(badge('part-1')).toHaveValue('printing');
  await expect(badge('part-10')).toHaveValue('printing');
  await expect(badge('part-2')).toHaveValue('queued');
  await count(2);
  await expect(page.getByLabel('New status for selected prints')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await row('part-1').getByRole('checkbox').check();
  await row('part-2').getByRole('checkbox').check();
  await badge('part-1').selectOption('completed');
  await expect(badge('part-1')).toHaveValue('completed');
  await expect(badge('part-2')).toHaveValue('queued');
  await badge('part-3').selectOption('canceled');
  await expect(badge('part-3')).toHaveValue('canceled');
  await expect(badge('part-1')).toHaveValue('completed');
  await expect(badge('part-2')).toHaveValue('queued');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await row('part-2').getByRole('checkbox').check();
  await badge('part-2').selectOption('rejected');
  const returnDialog = page.getByRole('dialog', { name: 'Return print', exact: true });
  await expect(returnDialog).toBeVisible();
  await returnDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(returnDialog).toBeHidden();
  await expect(badge('part-2')).toHaveValue('queued');
  await badge('part-2').selectOption('rejected');
  await expect(returnDialog.getByRole('button', { name: 'Reject and return', exact: true })).toBeDisabled();
  await returnDialog.getByLabel('Feedback for submitter', { exact: true }).fill('Please thicken the walls.');
  await page.setViewportSize({ width: 390, height: 844 });
  await returnDialog.screenshot({ path: 'test-results/status-return-dialog-mobile.png' });
  expect((await returnDialog.boundingBox())!.width).toBeLessThan(390);
  await returnDialog.getByRole('button', { name: 'Reject and return', exact: true }).click();
  await expect(returnDialog).toBeHidden();
  await expect(badge('part-2')).toHaveValue('rejected');
  await expect(badge('part-3')).toHaveValue('canceled');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Group by:').selectOption('batch');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/list-operations-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Sort by:').selectOption('copies');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/list-operations-mobile.png', fullPage: true });

  await page.goto(h.origin + '/submit');
  await page.getByLabel('STL file', { exact: true }).setInputFiles(['a', 'b', 'c', 'd'].map(name => ({
    name: `${name}.stl`, mimeType: 'application/octet-stream', buffer: Buffer.from(asciiSTL),
  })));
  const file = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}\\.stl`) });
  await file('d').click({ modifiers: ['Shift'] });
  await expect(page.locator('.batch-file-select[aria-pressed=true]')).toHaveCount(1);
  await expect(file('d')).toHaveAttribute('aria-pressed', 'true');
  await file('b').click({ modifiers: ['Control'] });
  await expect(page.locator('.batch-file-select[aria-pressed=true]')).toHaveCount(1);
  await expect(file('b')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Selected file options' })).toContainText('b.stl');
  await expect(page.getByRole('button', { name: /Remove \d+ selected/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove a.stl', exact: true }).click();
  await expect(page.locator('.batch-file-list li')).toHaveCount(3);
  await expect(file('b')).toBeVisible();
  await expect(file('b')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/list-files-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
  console.log('List operations passed: sorting, submission identity, queue modifier selection, status scope and updates, single-file editing, and mobile layout.');
} finally {
  await browser?.close();
  await h.close();
}
