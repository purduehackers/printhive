import { parseSTL } from '../src/lib/stl';
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { startHarness } from '../tests/harness';
import { join } from 'node:path';

const h = await startHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--host-resolver-rules=MAP preview.test 127.0.0.1',
      '--no-proxy-server',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let nativeLoads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/preview-engine/manifest.json')) nativeLoads++;
  });
  await page.goto(h.origin);
  await expect(
    page.getByRole('heading', { name: 'HIVE 3d printing', exact: true }),
  ).toBeVisible();
  const firstPrinterDetails = page.locator('.printer-details').first();
  await expect(firstPrinterDetails).not.toHaveAttribute('open', '');
  await page.getByText('Description & capabilities').first().click();
  await expect(firstPrinterDetails).toHaveAttribute('open', '');
  await expect(
    page.getByText(
      'Large-format dual-nozzle system ideal for multi-material prints',
    ),
  ).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({
    path: 'test-results/queue-desktop.png',
    fullPage: true,
  });
  await page.goto(h.origin + '/submit');
  await page.getByLabel('Project / part title').fill('Browser test bracket');
  await page.getByLabel('STL file', { exact: true }).setInputFiles({
    name: 'bracket.stl',
    mimeType: 'application/octet-stream',
    buffer: await readFile(
      new URL('../tests/support-bracket.stl', import.meta.url),
    ),
  });
  await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
  await expect(page.locator('.preview-viewport canvas')).toBeVisible();
  // Fresh-file calculation must finish without any further click, input, or tab change.
  await expect(page.locator('.print-time strong')).toHaveText(/About|Under/, {
    timeout: 45000,
  });
  await expect(
    page.getByRole('tab', { name: 'Model', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByText('Quick estimate \u00b7 model only'),
  ).toBeVisible();
  expect(nativeLoads).toBe(0);
  await page.getByText('More settings', { exact: true }).click();
  await page.getByRole('radio', { name: 'yellow' }).check();
  await page.getByLabel('Mirror along the X axis').check();
  await page.getByLabel('Number of copies').selectOption('2');
  const previewUploads: string[] = [];
  const trackPreviewUpload = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' || request.method() === 'PUT')
      previewUploads.push(request.url());
  };
  page.on('request', trackPreviewUpload);
  await expect(
    page.getByRole('tab', { name: 'Model', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.preview-file')).toContainText('bracket.stl');
  await expect(page.locator('.print-time')).toContainText('Print time:');
  await expect(page.locator('.print-time strong')).toHaveText(/About|Under/, {
    timeout: 45000,
  });
  await expect(page.locator('.print-time')).toContainText('per copy');
  await expect(page.locator('.preview-bed')).toContainText('Prusa Core ONE+');
  const completedLoads = nativeLoads;
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/background-print-time.png' });
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(page.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  expect(nativeLoads).toBe(completedLoads + 1);
  await expect(page.getByText(/Quick estimate/)).toHaveCount(0);
  const canvas = await page.locator('.preview-viewport canvas').elementHandle();
  await expect(
    page.getByRole('combobox', { name: 'Supports', exact: true }),
  ).toHaveValue('operator');
  await expect(page.locator('.print-time strong')).toHaveText(/About|Under/);
  await expect(
    page.getByRole('button', { name: 'Walls', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Supports', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/triangles|physically calibrated|Model opacity/),
  ).toHaveCount(0);
  await expect(page.locator('.preview-viewport canvas')).toHaveCount(1);
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
  expect(previewUploads).toEqual([]);
  page.off('request', trackPreviewUpload);
  await page.screenshot({
    path: 'test-results/gcode-preview.png',
    fullPage: true,
  });
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/gcode-preview-panel.png' });
  await page.getByRole('slider', { name: 'Layer', exact: true }).press('Home');
  await expect(page.getByText(/Layer 1 \/ \d+/)).toBeVisible();
  await page.getByLabel('Only this layer').check();
  await expect(
    page.getByRole('slider', { name: 'Layer progress', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^(Play|Pause)$/ }),
  ).toHaveCount(0);
  await expect(page.getByText('Preview settings', { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('Only this layer').uncheck();
  await page.getByRole('slider', { name: 'Layer', exact: true }).press('End');
  await page.getByRole('button', { name: 'Walls', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Walls', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: 'Model', exact: true }).click();
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/gcode-preview-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('normal');
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(page.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  await expect(
    page.getByRole('button', { name: 'Supports', exact: true }),
  ).toBeVisible();
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/regular-supports-panel.png' });
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('none');
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(page.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  await expect(
    page.getByRole('button', { name: 'Supports', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Walls', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('operator');
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Auto', exact: true }),
  ).toBeEnabled({ timeout: 90000 });
  await expect(page.getByText('30 × 10 × 24 mm')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Reset orientation', exact: true })
    .click();
  await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
  await page.getByRole('button', { name: 'Lay on face', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Front', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.preview-viewport canvas')).toBeVisible();
  const viewport = await page.locator('.preview-viewport canvas').boundingBox();
  await page.mouse.move(
    viewport!.x + viewport!.width / 2,
    viewport!.y + viewport!.height / 2,
  );
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/orientation-faces-panel.png' });
  await page
    .locator('.preview-viewport canvas')
    .click({ position: { x: viewport!.width / 2, y: viewport!.height / 2 } });
  await expect(
    page.getByText('Click a highlighted face to place it on the bed.'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Reset orientation', exact: true })
    .click();
  await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
  await page.getByRole('button', { name: 'Lay on face', exact: true }).click();
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(page.getByText('30 × 24 × 10 mm')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('normal');
  const uploadedIds: string[] = [];
  let submittedMetadata: Record<string, unknown> = {};
  let submittedBatch: {
    items: {
      copies: number;
      infill: number;
      color: string;
      supports: string;
    }[];
  } = { items: [] };
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().includes('/api/submissions/')
    )
      uploadedIds.push(request.url().match(/submissions\/([^/]+)\/file/)![1]);
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/submissions')
    )
      submittedMetadata = request.postDataJSON();
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/submissions/batch')
    )
      submittedBatch = request.postDataJSON();
  });
  await page.getByLabel('Purdue email').fill('browser@purdue.edu');
  await page.screenshot({
    path: 'test-results/submit-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(
    page.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();
  const uploadedSTL = await readFile(
    join(h.dir, 'files', uploadedIds[0] + '.stl'),
  );
  expect(submittedMetadata).toMatchObject({
    mirror: 0,
    copies: 2,
    supports: 'normal',
    file_size: uploadedSTL.byteLength,
  });
  const submittedInfo = await parseSTL(new Blob([uploadedSTL]));
  expect(submittedInfo.triangles).toBe(24);
  expect(submittedInfo.min[2]).toBe(0);
  expect(
    submittedInfo.max.map((value, i) => value - submittedInfo.min[i]),
  ).toEqual([30, 24, 10]);
  const link = h.messages[0].match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
  await page.goto(link);
  await expect(
    page.getByRole('button', { name: 'Confirm print' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm print' }).click();
  await expect(
    page.getByRole('heading', { name: 'Print queued' }),
  ).toBeVisible();
  await page.goto(h.origin);
  await expect(
    page.getByRole('heading', { name: 'Browser test bracket' }),
  ).toBeVisible();

  // Test batch submission of multiple STL files
  await page.goto(h.origin + '/submit');
  await page.getByLabel('Project / part title').fill('Batch Rover');
  await page.getByLabel('STL file', { exact: true }).setInputFiles([
    {
      name: 'wheel_left.stl',
      mimeType: 'application/octet-stream',
      buffer: await readFile(
        new URL('../tests/support-bracket.stl', import.meta.url),
      ),
    },
    {
      name: 'wheel_right.stl',
      mimeType: 'application/octet-stream',
      buffer: await readFile(
        new URL('../tests/support-bracket.stl', import.meta.url),
      ),
    },
  ]);
  await expect(page.getByText('2 STL files selected')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove wheel_left.stl', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove wheel_right.stl', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
  await page.getByLabel('Number of copies').selectOption('2');
  await page.getByLabel('Mirror along the X axis').check();
  await page.getByText('More settings', { exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Infill', exact: true })
    .selectOption('30');
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('none');
  await page.getByRole('radio', { name: 'red', exact: true }).check();
  await page.getByRole('button', { name: 'Lay on face', exact: true }).click();
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(page.getByText('30 × 24 × 10 mm')).toBeVisible();
  await page.getByRole('button', { name: /^wheel_right\.stl/ }).click();
  await expect(page.locator('.preview-file')).toContainText('wheel_right.stl');
  await expect(page.getByLabel('Number of copies')).toHaveValue('1');
  await expect(page.getByLabel('Mirror along the X axis')).not.toBeChecked();
  await page.getByLabel('Number of copies').selectOption('3');
  await expect(
    page.getByRole('combobox', { name: 'Infill', exact: true }),
  ).toHaveValue('15');
  await expect(
    page.getByRole('radio', { name: 'black', exact: true }),
  ).toBeChecked();
  await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
  await page.getByRole('button', { name: /^wheel_left\.stl/ }).click();
  await expect(page.getByLabel('Number of copies')).toHaveValue('2');
  await expect(page.getByLabel('Mirror along the X axis')).toBeChecked();
  await expect(page.locator('.preview-file')).toContainText('wheel_left.stl');
  await page.screenshot({
    path: 'test-results/per-file-options.png',
    fullPage: true,
  });
  await expect(page.getByText('30 × 24 × 10 mm')).toBeVisible();
  await page.getByLabel('Purdue email').fill('browser@purdue.edu');
  await page.getByRole('button', { name: 'Send confirmation email' }).click();
  await expect(
    page.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();
  expect(submittedBatch.items.map((item) => item.copies)).toEqual([2, 3]);
  expect(
    submittedBatch.items.map((item) => ({
      infill: item.infill,
      color: item.color,
      supports: item.supports,
    })),
  ).toEqual([
    { infill: 30, color: 'red', supports: 'none' },
    { infill: 15, color: 'black', supports: 'operator' },
  ]);
  let firstTriangle: number[] = [];
  const batchLeft = await parseSTL(
    new Blob([await readFile(join(h.dir, 'files', uploadedIds[1] + '.stl'))]),
    (vertices, index) => {
      if (index === 0) firstTriangle = vertices;
    },
  );
  expect(firstTriangle).toEqual([15, 12, 0, 9, 12, 0, 9, 12, 10]);
  expect(batchLeft.max.map((value, i) => value - batchLeft.min[i])).toEqual([
    30, 24, 10,
  ]);
  expect(
    (await readFile(join(h.dir, 'files', uploadedIds[2] + '.stl'))).equals(
      await readFile(new URL('../tests/support-bracket.stl', import.meta.url)),
    ),
  ).toBe(true);
  const batchLink = h.messages[1].match(
    /http[^\s]+\/confirm\?token=[^\s]+/,
  )![0];
  await page.goto(batchLink);
  await expect(
    page.getByRole('button', { name: 'Confirm 2 prints' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm 2 prints' }).click();
  await expect(
    page.getByRole('heading', { name: 'Prints queued' }),
  ).toBeVisible();
  await page.goto(h.origin);
  await expect(
    page.getByRole('heading', { name: 'Batch Rover · wheel_left' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Batch Rover · wheel_right' }),
  ).toBeVisible();
  await page.goto(h.origin + '/operator/login');
  await page.getByLabel('Username').fill('operator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('test-password-12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Print jobs' })).toBeVisible();
  await page.getByRole('link', { name: 'Manage Browser test bracket' }).click();
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(
    page.getByText(
      'Status saved and notification email accepted for delivery.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Current status:')).toContainText('printing');
  h.rejectMail(true);
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(
    page.getByText(/Status saved, but the notification email failed/),
  ).toBeVisible();
  await expect(page.getByText('Current status:')).toContainText('completed');
  h.rejectMail(false);
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText('Current status:')).toContainText('queued');
  await page.getByLabel('New status').selectOption('rejected');
  const returnButton = page.getByRole('button', {
    name: 'Reject and return',
    exact: true,
  });
  await expect(returnButton).toBeDisabled();
  await page.getByLabel('Feedback for submitter').fill('  \n  ');
  await expect(returnButton).toBeDisabled();
  const feedback = 'Please thicken the walls.\nKeep <script> as plain text.';
  await page.getByLabel('Feedback for submitter').fill(feedback);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/return-feedback-mobile.png',
    fullPage: true,
  });
  await returnButton.click();
  await expect(page.getByText('Current status:')).toContainText('rejected');
  await expect(
    page.getByText(
      'Status saved and notification email accepted for delivery.',
    ),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Refresh details' }).click();
  await expect(page.locator('.history .operator-notes')).toHaveText(feedback);
  await page.screenshot({
    path: 'test-results/returned-job-mobile.png',
    fullPage: true,
  });
  await page.goto(h.origin);
  await expect(
    page.getByRole('heading', { name: 'Browser test bracket' }),
  ).toHaveCount(0);
  await page.goto(h.origin + '/operator?status=rejected');
  await expect(
    page.getByRole('link', { name: 'Browser test bracket', exact: true }),
  ).toBeVisible();
  // Test queue selection, custom grouping, and batch status update
  await page.getByLabel('Select Browser test bracket').check();
  await expect(
    page.getByRole('region', { name: 'Group status actions' }),
  ).toBeVisible();
  await expect(page.getByText('1 print selected')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download selected STLs ↓' }),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download selected STLs ↓' }).click();
  const downloadedFile = await downloadPromise;
  expect(downloadedFile.suggestedFilename()).toMatch(
    /^printhive-[A-F0-9]{8}-bracket\.stl$/,
  );

  // Test custom group creation
  await page.getByRole('button', { name: 'Group selected' }).click();
  await page.getByPlaceholder('Group name (e.g. Bed 1)').fill('Bed Alpha');
  await page.getByRole('button', { name: 'Save group' }).click();
  await expect(
    page.locator('.group-badge', { hasText: 'Bed Alpha' }),
  ).toBeVisible();

  // Test grouping views
  await page.getByLabel('Group by:').selectOption('custom');
  await expect(
    page.locator('.group-title-info', { hasText: 'Bed Alpha' }),
  ).toBeVisible();
  await page.getByLabel('Group by:').selectOption('material-color');
  await expect(
    page.getByRole('button', { name: 'Update group status' }),
  ).toBeVisible();

  // Test batch status update
  await page.getByRole('button', { name: 'Update group status' }).click();
  await page
    .getByLabel('New status for selected prints')
    .selectOption('queued');
  await page.getByRole('button', { name: /Update status for 1 print/ }).click();
  await expect(page.getByRole('status')).toContainText(
    'Successfully updated status to "queued"',
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(h.origin + '/operator');
  await page
    .getByRole('link', { name: 'Manage operators', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Manage operators', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove operator', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Username', { exact: true }).fill('browser-helper');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-helper-password');
  await page.getByRole('button', { name: 'Add operator', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Operator added.');
  await page
    .getByRole('button', { name: 'Edit browser-helper', exact: true })
    .click();
  await page
    .getByLabel('Username', { exact: true })
    .fill('browser-helper-renamed');
  await page
    .getByLabel('New password', { exact: true })
    .fill('browser-helper-new-password');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Operator updated.');
  await expect(
    page.getByRole('button', {
      name: 'Edit browser-helper-renamed',
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/operators-desktop.png',
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Remove browser-helper-renamed', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Edit browser-helper-renamed',
      exact: true,
    }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove browser-helper-renamed', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Operator removed.');
  await expect(
    page.getByRole('button', {
      name: 'Edit browser-helper-renamed',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Remove operator', exact: true }),
  ).toBeDisabled();
  if (process.env.PREVIEW_SMOKE_MODEL) {
    await page.goto(h.origin + '/submit');
    const previewPosts: string[] = [];
    const track = (request: import('@playwright/test').Request) => {
      if (['POST', 'PUT'].includes(request.method()))
        previewPosts.push(request.url());
    };
    page.on('request', track);
    await page
      .getByLabel('STL file', { exact: true })
      .setInputFiles(process.env.PREVIEW_SMOKE_MODEL);
    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    await expect(page.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
      timeout: 300000,
    });
    await page
      .locator('.preview-panel')
      .screenshot({ path: 'test-results/large-model-preview.png' });
    for (let i = 0; i < 4; i++)
      await page
        .getByRole('slider', { name: 'Layer', exact: true })
        .press('PageDown');
    await page
      .locator('.preview-panel')
      .screenshot({ path: 'test-results/large-model-cutaway.png' });
    await page.getByLabel('Only this layer').check();
    await page
      .locator('.preview-panel')
      .screenshot({ path: 'test-results/large-model-layer.png' });
    expect(previewPosts).toEqual([]);
    page.off('request', track);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/submit', '/operator']) {
    await page.goto(h.origin + path);
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter(
          (el) =>
            el.getBoundingClientRect().right > innerWidth + 1 &&
            getComputedStyle(el).position !== 'absolute',
        )
        .map(
          (el) =>
            `${el.tagName}.${el.className}: ${Math.round(el.getBoundingClientRect().right)}`,
        )
        .slice(0, 15),
    );
    await page.screenshot({
      path: `test-results/mobile-${path.replaceAll('/', '') || 'queue'}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${path}: ${overflow.join(', ')}`,
    ).toBe(true);
  }
  await page.goto(h.origin + '/submit');
  await page.screenshot({
    path: 'test-results/submit-mobile.png',
    fullPage: true,
  });
  const unitsPage = await browser.newPage();
  unitsPage.on('pageerror', (error) => errors.push(error.message));
  await unitsPage.goto(h.origin + '/submit');
  const sourceSTL = await readFile(
    new URL('../tests/support-bracket.stl', import.meta.url),
    'utf8',
  );
  const tinySTL = Buffer.from(
    sourceSTL.replace(
      /vertex ([-\d.]+) ([-\d.]+) ([-\d.]+)/g,
      (_, x, y, z) =>
        `vertex ${Number(x) / 1000} ${Number(y) / 1000} ${Number(z) / 1000}`,
    ),
  );
  await unitsPage.getByLabel('STL file', { exact: true }).setInputFiles({
    name: 'meter-export.stl',
    mimeType: 'application/octet-stream',
    buffer: tinySTL,
  });
  await expect(
    unitsPage.getByText(/This file is smaller than 1 mm/),
  ).toBeVisible();
  await unitsPage
    .getByRole('button', { name: 'Use meters', exact: true })
    .click();
  await expect(unitsPage.getByText('30 \u00d7 10 \u00d7 24 mm')).toBeVisible();
  await expect(unitsPage.locator('.print-time strong')).toHaveText(
    /About|Under/,
    { timeout: 10000 },
  );
  await unitsPage.getByText('More settings', { exact: true }).click();
  await expect(unitsPage.getByLabel('Model units')).toHaveValue('m');
  await unitsPage.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(unitsPage.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  if (process.env.PREVIEW_UNIT_MODEL) {
    await unitsPage
      .getByRole('button', { name: 'Clear all', exact: true })
      .count()
      .then(async (count) => {
        if (count)
          await unitsPage
            .getByRole('button', { name: 'Clear all', exact: true })
            .click();
      });
    await unitsPage
      .getByRole('button', { name: 'Remove meter-export.stl', exact: true })
      .click();
    await unitsPage
      .getByLabel('STL file', { exact: true })
      .setInputFiles(process.env.PREVIEW_UNIT_MODEL);
    await expect(
      unitsPage.getByText(/This file is smaller than 1 mm/),
    ).toBeVisible();
    await unitsPage
      .getByRole('button', { name: 'Use meters', exact: true })
      .click();
    await expect(unitsPage.locator('.print-time strong')).toHaveText(
      /About|Under/,
      { timeout: 10000 },
    );
    await unitsPage.getByRole('tab', { name: 'Layers', exact: true }).click();
    await expect(unitsPage.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
      timeout: 45000,
    });
    await unitsPage
      .locator('.preview-panel')
      .screenshot({ path: 'test-results/units-corrected-preview.png' });
  }
  let unitUpload = '';
  unitsPage.on('request', (request) => {
    if (request.method() === 'PUT')
      unitUpload = request.url().match(/submissions\/([^/]+)\/file/)![1];
  });
  await unitsPage
    .getByLabel('Project / part title')
    .fill('Unit conversion regression');
  await unitsPage.getByLabel('Purdue email').fill('units@purdue.edu');
  await unitsPage
    .getByRole('button', { name: 'Send confirmation email' })
    .click();
  await expect(
    unitsPage.getByRole('heading', { name: 'Check your email' }),
  ).toBeVisible();
  const savedUnits = await parseSTL(
    new Blob([await readFile(join(h.dir, 'files', unitUpload + '.stl'))]),
  );
  const originalUnits = await parseSTL(
    new Blob([
      process.env.PREVIEW_UNIT_MODEL
        ? await readFile(process.env.PREVIEW_UNIT_MODEL)
        : tinySTL,
    ]),
  );
  expect(savedUnits.triangles).toBe(originalUnits.triangles);
  expect(savedUnits.min[2]).toBeCloseTo(0, 5);
  for (let axis = 0; axis < 3; axis++)
    expect(savedUnits.max[axis] - savedUnits.min[axis]).toBeCloseTo(
      (originalUnits.max[axis] - originalUnits.min[axis]) * 1000,
      3,
    );
  await unitsPage.close();
  // A LAN-style HTTP hostname has no Web Crypto, including inside its module workers.
  const httpPage = await browser.newPage();
  httpPage.on('pageerror', (error) => errors.push(error.message));
  await httpPage.goto(
    h.origin.replace('127.0.0.1', 'preview.test') + '/submit',
  );
  expect(await httpPage.evaluate(() => isSecureContext)).toBe(false);
  expect(await httpPage.evaluate(() => Boolean(crypto.subtle))).toBe(false);
  await httpPage.getByLabel('STL file', { exact: true }).setInputFiles({
    name: 'http-bracket.stl',
    mimeType: 'application/octet-stream',
    buffer: await readFile(
      new URL('../tests/support-bracket.stl', import.meta.url),
    ),
  });
  await expect(httpPage.getByText('30 × 10 × 24 mm')).toBeVisible();
  await expect(httpPage.locator('.print-time strong')).toHaveText(
    /About|Under/,
    { timeout: 45000 },
  );
  await httpPage.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(httpPage.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  await httpPage.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(
    httpPage.getByRole('button', { name: 'Auto', exact: true }),
  ).toBeEnabled({ timeout: 45000 });
  await expect(httpPage.getByText('30 × 10 × 24 mm')).toHaveCount(0);
  await httpPage.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(httpPage.getByText(/Layer \d+ \/ \d+/)).toBeVisible({
    timeout: 45000,
  });
  const bracketText = await readFile(
    new URL('../tests/support-bracket.stl', import.meta.url),
    'utf8',
  );
  const scaled = (scale: number) =>
    Buffer.from(
      bracketText.replace(
        /vertex ([-\d.]+) ([-\d.]+) ([-\d.]+)/g,
        (_, x, y, z) =>
          `vertex ${(Number(x) - 10) * scale} ${Number(y) + 5} ${(Number(z) - 7) / 8}`,
      ),
    );
  await httpPage
    .getByRole('button', { name: 'Reset orientation', exact: true })
    .click();
  await httpPage.getByLabel('STL file', { exact: true }).setInputFiles({
    name: 'large-bed.stl',
    mimeType: 'application/octet-stream',
    buffer: scaled(10),
  });
  await httpPage.getByRole('button', { name: /^large-bed\.stl/ }).click();
  await expect(httpPage.locator('.preview-bed')).toContainText('Bambu H2D');
  await expect(httpPage.locator('.preview-bed')).toContainText(
    '325 \u00d7 320 mm',
  );
  await expect(httpPage.locator('.print-time strong')).toHaveText(
    /About|Under/,
    { timeout: 45000 },
  );
  await httpPage.getByLabel('STL file', { exact: true }).setInputFiles({
    name: 'too-large.stl',
    mimeType: 'application/octet-stream',
    buffer: scaled(11),
  });
  await httpPage.getByRole('button', { name: /^too-large\.stl/ }).click();
  await expect(httpPage.locator('.preview-bed')).toContainText(
    'Too large for this bed',
  );
  await expect(httpPage.locator('.print-time strong')).toHaveText(
    'Unavailable',
  );
  await httpPage.getByRole('button', { name: /^http-bracket\.stl/ }).click();
  await expect(httpPage.locator('.preview-bed')).toContainText(
    'Prusa Core ONE+',
  );
  await expect(httpPage.locator('.print-time strong')).toHaveText(
    /About|Under/,
    { timeout: 45000 },
  );
  await httpPage.route('**/preview-engine/manifest.json', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await httpPage.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(
    httpPage.getByText('Could not load engine manifest (503)'),
  ).toBeVisible();
  await httpPage.close();
  expect(errors).toEqual([]);
  console.log(
    'Browser flow passed: worker/WebGL preview, HTTP slicing/orientation, submit/confirm, operator updates, returns with feedback, email warning, and mobile layout.',
  );
} finally {
  await browser?.close();
  await h.close();
}
