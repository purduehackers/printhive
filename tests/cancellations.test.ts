import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, db, migrate } from '../src/lib/server/db';
import { cancellation, requestCancellation } from '../src/lib/server/cancellations';
import { reserve, reserveBatch, upload, finalizeBatch, publicQueue, updateStatus, updateJobGroup } from '../src/lib/server/jobs';
import { seal, unseal } from '../src/lib/server/tokens';
import { cleanup } from '../src/lib/server/cleanup';
import { type Message } from '../src/lib/server/mail';
import { asciiSTL, submission } from './fixtures';

let dir: string;
const messages: Message[] = [];
const mailer = async (message: Message) => { messages.push(message); };
const emailAddress = () => `${randomUUID()}@purdue.edu`;
const tokenFromEmail = () => new URL(messages.at(-1)!.text.match(/http[^\s]+\/cancel\?token=[^\s]+/)![0]).searchParams.get('token')!;

async function batch(email = emailAddress()) {
  const result = await reserveBatch({ title: 'Robot arm', email, items: ['base.stl', 'grip.stl', 'mount.stl'].map(original_filename =>
    ({ original_filename, file_size: new Blob([asciiSTL]).size })) });
  for (const item of result.items) {
    await upload(item.id, item.capability, new Request('http://localhost:4321/file', { method: 'PUT', body: asciiSTL }), mailer, { deferEmail: true });
  }
  await finalizeBatch(result.batchToken, mailer, { verifiedEmail: email });
  return { ...result, email, ids: result.items.map(item => item.id) };
}

async function single(email = emailAddress()) {
  const result = await reserve(submission({ email }));
  await upload(result.id, result.capability, new Request('http://localhost:4321/file', { method: 'PUT', body: asciiSTL }), mailer, { verifiedEmail: email });
  return { ...result, email };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-cancellation-test-'));
  process.env.DATA_DIR = dir; process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321'; process.env.NODE_ENV = 'test';
  await migrate();
  await (await db())`INSERT INTO operators (id, username, password_hash) VALUES (1, 'operator', 'test')`;
});
beforeEach(async () => {
  const sql = await db();
  await sql`DELETE FROM jobs`; await sql`DELETE FROM cancellation_requests`; messages.length = 0;
});
afterAll(async () => { await closeDb(); await rm(dir, { recursive: true, force: true }); });

