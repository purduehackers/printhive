import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startHarness } from '../tests/harness';

const h = await startHarness();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as unknown as {
      requestedProfiles: Array<{
        id: string;
        configuration: Record<string, unknown>;
      }>;
    };
    state.requestedProfiles = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message?.operation === 'fast_shapes')
        state.requestedProfiles.push(message.request.profile);
      return Reflect.apply(
        post,
        this,
        options === undefined ? [message] : [message, options],
      );
    };
  });
  const core = JSON.parse(
    await readFile(
      new URL('../public/preview-profiles/core-one.json', import.meta.url),
      'utf8',
    ),
  );
  const h2d = JSON.parse(
    await readFile(
      new URL('../public/preview-profiles/h2d.json', import.meta.url),
      'utf8',
    ),
  );
  // Operator edits travel through the real worker and native engine, not a mocked estimate.
  core.configuration.outer_wall_speed = ['23'];
  h2d.configuration.outer_wall_speed = ['47'];
  let failH2d = false,
    badCore = false;
  await page.route('**/preview-profiles/*.json', (route) => {
    const isCore = route.request().url().endsWith('/core-one.json');
    if (!isCore && failH2d)
      return route.fulfill({ status: 503, body: 'Unavailable' });
    return route.fulfill({
      json: isCore
        ? badCore
          ? { ...core, printerId: 'bambu-h2d' }
          : core
        : h2d,
    });
  });
  const source = await readFile(
    new URL('../tests/support-bracket.stl', import.meta.url),
    'utf8',
  );
  const large = Buffer.from(
    source.replace(
      /vertex ([-\d.]+) ([-\d.]+) ([-\d.]+)/g,
      (_, x, y, z) => `vertex ${Number(x) * 10} ${Number(y)} ${Number(z) / 8}`,
    ),
  );
  const input = page.getByLabel('STL file', { exact: true });
  const add = (name: string, buffer: Buffer) =>
    input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  const ready = () =>
    expect(page.locator('.print-time strong')).toHaveText(/About|Under/, {
      timeout: 45000,
    });
  await page.goto(h.origin + '/submit');
  await page
    .getByRole('combobox', { name: 'Default supports', exact: true })
    .selectOption('none');
  await add('core-part.stl', Buffer.from(source));
  await ready();
  await expect(page.getByLabel('Estimate printer')).toHaveText(
    'For Prusa Core ONE+',
  );
  await expect(
    page.getByRole('tab', { name: 'Supports', exact: true }),
  ).toBeDisabled();
  let profiles = await page.evaluate(
    () =>
      (
        window as unknown as {
          requestedProfiles: Array<{
            id: string;
            configuration: Record<string, unknown>;
          }>;
        }
      ).requestedProfiles,
  );
  expect(profiles.at(-1)!.id).toContain(core.id);
  expect(profiles.at(-1)!.configuration.outer_wall_speed).toEqual(['23']);
  const before = profiles.length;
  await add('h2d-part.stl', large);
  await page.getByRole('button', { name: /^h2d-part\.stl/ }).click();
  await ready();
  await expect(page.getByLabel('Estimate printer')).toHaveText('For Bambu H2D');
  profiles = await page.evaluate(
    () =>
      (
        window as unknown as {
          requestedProfiles: Array<{
            id: string;
            configuration: Record<string, unknown>;
          }>;
        }
      ).requestedProfiles,
  );
  expect(profiles.length).toBe(before + 1);
  expect(profiles.at(-1)!.id).toContain(h2d.id);
  expect(profiles.at(-1)!.configuration.outer_wall_speed).toEqual(['47']);
  expect(profiles.at(-1)!.configuration.printable_area).toEqual([
    '0x0',
    '325x0',
    '325x320',
    '0x320',
  ]);
  await page.getByRole('button', { name: /^core-part\.stl/ }).click();
  await ready();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { requestedProfiles: unknown[] })
          .requestedProfiles.length,
    ),
  ).toBe(before + 1);
  // Profile updates are picked up on file selection, even within an already-open page.
  const stockFlow = core.configuration.filament_max_volumetric_speed;
  core.configuration.filament_max_volumetric_speed = ['3'];
  await page.getByRole('button', { name: /^h2d-part\.stl/ }).click();
  await ready();
  await page.getByRole('button', { name: /^core-part\.stl/ }).click();
  await ready();
  let refreshed = await page.evaluate(
    () =>
      (
        window as unknown as {
          requestedProfiles: Array<{ configuration: Record<string, unknown> }>;
        }
      ).requestedProfiles,
  );
  expect(refreshed.at(-1)!.configuration.filament_max_volumetric_speed).toEqual(
    ['3'],
  );
  const afterRefresh = refreshed.length;
  core.configuration.filament_max_volumetric_speed = stockFlow;
  await page.getByRole('button', { name: /^h2d-part\.stl/ }).click();
  await ready();
  await page.getByRole('button', { name: /^core-part\.stl/ }).click();
  await ready();
  refreshed = await page.evaluate(
    () =>
      (
        window as unknown as {
          requestedProfiles: Array<{ configuration: Record<string, unknown> }>;
        }
      ).requestedProfiles,
  );
  expect(refreshed.length).toBe(afterRefresh); // Returning to unchanged settings uses the earlier result.
  // A broken fallback never borrows the smaller printer's settings.
  failH2d = true;
  await page.reload();
  await add('core-part.stl', Buffer.from(source));
  await ready();
  await add('h2d-part.stl', large);
  await page.getByRole('button', { name: /^h2d-part\.stl/ }).click();
  await expect(
    page.getByText(
      "Couldn't load slicer settings for Bambu H2D. Reload to try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('.print-time strong')).toHaveText('Unavailable');
  await page.getByRole('button', { name: /^core-part\.stl/ }).click();
  await ready();
  // Misidentified settings block estimates, while ordinary STL submission still works.
  badCore = true;
  await page.reload();
  await add('upload-without-preview.stl', Buffer.from(source));
  await expect(
    page.getByText(
      "Couldn't load slicer settings for Prusa Core ONE+. Reload to try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('.print-time strong')).toHaveText('Unavailable');
  await page
    .getByLabel('Project / part title')
    .fill('Profile failure submission');
  await page.getByLabel('Purdue email').fill('profiles@purdue.edu');
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Check your email', exact: true }),
  ).toBeVisible();
  // Exercise the shipped upstream profiles without the operator-edit route overrides.
  await page.unroute('**/preview-profiles/*.json');
  for (const [name, buffer, file, printer] of [
    [
      'stock-core.stl',
      Buffer.from(source),
      'core-one.json',
      'For Prusa Core ONE+',
    ],
    ['stock-h2d.stl', large, 'h2d.json', 'For Bambu H2D'],
  ] as const) {
    const shipped = JSON.parse(
      await readFile(
        new URL('../public/preview-profiles/' + file, import.meta.url),
        'utf8',
      ),
    );
    for (const support of ['none', 'tree', 'normal']) {
      await page.goto(h.origin + '/submit');
      await page
        .getByRole('combobox', { name: 'Default supports', exact: true })
        .selectOption(support);
      await add(name, buffer);
      await ready();
      await expect(page.getByLabel('Estimate printer')).toHaveText(printer);
      const actual = await page.evaluate(
        () =>
          (
            window as unknown as {
              requestedProfiles: Array<{
                configuration: Record<string, unknown>;
              }>;
            }
          ).requestedProfiles.at(-1)!.configuration,
      );
      expect(actual.outer_wall_speed).toEqual(
        shipped.configuration.outer_wall_speed,
      );
      expect(actual.filament_max_volumetric_speed).toEqual(
        shipped.configuration.filament_max_volumetric_speed,
      );
      if (support === 'none')
        await expect(
          page.getByRole('tab', { name: 'Supports', exact: true }),
        ).toBeDisabled();
      else {
        await page.getByRole('tab', { name: 'Supports', exact: true }).click();
        await expect(
          page.getByText(/Layer \d+ \/ \d+|No supports needed/),
        ).toBeVisible({ timeout: 45000 });
      }
    }
  }
  expect(errors).toEqual([]);
  console.log(
    'Per-printer JSON edits, actual worker configuration, Core ONE/H2D selection, cache reuse, profile refresh, profile failures, independent submission and all six shipped-profile/support combinations passed.',
  );
} finally {
  await browser.close();
  await h.close();
}
