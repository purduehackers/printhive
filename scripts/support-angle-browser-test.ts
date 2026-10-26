import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startHarness } from '../tests/harness';

// A bar leaning at 45 degrees. It needs no support at 30 degrees, but does at 80.
const points = [
  [0, 0, 0],
  [5, 0, 0],
  [25, 0, 20],
  [20, 0, 20],
  [0, 10, 0],
  [5, 10, 0],
  [25, 10, 20],
  [20, 10, 20],
];
const quads = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [3, 2, 6, 7],
  [0, 3, 7, 4],
  [1, 5, 6, 2],
];
const buffer = Buffer.from(
  'solid lean\n' +
    quads
      .flatMap(([a, b, c, d]) => [
        [a, b, c],
        [a, c, d],
      ])
      .map(
        (triangle) =>
          'facet normal 0 0 0\nouter loop\n' +
          triangle
            .map((index) => 'vertex ' + points[index].join(' '))
            .join('\n') +
          '\nendloop\nendfacet',
      )
      .join('\n') +
    '\nendsolid lean\n',
);
const h = await startHarness();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  let posted: { items: Array<{ support_angle: number | null }> } | undefined;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/submissions/batch')
    )
      posted = request.postDataJSON();
  });
  await page.addInitScript(() => {
    const state = window as unknown as {
      angles: unknown[];
      vertices: number[];
    };
    state.angles = [];
    state.vertices = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message?.operation === 'fast_shapes') {
        state.angles.push(
          message.request.profile.configuration.support_threshold_angle,
        );
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'result')
            state.vertices.push(data.result.vertexCount);
        });
      }
      return Reflect.apply(
        post,
        this,
        options === undefined ? [message] : [message, options],
      );
    };
  });
  const ready = () =>
    expect(page.locator('.print-time strong')).toHaveText(/About|Under/, {
      timeout: 45000,
    });
  const angle = page.getByRole('spinbutton', {
    name: 'Support overhang angle (°)',
    exact: true,
  });
  const notice = page.locator('.support-result');
  const add = (name: string) =>
    page
      .getByLabel('STL file', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await page.goto(h.origin + '/submit');
  await add('lean-a.stl');
  await ready();
  await expect(
    notice.getByText('No supports needed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Model', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Supports', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Layer', exact: true }),
  ).toHaveCount(0);
  await page.getByText('More settings', { exact: true }).click();
  await expect(angle).toHaveValue('');
  await expect(
    page.getByRole('spinbutton', {
      name: 'Default support overhang angle (°)',
      exact: true,
    }),
  ).toHaveCount(0);
  await angle.fill('80');
  await ready();
  await expect(notice).toHaveCount(0);
  await expect(
    page.getByRole('slider', { name: 'Layer', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { vertices: number[] }).vertices.at(-1),
    ),
  ).toBeGreaterThan(0);
  const before = await page.evaluate(
    () => (window as unknown as { angles: unknown[] }).angles.length,
  );
  await angle.fill('');
  await ready();
  await expect(notice).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { angles: unknown[] }).angles.length,
    ),
  ).toBe(before);
  await angle.fill('80');
  await ready();
  await add('lean-b.stl');
  await page.getByRole('button', { name: /^lean-b\.stl/ }).click();
  await ready();
  await expect(angle).toHaveValue('');
  await expect(notice).toBeVisible();
  await page.getByRole('button', { name: /^lean-a\.stl/ }).click();
  await ready();
  await expect(angle).toHaveValue('80');
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('none');
  await ready();
  await expect(notice).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: 'Supports', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Supports', exact: true })
    .selectOption('normal');
  await ready();
  await page.getByRole('tab', { name: 'Supports', exact: true }).click();
  await expect(
    page.getByRole('slider', { name: 'Layer', exact: true }),
  ).toBeVisible();
  await angle.fill('');
  await ready();
  await expect(notice).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page
    .locator('.preview-panel')
    .screenshot({ path: 'test-results/no-supports-needed.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/support-angle-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await angle.fill('91');
  await page.getByLabel('Project / part title').fill('Angle isolation');
  await page.getByLabel('Purdue email').fill('angle@purdue.edu');
  await page.getByRole('button', { name: /^lean-b\.stl/ }).click();
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'whole-number support angle',
  );
  await expect(angle).toBeVisible();
  await angle.fill('80');
  await page
    .getByRole('button', { name: 'Send confirmation email', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Check your email', exact: true }),
  ).toBeVisible();
  expect(posted!.items.map((item) => item.support_angle)).toEqual([80, null]);
  const link = h.messages
    .at(-1)!
    .match(/http[^\s]+\/confirm\?token=[^\s]+/)![0];
  await page.goto(link);
  await page
    .getByRole('button', { name: 'Confirm 2 prints', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Prints queued', exact: true }),
  ).toBeVisible();
  const jobs = (await (await fetch(h.origin + '/api/queue')).json()) as Array<{
    id: string;
    support_angle: number | null;
    title: string;
  }>;
  expect(
    jobs.map((job) => job.support_angle).sort((a, b) => (a ?? -1) - (b ?? -1)),
  ).toEqual([null, 80]);
  await page.goto(h.origin + '/operator/login');
  await page.getByLabel('Username').fill('operator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('test-password-12345');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Print jobs', exact: true }),
  ).toBeVisible();
  for (const job of jobs) {
    await page.goto(h.origin + '/operator/jobs/' + job.id);
    await expect(
      page.getByText(job.support_angle === null ? 'Printer default' : '80°', {
        exact: true,
      }),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
  console.log(
    'Default/explicit angles, real tree and regular support geometry, empty-state clarity, cache reuse, per-file isolation and saved operator instructions passed.',
  );
} finally {
  await browser.close();
  await h.close();
}