describe('submitter cancellation', () => {
  test('request and GET preserve queue; racing confirmations cancel only selected prints once and record submitter history', async () => {
    const group = await batch(), ids = group.ids.slice(0, 2);
    await requestCancellation(ids, ` ${group.email.toUpperCase()} `, mailer);
    expect(messages).toHaveLength(1); expect(messages[0].to).toBe(group.email);
    expect(messages[0].text).toContain(group.items[0].title);
    expect(messages[0].text).not.toContain(group.items[2].title);
    const token = tokenFromEmail();
    expect((await cancellation(token)).already).toBe(false);
    expect(await publicQueue()).toHaveLength(3);
    const results = await Promise.all([cancellation(token, true), cancellation(token, true)]);
    expect(results.filter(result => !result.already)).toHaveLength(1);
    expect((await publicQueue()).map(job => job.id)).toEqual([group.ids[2]]);
    const sql = await db();
    expect((await sql`SELECT id FROM jobs WHERE status = 'canceled' ORDER BY queued_at`).map((job: { id: string }) => job.id)).toEqual(ids);
    const visible = await publicQueue();
    expect(visible.every(job => !('email' in job) && !('notes' in job))).toBe(true);
    const events: { operator_id: number | null; next_status: string; feedback: string }[] = await (await db())`SELECT * FROM job_events`;
    expect(events).toHaveLength(2);
    expect(events.every(event => event.operator_id === null && event.next_status === 'canceled' && event.feedback.includes('submitter'))).toBe(true);
  });

  test('whole original submission can be canceled after an operator changes its display groups', async () => {
    const group = await batch();
    await updateJobGroup([group.ids[0]], 'Bed A', 1);
    await updateJobGroup(group.ids.slice(1), 'Bed B', 1);
    await requestCancellation(group.ids, group.email, mailer);
    expect((await cancellation(tokenFromEmail(), true)).jobs.every(job => job.status === 'canceled')).toBe(true);
  });

  test('same owner and operator group cannot combine different original submissions or standalone prints', async () => {
    const one = await batch(), two = await batch(one.email), solo = await single(one.email), otherSolo = await single(one.email);
    await updateJobGroup([...one.ids, ...two.ids, solo.id, otherSolo.id], 'Shared bed', 1);
    await expect(requestCancellation([one.ids[0], two.ids[0]], one.email, mailer)).rejects.toMatchObject({ status: 400 });
    await expect(requestCancellation([solo.id, otherSolo.id], one.email, mailer)).rejects.toMatchObject({ status: 400 });
    expect(messages).toHaveLength(0);
  });

  test('wrong email, mixed owners, missing, unconfirmed, and malformed selections do not send email', async () => {
    const group = await batch(), other = await single();
    const pending = await reserve(submission({ email: group.email }));
    const invalid: unknown[] = [[], [group.ids[0], group.ids[0]], [randomUUID()], ['bad-id'], null,
      [pending.id], [group.ids[0], other.id], Array.from({ length: 11 }, () => randomUUID())];
    for (const ids of invalid) await expect(requestCancellation(ids, group.email, mailer)).rejects.toBeDefined();
    await expect(requestCancellation(group.ids, other.email, mailer)).rejects.toMatchObject({ status: 400 });
    await expect(requestCancellation(group.ids, null, mailer)).rejects.toMatchObject({ status: 400 });
    expect(messages).toHaveLength(0);
  });

  test('standalone print cancellation works', async () => {
    const job = await single();
    await requestCancellation([job.id], job.email, mailer);
    expect((await cancellation(tokenFromEmail(), true)).jobs[0].status).toBe('canceled');
  });

  test('if any selected print starts, confirmation cancels nothing', async () => {
    const group = await batch();
    await requestCancellation(group.ids, group.email, mailer);
    const token = tokenFromEmail();
    await updateStatus(group.ids[1], 'printing', 1, 1, { mailer });
    await expect(cancellation(token, true)).rejects.toMatchObject({ status: 409 });
    expect((await publicQueue()).filter(job => job.status === 'queued')).toHaveLength(2);
    expect(await (await db())`SELECT id FROM jobs WHERE status = 'canceled'`).toHaveLength(0);
    expect((await (await db())`SELECT consumed_at FROM cancellation_requests`)[0].consumed_at).toBeNull();
  });

  test('printing cannot be requested; a link for an earlier queue state cannot cancel a requeued print', async () => {
    const job = await single();
    await requestCancellation([job.id], job.email, mailer);
    const token = tokenFromEmail();
    await updateStatus(job.id, 'printing', 1, 1, { mailer });
    await expect(requestCancellation([job.id], job.email, mailer)).rejects.toMatchObject({ status: 409 });
    await updateStatus(job.id, 'canceled', 2, 1, { mailer });
    await updateStatus(job.id, 'queued', 3, 1, { mailer });
    await expect(cancellation(token, true)).rejects.toMatchObject({ status: 409 });
    expect((await publicQueue())[0].status).toBe('queued');
  });

  test('used link remains consumed after operator requeues the print', async () => {
    const job = await single();
    await requestCancellation([job.id], job.email, mailer);
    const token = tokenFromEmail();
    await cancellation(token, true);
    await updateStatus(job.id, 'queued', 2, 1, { mailer });
    expect((await cancellation(token, true)).already).toBe(true);
    expect((await publicQueue())[0].status).toBe('queued');
  });

  test('invalid, expired, and submission confirmation tokens cannot cancel prints; cleanup removes expired requests', async () => {
    const job = await single();
    await requestCancellation([job.id], job.email, mailer);
    const token = tokenFromEmail(), { id } = unseal(token, 'cancel');
    const bytes = Buffer.from(token, 'base64url'); bytes[0] ^= 1;
    await expect(cancellation(bytes.toString('base64url'), true)).rejects.toMatchObject({ status: 400 });
    await expect(cancellation(seal(id, 'confirm', Date.now() + 10000), true)).rejects.toMatchObject({ status: 400 });
    await expect(cancellation(seal(id, 'cancel', Date.now() - 1), true)).rejects.toMatchObject({ status: 410 });
    await (await db())`UPDATE cancellation_requests SET expires_at = ${Date.now() - 1} WHERE id = ${id}`;
    await expect(cancellation(token, true)).rejects.toMatchObject({ status: 410 });
    await cleanup();
    expect(await (await db())`SELECT * FROM cancellation_requests`).toHaveLength(0);
    expect(await publicQueue()).toHaveLength(1);
  });

  test('delivery failure invalidates link and preserves every print', async () => {
    const group = await batch();
    let deliveredToken = '';
    await expect(requestCancellation(group.ids, group.email, async message => {
      messages.push(message); deliveredToken = tokenFromEmail(); throw new Error('SMTP unavailable');
    })).rejects.toMatchObject({ status: 502 });
    await expect(cancellation(deliveredToken, true)).rejects.toMatchObject({ status: 410 });
    expect(await publicQueue()).toHaveLength(3);
    expect(await (await db())`SELECT * FROM cancellation_requests`).toHaveLength(0);
  });

  test('repeated requests for a submission are limited', async () => {
    const group = await batch();
    await requestCancellation([group.ids[0]], group.email, mailer);
    await expect(requestCancellation([group.ids[1]], group.email, mailer)).rejects.toMatchObject({ status: 429 });
    expect(messages).toHaveLength(1);
  });
});
