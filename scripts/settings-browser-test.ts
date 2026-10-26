import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarness } from '../tests/harness';
import { parseSTL } from '../src/lib/stl';

const h = await startHarness();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const writes: string[] = [];
  const uploaded: string[] = [];
  let submitted:
    | { items: Array<{ infill: number; copies: number; supports: string }> }
    | undefined;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      writes.push(request.url());
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/submissions/batch')
    )
      submitted = request.postDataJSON();
    if (request.method() === 'PUT')
      uploaded.push(request.url().match(/submissions\/([^/]+)\/file/)![1]);
  });
  // Observe real worker requests without replacing either computation or its output.
  await page.addInitScript(() => {
    const state = window as unknown as { fastTasks: number };
    state.fastTasks = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message?.operation === 'fast_shapes') state.fastTasks++;
      return Reflect.apply(
        original,
        this,
        options === undefined ? [message] : [message, options],
      );
    };
  });
  const tasks = () =>
    page.evaluate(() => (window as unknown as { fastTasks: number }).fastTasks);
  const setting = (name: string) =>
    page.getByRole('combobox', { name, exact: true });
  const ready = () =>
    expect(page.locator('.print-time strong')).toHaveText(/About|Under/, {
      timeout: 45000,
    });
  const choose = async (name: string) => {
    await page
      .getByRole('button', { name: new RegExp(`^${name}\\.stl`) })
      .click();
    await expect(page.locator('.preview-file')).toContainText(`${name}.stl`);
  };
  await page.goto(h.origin + '/submit');
  await setting('Default infill').selectOption('30');
  await page
    .getByRole('spinbutton', { name: 'Default scale (%)', exact: true })
    .fill('150');
  const buffer = await readFile(
    new URL('../tests/support-bracket.stl', import.meta.url),
  );
  const addFile = (name: string) =>
    page.getByLabel('STL file', { exact: true }).setInputFiles({
      name: `${name}.stl`,
      mimeType: 'application/octet-stream',
      buffer,
    });
  await addFile('first');
  await expect(
    page.getByText('45 × 15 × 36 mm', { exact: true }),
  ).toBeVisible();
  const firstRow = page.locator('.batch-file-list li').first();
  const firstButton = firstRow.getByRole('button', { name: /^first\.stl/ });
  await expect(firstButton).toHaveAttribute('aria-expanded', 'true');
  await expect(
    firstRow.locator('.batch-file-row + .batch-file-options .file-options'),
  ).toBeVisible();
  await firstButton.click();
  await expect(firstButton).toHaveAttribute('aria-expanded', 'false');
  await expect(firstRow.locator('.batch-file-options')).toBeHidden();
  await expect(page.locator('.preview-file')).toContainText('first.stl');
  await firstButton.press('Enter');
  await expect(firstRow.locator('.file-options')).toBeVisible();
  const rowsBox = await page.locator('.batch-file-list').boundingBox();
  const defaultsBox = await page
    .getByRole('group', { name: 'Default settings', exact: true })
    .boundingBox();
  expect(defaultsBox!.y).toBeGreaterThanOrEqual(rowsBox!.y + rowsBox!.height);
  await page.getByText('More settings', { exact: true }).click();
  await expect(setting('Infill')).toHaveValue('');
  await setting('Infill').selectOption('30'); // An explicit override equal to global remains explicit.
  await page
    .getByRole('spinbutton', { name: 'Scale (%)', exact: true })
    .fill('200');
  await setting('Default infill').selectOption('50');
  await page
    .getByRole('spinbutton', { name: 'Default scale (%)', exact: true })
    .fill('125');
  await expect(setting('Infill')).toHaveValue('30');
  await expect(
    page.getByText('60 × 20 × 48 mm', { exact: true }),
  ).toBeVisible();
  await ready();
  await addFile('second'); // A newly added file inherits the latest globals.
  await choose('second');
  await expect(firstRow.locator('.batch-file-options')).toBeHidden();
  await expect(
    page.locator('.batch-file-list li').nth(1).locator('.file-options'),
  ).toBeVisible();
  await expect(setting('Infill')).toHaveValue('');
  await expect(
    page.getByText('37.5 × 12.5 × 30 mm', { exact: true }),
  ).toBeVisible();
  await ready();
  const completed = await tasks();
  await choose('first');
  await expect(
    page.getByText('60 × 20 × 48 mm', { exact: true }),
  ).toBeVisible();
  await ready();
  await page.getByRole('tab', { name: 'Supports', exact: true }).click();
  await expect(
    page.getByRole('slider', { name: 'Layer', exact: true }),
  ).toBeVisible();
  expect(await tasks()).toBe(completed);
  await setting('Supports').selectOption('none');
  const supportsTab = page.getByRole('tab', { name: 'Supports', exact: true });
  await expect(supportsTab).toBeDisabled();
  await expect(supportsTab).toHaveCSS('cursor', 'not-allowed');
  await expect(
    page.getByRole('tab', { name: 'Model', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('slider', { name: 'Layer', exact: true }),
  ).toHaveCount(0);
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/supports-disabled.png' });
  await ready();
  expect(await tasks()).toBe(completed + 1);
  await setting('Supports').selectOption('');
  await ready();
  expect(await tasks()).toBe(completed + 1); // Prior support shapes restored without slicing.
  await expect(supportsTab).toBeEnabled();
  await supportsTab.click();
  await page.getByLabel('Number of copies').selectOption('3');
  expect(await tasks()).toBe(completed + 1);
  await page.getByLabel('Mirror along the X axis').check();
  await ready();
  await page
    .getByRole('button', { name: 'Reset to defaults', exact: true })
    .click();
  await expect(setting('Infill')).toHaveValue('');
  await expect(
    page.getByRole('spinbutton', { name: 'Scale (%)', exact: true }),
  ).toHaveValue('');
  await expect(page.getByLabel('Number of copies')).toHaveValue('3');
  await expect(page.getByLabel('Mirror along the X axis')).toBeChecked();
  await expect(
    page.getByText('37.5 × 12.5 × 30 mm', { exact: true }),
  ).toBeVisible();
  await setting('Infill').selectOption('30');
  await page
    .getByRole('spinbutton', { name: 'Scale (%)', exact: true })
    .fill('200');
  await ready();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({
    path: 'test-results/default-settings-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/default-settings-mobile.png',
    fullPage: true,
  });
  expect(writes).toEqual([]);
  // Invalid settings must reveal their file even when its dropdown is closed
  // or a different file is selected. Native title/email validation still applies.
  await page.getByLabel('Project / part title').fill('Validation recovery');
  await page.getByLabel('Purdue email').fill('settings@purdue.edu');
  await page
    .getByRole('spinbutton', { name: 'Scale (%)', exact: true })
    .fill('0');
  await page.getByRole('button', { name: /^first\.stl/ }).click();
  await expect(page.locator('.file-options')).toBeHidden();
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Enter a scale');
  await expect(
    page.getByRole('spinbutton', { name: 'Scale (%)', exact: true }),
  ).toBeVisible();
  await choose('second');
  await page.getByRole('button', { name: /^second\.stl/ }).click();
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(page.locator('.preview-file')).toContainText('first.stl');
  await expect(
    page.getByRole('spinbutton', { name: 'Scale (%)', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('spinbutton', { name: 'Scale (%)', exact: true })
    .fill('200');
  await page.getByLabel('Project / part title').fill('');
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(page.getByLabel('Project / part title')).toBeFocused();
  await page.getByLabel('Project / part title').fill('Validation recovery');
  await page.getByLabel('Purdue email').fill('settings@example.test');
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(page.getByLabel('Purdue email')).toBeFocused();
  expect(writes).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await page
    .getByLabel('Project / part title')
    .fill('Default and local scale test');
  await page.getByLabel('Purdue email').fill('settings@purdue.edu');
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Check your email', exact: true }),
  ).toBeVisible();
  expect(
    submitted!.items.map(({ infill, copies, supports }) => ({
      infill,
      copies,
      supports,
    })),
  ).toEqual([
    { infill: 30, copies: 3, supports: 'operator' },
    { infill: 50, copies: 1, supports: 'operator' },
  ]);
  expect(uploaded).toHaveLength(2);
  for (const [index, dimensions] of [
    [60, 20, 48],
    [37.5, 12.5, 30],
  ].entries()) {
    const model = await parseSTL(
      new Blob([
        await readFile(join(h.dir, 'files', uploaded[index] + '.stl')),
      ]),
    );
    expect(model.max.map((value, axis) => value - model.min[axis])).toEqual(
      dimensions,
    );
  }
  expect(errors).toEqual([]);
  console.log(
    'Default inheritance, per-field overrides, scale/export, mobile layout and completed file/settings cache reuse passed.',
  );
} finally {
  await browser.close();
  await h.close();
}
