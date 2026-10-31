import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startHarness } from '../tests/harness';

const h = await startHarness();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors: string[] = [], timings: { status: number; uploadMs: number }[] = [], renderMs: number[] = [];
  await context.addInitScript(() => {
    const starts = new WeakMap<HTMLCanvasElement, number>();
    const originalContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      if (String(args[0]).startsWith('webgl') && !starts.has(this)) starts.set(this, performance.now());
      return originalContext.apply(this, args as any);
    } as typeof originalContext;
    const originalBlob = HTMLCanvasElement.prototype.toBlob;
    (window as any).thumbnailRenderMs = [];
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      return originalBlob.call(this, blob => {
        if (this.width === 128 && this.height === 128 && starts.has(this)) {
          (window as any).thumbnailRenderMs.push(performance.now() - starts.get(this)!);
          starts.set(this, performance.now());
        }
        callback(blob);
      }, ...args);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  let uploadStarted = 0;
  page.on('request', request => { if (request.url().endsWith('/thumbnail')) uploadStarted = Date.now(); });
  page.on('response', response => {
    if (response.url().endsWith('/thumbnail')) {
      timings.push({ status: response.status(), uploadMs: Date.now() - uploadStarted });
    }
  });
  const mesh = await readFile(new URL('../tests/support-bracket.stl', import.meta.url));
  for (const batch of [false, true]) {
    await page.goto(h.origin + '/submit');
    await page.getByLabel('Project / part title').fill(batch ? 'Thumbnail batch' : 'Thumbnail bracket');
    await page.getByLabel('Purdue email').fill('thumbnail@purdue.edu');
    await page.getByLabel('STL file', { exact: true }).setInputFiles((batch ? ['left.stl', 'right.stl'] : ['bracket.stl']).map(name => ({ name, mimeType: 'application/octet-stream', buffer: mesh })));
    await expect(page.getByText('30 × 10 × 24 mm')).toBeVisible();
    if (batch) await page.getByRole('combobox', { name: 'Default filament color', exact: true }).selectOption('white');
    // Change the interactive view; thumbnails must retain their own fixed camera.
    await page.locator('.preview-viewport canvas').hover();
    await page.mouse.wheel(0, -200);
    await page.getByRole('button', { name: batch ? 'Review 2 prints' : 'Review print', exact: true }).click();
    await page.getByRole('button', { name: batch ? 'Confirm & queue 2 prints' : 'Send confirmation email', exact: true }).click();
    await expect(page.getByRole('heading', { name: batch ? 'Prints queued' : 'Check your email' })).toBeVisible();
    renderMs.push(...await page.evaluate(() => (window as any).thumbnailRenderMs));
    if (!batch) {
      const link = h.messages[0].match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
      await page.goto(link);
      await page.getByRole('button', { name: 'Confirm print', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Print queued' })).toBeVisible();
    }
  }
  expect(timings).toHaveLength(3);
  expect(renderMs).toHaveLength(3);
  expect(timings.every(item => item.status === 200)).toBe(true);
  expect((await context.request.post(h.origin + '/api/login', { headers: { Origin: h.origin }, data: { username: 'operator', password: 'test-password-12345' } })).status()).toBe(200);
  await page.goto(h.origin + '/operator');
  // The noscript fallback also exists in the DOM, so use visible image elements.
  const visibleImages = page.locator('img.operator-print-thumbnail:visible');
  await expect(visibleImages).toHaveCount(3);
  for (const image of await visibleImages.all()) {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(128);
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(128);
    expect((await image.boundingBox())!.width).toBe(36);
    const placement = await image.evaluate(element => {
      const row = element.closest('tr')!, box = row.getBoundingClientRect();
      const imageBox = element.getBoundingClientRect(), checkboxBox = row.querySelector('input')!.getBoundingClientRect();
      return { imageOffset: imageBox.y + imageBox.height / 2 - box.y - box.height / 2,
        checkboxOffset: checkboxBox.y + checkboxBox.height / 2 - box.y - box.height / 2,
        blend: getComputedStyle(element).mixBlendMode, rowHeight: box.height };
    });
    expect(Math.abs(placement.imageOffset)).toBeLessThan(1);
    expect(Math.abs(placement.checkboxOffset)).toBeLessThan(1);
    expect(placement.blend).toBe('multiply');
    expect(placement.rowHeight).toBeLessThan(95);
  }
  const src = await visibleImages.first().getAttribute('src');
  expect((await fetch(h.origin + src)).status).toBe(401);
  const publicJobs = await (await fetch(h.origin + '/api/queue')).json();
  expect(publicJobs).toHaveLength(3);
  expect(publicJobs.every((job: object) => !('has_thumbnail' in job))).toBe(true);
  const imageResponse = await context.request.get(h.origin + src);
  const png = await imageResponse.body();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/print-thumbnail.png', png);
  const pixels = await page.evaluate(async src => {
    const image = new Image(); image.src = src!; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, 128, 128).data;
    let colored = 0, minX = 128, maxX = 0, minY = 128, maxY = 0;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 230) { colored++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return { colored, minX, maxX, minY, maxY };
  }, src);
  expect(pixels.colored).toBeGreaterThan(1000);
  expect(Math.max(pixels.maxX - pixels.minX, pixels.maxY - pixels.minY)).toBeGreaterThan(100);
  expect(pixels.minX).toBeGreaterThan(0); expect(pixels.minY).toBeGreaterThan(0);
  expect(pixels.maxX).toBeLessThan(127); expect(pixels.maxY).toBeLessThan(127);
  const whitePixels = await visibleImages.nth(1).evaluate(async element => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, 128, 128).data;
    let readable = 0;
    for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) < 225) readable++;
    return { readable, corner: [...data.slice(0, 4)] };
  });
  expect(whitePixels.readable).toBeGreaterThan(2000);
  // The original image keeps an opaque white background for native notifications.
  expect(whitePixels.corner).toEqual([255, 255, 255, 255]);
  await page.screenshot({ path: 'test-results/operator-thumbnails.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/operator-thumbnails-mobile.png', fullPage: true });
  await page.goto(h.origin);
  await expect(page.locator('.operator-print-thumbnail')).toHaveCount(0);
  // A device without WebGL still submits normally and receives text-only alerts.
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      return String(args[0]).startsWith('webgl') ? null : original.apply(this, args as any);
    } as typeof original;
  });
  await page.goto(h.origin + '/submit');
  await page.getByLabel('Project / part title').fill('No GPU fallback');
  await page.getByLabel('STL file', { exact: true }).setInputFiles({ name: 'fallback.stl', mimeType: 'application/octet-stream', buffer: mesh });
  await page.getByRole('button', { name: 'Review print', exact: true }).click();
  const fallbackStarted = Date.now();
  await page.getByRole('button', { name: 'Confirm & queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Print queued', exact: true })).toBeVisible();
  const fallbackMs = Date.now() - fallbackStarted;
  expect(fallbackMs).toBeLessThan(3000);
  const snapshot = await (await context.request.get(h.origin + '/api/operator/queue')).json();
  expect(snapshot.jobs.find((job: { title: string }) => job.title === 'No GPU fallback').has_thumbnail).toBe(0);
  expect(errors).toEqual([]);
  await writeFile('test-results/print-thumbnails.json', JSON.stringify({ timings, renderMs, fallbackMs, pngBytes: png.length, pixels, whitePixels }, null, 2));
  console.log('Thumbnail browser checks passed:', JSON.stringify({ timings, renderMs, fallbackMs, pngBytes: png.length, pixels, whitePixels }));
} catch (error) { console.error(h.logs()); throw error; }
finally { await browser?.close(); await h.close(); }
