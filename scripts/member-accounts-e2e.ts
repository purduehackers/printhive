import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SQL } from 'bun';
import { chromium, expect } from '@playwright/test';
import { startHarness } from '../tests/harness';
import { asciiSTL, submission } from '../tests/fixtures';

const h = await startHarness({ legacyAuth: false });
const sql = new SQL({ adapter: 'sqlite', filename: join(h.dir, 'printhive.sqlite') });
let cookie = '';
const request = (path: string, init: RequestInit = {}, session = cookie) => fetch(h.origin + path, {
  ...init, redirect: 'manual', headers: { Origin: h.origin, Cookie: session, ...init.headers },
});
const post = (path: string, body: Record<string, string>, session = cookie) =>
  request(path, { method: 'POST', body: new URLSearchParams(body) }, session);

try {
  await sql.unsafe('PRAGMA busy_timeout = 5000');
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const organizer = 'printhive_member=' + token;
  await sql`INSERT INTO members (id) VALUES ('organizer')`;
  await sql`INSERT INTO member_identities (provider, subject, member_id, display_name)
    VALUES ('purduehackers', 'organizer', 'organizer', 'Test Organizer')`;
  await sql`INSERT INTO member_sessions (token_hash, provider, subject, organizer, expires_at)
    VALUES (${hash}, 'purduehackers', 'organizer', 1, ${Date.now() + 60000})`;
  await sql`INSERT INTO operators (username, password_hash, id_subject) VALUES ('organizer', '', 'organizer')`;
  assert.match(await (await request('/')).text(), /href="\/sign-in"/);
  assert.equal((await request('/submit')).headers.get('location'), '/sign-in?next=/submit');
  assert.equal((await request('/api/operator/queue')).status, 401);
  const preview = await post('/operator/hive-members', { action: 'preview', emails: 'Email\nMember@purdue.edu\ninvalid' }, organizer);
  assert.match(await preview.text(), /1 to add · 0 duplicates · 1 invalid/);
  assert.equal((await post('/operator/hive-members', { action: 'add', emails: 'member@purdue.edu' }, organizer)).status, 303);
  const checkEmail = await post('/sign-in?next=/submit', { email: 'member@purdue.edu' });
  assert.equal(checkEmail.status, 200);
  assert.match(await checkEmail.text(), /Check your email/);
  const signInLink = /\/sign-in\/email\?token=([a-f0-9]{64})&next=%2Fsubmit/.exec(h.messages.at(-1) ?? '');
  assert.ok(signInLink, 'HIVE link was sent through SMTP');
  const landing = await request(signInLink[0]);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Sign in as <strong>member@purdue.edu<\/strong>/);
  assert.match(await (await request(signInLink[0])).text(), /name="next" value="\/submit"/);
  const redeemed = await post('/sign-in/email', { token: signInLink[1], next: '/submit' });
  assert.equal(redeemed.status, 303, await redeemed.clone().text());
  assert.equal(redeemed.headers.get('location'), '/submit');
  cookie = redeemed.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/operator/login')).status, 403);
  assert.equal((await request('/api/operator/queue')).status, 401);
  assert.match(await (await request('/submit')).text(), /Submit a print/);
  assert.equal((await request('/account/emails')).status, 404);
  assert.match(await (await request('/', {}, organizer)).text(), /Test Organizer/);
  const linked = await post('/manage-prints', { action: 'link-email', email: 'alternate@purdue.edu' });
  assert.equal(linked.status, 200);
  const linkEmail = /\/sign-in\/email\?token=([a-f0-9]{64})/.exec(h.messages.at(-1) ?? '');
  assert.ok(linkEmail);
  const verified = await post('/sign-in/email', { token: linkEmail[1] });
  assert.equal(verified.headers.get('location'), '/manage-prints?linked=1#find-prints');
  const reserved = await request('/api/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission()),
  });
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const { id, capability } = await reserved.json();
  const uploaded = await request(`/api/submissions/${id}/file`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + capability }, body: asciiSTL,
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  assert.equal((await uploaded.json()).confirmed, true);
  assert.match(await (await request('/manage-prints')).text(), /Test bracket/);
  assert.equal((await post('/manage-prints', {
    action: 'settings', id, version: '1', filament: '["PLA","black"]', infill: '30', walls: '3',
    layer_height: '0.2', supports: 'none', copies: '2', notes: 'Updated',
  })).status, 303);
  assert.equal((await post('/manage-prints', { action: 'cancellation', id, version: '2' })).status, 303);
  assert.deepEqual(Array.from(await sql`SELECT email, status, infill FROM jobs WHERE id = ${id}`),
    [{ email: 'member@purdue.edu', status: 'canceled', infill: 30 }]);
  if (process.env.PRINTHIVE_TEST_BROWSER_CHANNEL) {
    const browser = await chromium.launch({ channel: process.env.PRINTHIVE_TEST_BROWSER_CHANNEL });
    try {
      const page = await browser.newPage();
      await page.context().addCookies([{ name: 'printhive_member', value: cookie.split('=')[1], url: h.origin }]);
      await page.goto(h.origin + '/submit');
      await expect(page.getByRole('textbox', { name: 'Purdue email' })).toHaveCount(0);
      const fileInput = page.getByLabel('STL file', { exact: true });
      await expect(fileInput).toBeEnabled();
      await fileInput.setInputFiles({ name: 'bracket.stl', mimeType: 'model/stl', buffer: Buffer.from(asciiSTL) });
      await page.getByLabel('Project / part title').fill('Receipt test');
      await page.getByRole('button', { name: 'Review print', exact: true }).click();
      await expect(page.locator('.review-overview-grid').getByText('Purdue email', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Confirm & queue', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Print queued', exact: true })).toBeVisible();
      await page.locator('.receipt').getByRole('link', { name: 'Manage this print' }).click();
      const card = page.locator('.member-print:target');
      await expect(card.getByRole('heading', { name: 'Receipt test' })).toBeVisible();
      await card.getByText('Edit settings', { exact: true }).click();
      await card.getByRole('textbox', { name: 'Notes' }).fill('Keep this draft');
      const jobId = new URL(page.url()).searchParams.get('print');
      await sql`UPDATE jobs SET status = 'printing', started_at = ${Date.now()}, version = version + 1 WHERE id = ${jobId}`;
      await card.getByRole('button', { name: 'Save changes' }).click();
      await expect(card.getByRole('alert')).toContainText('Only queued prints');
      await expect(card.getByRole('textbox', { name: 'Notes' })).toHaveValue('Keep this draft');
      await expect(card.getByRole('textbox', { name: 'Notes' })).toBeDisabled();
      await expect(card.getByText('Cancel print', { exact: true })).toHaveCount(0);
      await expect(page.locator('.member-account-name')).toHaveText('member');
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Operator Dashboard' })).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('link', { name: 'Submit a print' }).first().click();
      await expect(fileInput).toBeEnabled();
      await fileInput.setInputFiles(['base.stl', 'lid.stl'].map(name => ({
        name, mimeType: 'model/stl', buffer: Buffer.from(asciiSTL),
      })));
      await page.getByLabel('Project / part title').fill('Batch receipt test');
      await page.getByRole('button', { name: 'Review 2 prints', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm & queue 2 prints', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Prints queued', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Manage this submission' }).click();
      await expect(page.locator('.member-print-batch:target .member-print')).toHaveCount(2);
      const operatorPage = await browser.newPage({ viewport: { width: 320, height: 740 } });
      const browserToken = randomBytes(32).toString('hex');
      const browserHash = createHash('sha256').update(browserToken).digest('hex');
      await sql`INSERT INTO member_sessions (token_hash, provider, subject, organizer, expires_at)
        VALUES (${browserHash}, 'purduehackers', 'organizer', 1, ${Date.now() + 60000})`;
      await operatorPage.context().addCookies([{ name: 'printhive_member', value: browserToken, url: h.origin }]);
      await operatorPage.goto(h.origin + '/operator/manage-materials');
      const navigation = operatorPage.getByRole('navigation', { name: 'Main navigation' });
      await navigation.getByRole('link', { name: 'Manage prints' }).focus();
      await operatorPage.keyboard.press('Tab');
      const dashboard = navigation.getByRole('link', { name: 'Operator Dashboard' });
      await expect(dashboard).toBeFocused();
      await expect(dashboard).not.toHaveAttribute('aria-current');
      await operatorPage.keyboard.press('Tab');
      const signOut = operatorPage.getByRole('button', { name: 'Sign out' });
      await expect(signOut).toBeFocused();
      const bounds = await signOut.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
      await dashboard.click();
      await expect(operatorPage.getByRole('heading', { name: 'Print jobs' })).toBeVisible();
      await expect(dashboard).toHaveAttribute('aria-current', 'page');
      await expect(signOut).toHaveCount(1);
      await signOut.hover();
      await expect(signOut).toHaveCSS('color', 'rgb(156, 48, 38)');
      await signOut.click();
      await expect(operatorPage.getByRole('link', { name: 'Operator Dashboard' })).toHaveCount(0);
    } finally {
      await browser.close();
    }
  }
  assert.equal((await post('/operator/hive-members', { action: 'remove', email: 'member@purdue.edu' }, organizer)).status, 303);
  assert.equal((await request('/manage-prints')).status, 302);
  console.log('HIVE whitelist, sign-in email, submission, print changes and organizer access verified.');
} finally {
  await sql.close();
  await h.close();
}
