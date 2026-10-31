import { test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import type { APIContext } from 'astro';
import webPush from 'web-push';
import { db, migrate, closeDb } from '../src/lib/server/db';
import { pushConfig } from '../src/lib/server/config';
import { validateSubscription, subscribeDevice, pushStatus, revokeDevice, testDevice, dispatchPush, PushDeliveryError, sendPush, recordQueuePush, type PushMessage } from '../src/lib/server/push';
import { reserve, upload, reserveBatch, finalizeBatch, confirmation, updateStatus, operatorQueue } from '../src/lib/server/jobs';
import { logout } from '../src/lib/server/auth';
import { editOperator, removeOperator } from '../src/lib/server/operators';
import { filePath } from '../src/lib/server/storage';
import { seal } from '../src/lib/server/tokens';
import { unseal } from '../src/lib/server/tokens';
import { storeThumbnail, readThumbnail, thumbnailPath } from '../src/lib/server/thumbnails';
import { removeFile } from '../src/lib/server/storage';
import { cleanup } from '../src/lib/server/cleanup';
import { asciiSTL, submission, thumbnailPNG } from './fixtures';

let dir: string;
const previousEnv = { ...process.env };
const keys = webPush.generateVAPIDKeys();
const accepted: PushMessage[] = [];
const sender = async (_subscription: unknown, message: PushMessage) => { accepted.push(message); };
const mailer = async () => {};
const body = () => new Request('http://localhost:4321/file', { method: 'PUT', body: asciiSTL });
function subscription(name = 'device') {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: {
    p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } };
}
function context() {
  const jar = new Map<string, string>();
  return { cookies: { get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined,
    set: (key: string, value: string) => jar.set(key, value), delete: (key: string) => jar.delete(key) } } as unknown as APIContext;
}
async function queueOne() {
  const reserved = await reserve(submission());
  await upload(reserved.id, reserved.capability, body(), mailer, { verifiedEmail: 'test@purdue.edu' });
  return reserved;
}

const thumbnailRequest = (bytes = thumbnailPNG(), type = 'image/png') => new Request('http://localhost:4321/thumbnail', {
  method: 'PUT', headers: { 'Content-Type': type }, body: bytes,
});

test('thumbnail uploads are bounded, single-use and restricted to their print upload capability', async () => {
  const reserved = await reserve(submission()), other = await reserve(submission());
  await expect(storeThumbnail(reserved.id, other.capability, thumbnailRequest())).rejects.toMatchObject({ status: 403 });
  await expect(storeThumbnail(reserved.id, seal(reserved.id, 'confirm', Date.now() + 60000), thumbnailRequest())).rejects.toMatchObject({ status: 400 });
  await expect(storeThumbnail(reserved.id, reserved.capability, thumbnailRequest(thumbnailPNG(), 'image/svg+xml'))).rejects.toMatchObject({ status: 415 });
  await expect(storeThumbnail(reserved.id, reserved.capability, thumbnailRequest(Buffer.alloc(65537)))).rejects.toMatchObject({ status: 413 });
  const wrongSize = thumbnailPNG(); wrongSize.writeUInt32BE(256, 16);
  await expect(storeThumbnail(reserved.id, reserved.capability, thumbnailRequest(wrongSize))).rejects.toMatchObject({ status: 400 });
  await storeThumbnail(reserved.id, reserved.capability, thumbnailRequest());
  await expect(readThumbnail(reserved.id)).rejects.toMatchObject({ status: 404 });
  await expect(storeThumbnail(reserved.id, reserved.capability, thumbnailRequest())).rejects.toMatchObject({ status: 409 });
  await upload(reserved.id, reserved.capability, body(), mailer, { verifiedEmail: 'test@purdue.edu' });
  const image = await readThumbnail(reserved.id);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('cache-control')).toContain('no-store');
  expect(Buffer.from(await image.arrayBuffer())).toEqual(thumbnailPNG());
  const [job] = await (await db())`SELECT storage_key FROM jobs WHERE id = ${reserved.id}`;
  await removeFile(job.storage_key);
  expect(await Bun.file(thumbnailPath(job.storage_key)).exists()).toBe(false);
});

test('push thumbnails use a scoped expiring image capability and batches can use a later file', async () => {
  await subscribeDevice(context(), 1, subscription());
  const batch = await reserveBatch({ title: 'Artwork batch', email: 'test@purdue.edu', items: ['left.stl', 'right.stl'].map(original_filename => ({ original_filename, file_size: new Blob([asciiSTL]).size })) });
  await storeThumbnail(batch.items[1].id, batch.items[1].capability, thumbnailRequest());
  for (const item of batch.items) await upload(item.id, item.capability, body(), mailer, { deferEmail: true });
  await finalizeBatch(batch.batchToken, mailer, { verifiedEmail: 'test@purdue.edu' });
  await dispatchPush(Date.now(), sender);
  expect(accepted).toHaveLength(1);
  const url = new URL(accepted[0].thumbnail!, 'http://localhost:4321');
  expect(url.pathname).toBe(`/api/print-thumbnails/${batch.items[1].id}`);
  const token = url.searchParams.get('token')!;
  expect(unseal(token, 'thumbnail').id).toBe(batch.items[1].id);
  expect(() => unseal(token, 'upload')).toThrow('invalid');
  expect(() => unseal(token, 'thumbnail', Date.now() + 25 * 3600000)).toThrow('expired');
  await expect(storeThumbnail(batch.items[0].id, batch.items[0].capability, thumbnailRequest())).rejects.toMatchObject({ status: 409 });
});

test('expired pending thumbnails and orphan images are cleaned while confirmed thumbnails survive', async () => {
  const pending = await reserve(submission()), confirmed = await reserve(submission());
  for (const item of [pending, confirmed]) await storeThumbnail(item.id, item.capability, thumbnailRequest());
  await upload(confirmed.id, confirmed.capability, body(), mailer, { verifiedEmail: 'test@purdue.edu' });
  const sql = await db();
  const rows = await sql`SELECT id, storage_key FROM jobs`;
  await sql`UPDATE jobs SET upload_expires_at = 1 WHERE id = ${pending.id}`;
  const pendingPath = thumbnailPath(rows.find((job: { id: string }) => job.id === pending.id).storage_key);
  const confirmedPath = thumbnailPath(rows.find((job: { id: string }) => job.id === confirmed.id).storage_key);
  await cleanup();
  expect(await Bun.file(pendingPath).exists()).toBe(false);
  expect(await Bun.file(confirmedPath).exists()).toBe(true);
  // Use a future cleanup time so a newly written, unreferenced image meets the orphan age threshold.
  const orphanPath = thumbnailPath('12345678-1234-1234-1234-123456789abc.stl');
  await Bun.write(orphanPath, thumbnailPNG());
  await cleanup(Date.now() + 3 * 3600000);
  expect(await Bun.file(orphanPath).exists()).toBe(false);
  expect(await Bun.file(confirmedPath).exists()).toBe(true);
});
async function uploadedBatch() {
  const batch = await reserveBatch({ title: 'Batch', email: 'test@purdue.edu', items: [
    { original_filename: 'left.stl', file_size: new Blob([asciiSTL]).size },
    { original_filename: 'right.stl', file_size: new Blob([asciiSTL]).size },
  ] });
  for (const item of batch.items) await upload(item.id, item.capability, body(), mailer, { deferEmail: true });
  return batch;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-push-'));
  process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test'; process.env.APP_ORIGIN = 'http://localhost:4321';
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  await migrate();
});
beforeEach(async () => {
  process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:operator@example.edu';
  const sql = await db();
  await sql`DELETE FROM push_events`; await sql`DELETE FROM push_subscriptions`; await sql`DELETE FROM jobs`; await sql`DELETE FROM sessions`; await sql`DELETE FROM operators`;
  await sql`INSERT INTO operators (id, username, password_hash) VALUES (1, 'first', 'hash'), (2, 'second', 'hash')`;
  accepted.length = 0;
});
afterAll(async () => {
  await closeDb(); await rm(dir, { recursive: true, force: true });
  for (const name of ['DATA_DIR', 'NODE_ENV', 'APP_ORIGIN', 'CONFIRMATION_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
  }
});

test('VAPID configuration validates matching keys and allows push to be disabled', () => {
  expect(pushConfig()?.publicKey).toBe(keys.publicKey);
  process.env.VAPID_PRIVATE_KEY = webPush.generateVAPIDKeys().privateKey;
  expect(() => pushConfig()).toThrow('matching');
  process.env.VAPID_PUBLIC_KEY = ''; process.env.VAPID_PRIVATE_KEY = ''; process.env.VAPID_SUBJECT = '';
  expect(pushConfig()).toBeNull();
  process.env.VAPID_SUBJECT = 'invalid';
  expect(() => pushConfig()).toThrow();
});

test('subscription validation rejects private destinations, lookalike hosts and malformed keys', () => {
  const valid = subscription();
  expect(validateSubscription(valid)).toEqual(valid);
  for (const endpoint of ['https://127.0.0.1/private', 'http://fcm.googleapis.com/path', 'https://fcm.googleapis.com.evil.test/path',
    'https://fcm.googleapis.com:444/path', 'https://user@fcm.googleapis.com/path', 'https://fcm.googleapis.com/path#secret']) {
    expect(() => validateSubscription({ ...valid, endpoint })).toThrow();
  }
  expect(() => validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'bad' } })).toThrow();
  expect(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: 'A'.repeat(87) } })).toThrow();
});

test('a device has one owner, explicit re-enable replaces it, and another login revokes the old owner', async () => {
  const device = context(), sub = subscription();
  await subscribeDevice(device, 1, sub);
  expect(await pushStatus(device, 1)).toMatchObject({ enabled: true, endpoint: sub.endpoint });
  await subscribeDevice(device, 2, sub);
  expect((await pushStatus(device, 1)).enabled).toBe(false);
  expect(await (await db())`SELECT * FROM push_subscriptions`).toHaveLength(1);
  await revokeDevice(device, 1);
  expect((await pushStatus(device, 2)).enabled).toBe(false);
});

test('normal confirmation and verified single uploads create exactly one first-queue event each', async () => {
  await subscribeDevice(context(), 1, subscription());
  const pending = await reserve(submission());
  await upload(pending.id, pending.capability, body(), mailer);
  const token = seal(pending.id, 'confirm', Date.now() + 60000);
  await confirmation(token);
  expect(await (await db())`SELECT * FROM push_events`).toHaveLength(0);
  await Promise.all([confirmation(token, true), confirmation(token, true)]);
  await queueOne();
  await dispatchPush(Date.now(), sender);
  expect(accepted).toHaveLength(2);
  expect(accepted.every(message => message.url === '/operator')).toBe(true);
  expect(accepted.every(message => message.title === 'Test bracket' && message.body === '1 file · test@purdue.edu')).toBe(true);
  expect(JSON.stringify(accepted)).not.toMatch(/Private notes|bracket\.stl/);
  await dispatchPush(Date.now(), sender);
  expect(accepted).toHaveLength(2);
});

test('normal and verified batches send one alert per batch, with no requeue alerts', async () => {
  await subscribeDevice(context(), 1, subscription());
  const normal = await uploadedBatch();
  await finalizeBatch(normal.batchToken, mailer);
  const token = seal(normal.items.map(item => item.id), 'confirm', Date.now() + 60000);
  await confirmation(token, true);
  const verified = await uploadedBatch();
  await finalizeBatch(verified.batchToken, mailer, { verifiedEmail: 'test@purdue.edu' });
  await updateStatus(normal.items[0].id, 'canceled', 1, 1, { mailer });
  await updateStatus(normal.items[0].id, 'queued', 2, 1, { mailer });
  await dispatchPush(Date.now(), sender);
  expect(accepted).toHaveLength(2);
  expect(accepted.every(message => message.title === 'Batch' && message.body === '2 files · test@purdue.edu')).toBe(true);
  expect(await (await db())`SELECT * FROM push_event_jobs`).toHaveLength(4);
});

test('multiple copies still count as one file and alerts retain the original submission details', async () => {
  await subscribeDevice(context(), 1, subscription());
  const print = await reserve(submission({ title: 'Robot arm', copies: 5 }));
  await upload(print.id, print.capability, body(), mailer, { verifiedEmail: 'test@purdue.edu' });
  await (await db())`UPDATE jobs SET title = 'Changed later', email = 'changed@purdue.edu' WHERE id = ${print.id}`;
  await dispatchPush(Date.now(), sender);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ title: 'Robot arm', body: '1 file · test@purdue.edu' });
});

test('failed event creation rolls the queue transition back atomically', async () => {
  const pending = await reserve(submission()); await upload(pending.id, pending.capability, body(), mailer);
  const sql = await db();
  await sql.unsafe("CREATE TRIGGER fail_push BEFORE INSERT ON push_events BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
  try {
    await expect(confirmation(seal(pending.id, 'confirm', Date.now() + 60000), true)).rejects.toThrow();
    expect((await sql`SELECT status FROM jobs WHERE id = ${pending.id}`)[0].status).toBe('pending_confirmation');
    expect(await sql`SELECT * FROM push_event_jobs`).toHaveLength(0);
  } finally { await sql.unsafe('DROP TRIGGER fail_push'); }
});

test('a dispatcher never sends an event from an uncommitted or rolled-back transaction', async () => {
  await subscribeDevice(context(), 1, subscription());
  const pending = await reserve(submission()), sql = await db();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transaction = sql.begin(async tx => {
    await recordQueuePush(tx, [pending.id], Date.now());
    entered.resolve(); await release.promise;
    throw new Error('roll back submission');
  });
  const rolledBack = transaction.catch(() => {});
  await entered.promise;
  const dispatching = dispatchPush(Date.now(), sender);
  try { await Bun.sleep(30); expect(accepted).toHaveLength(0); }
  finally { release.resolve(); await rolledBack; await dispatching; }
  expect(accepted).toHaveLength(0);
});

test('concurrent verified batch finalization preserves confirmed files and creates one alert', async () => {
  await subscribeDevice(context(), 1, subscription());
  const batch = await uploadedBatch();
  const results = await Promise.allSettled([
    finalizeBatch(batch.batchToken, mailer, { verifiedEmail: 'test@purdue.edu' }),
    finalizeBatch(batch.batchToken, mailer, { verifiedEmail: 'test@purdue.edu' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await (await db())`SELECT * FROM push_events`).toHaveLength(1);
  for (const item of batch.items) expect(await Bun.file(filePath(item.id + '.stl')).exists()).toBe(true);
});

test('late subscribers get no backlog and session expiry does not revoke background opt-in', async () => {
  await queueOne();
  const device = context(); await subscribeDevice(device, 1, subscription());
  const sql = await db(); await sql`DELETE FROM sessions`;
  await dispatchPush(Date.now(), sender); expect(accepted).toHaveLength(0);
  await queueOne(); await dispatchPush(Date.now(), sender); expect(accepted).toHaveLength(1);
});

test('temporary failures retry only failed devices, respecting Retry-After', async () => {
  await subscribeDevice(context(), 1, subscription('desktop')); await subscribeDevice(context(), 2, subscription('phone'));
  await queueOne();
  const now = Date.now();
  const calls: string[] = [];
  await dispatchPush(now, async (sub, message) => {
    calls.push(sub.endpoint);
    if (sub.endpoint.endsWith('phone')) throw new PushDeliveryError(429, 60000);
    accepted.push(message);
  });
  expect(calls).toHaveLength(2); expect(accepted).toHaveLength(1);
  await dispatchPush(now + 59999, sender); expect(accepted).toHaveLength(1);
  await dispatchPush(now + 60000, sender); expect(accepted).toHaveLength(2);
  const rows = await (await db())`SELECT attempts FROM push_deliveries ORDER BY attempts`;
  expect(rows.map((row: { attempts: number }) => row.attempts)).toEqual([1, 2]);
});

test('leases prevent duplicate concurrent sends and recover after a database reopen', async () => {
  await subscribeDevice(context(), 1, subscription()); await queueOne();
  const now = Date.now(), sql = await db();
  await sql`UPDATE push_deliveries SET lease_until = ${now + 30000}`;
  await closeDb();
  await dispatchPush(now + 29999, sender); expect(accepted).toHaveLength(0);
  await Promise.all([dispatchPush(now + 30000, sender), dispatchPush(now + 30000, sender)]);
  expect(accepted).toHaveLength(1);
});

test('expired subscriptions are removed, permanent failures stop, and stale events expire', async () => {
  await subscribeDevice(context(), 1, subscription('gone')); await subscribeDevice(context(), 2, subscription('forbidden'));
  await queueOne(); const now = Date.now();
  await dispatchPush(now, async sub => { throw new PushDeliveryError(sub.endpoint.endsWith('gone') ? 410 : 403); });
  expect(await (await db())`SELECT * FROM push_subscriptions`).toHaveLength(1);
  expect((await (await db())`SELECT failed_at FROM push_deliveries`)[0].failed_at).not.toBeNull();
  await dispatchPush(now + 3600000, sender);
  expect(await (await db())`SELECT * FROM push_events`).toHaveLength(0);
  expect(await (await db())`SELECT * FROM push_deliveries`).toHaveLength(0);
  expect(accepted).toHaveLength(0);
});

test('logout, reset and removal revoke queued device deliveries', async () => {
  const device = context(); await subscribeDevice(device, 1, subscription()); await queueOne();
  await logout(device); await dispatchPush(Date.now(), sender); expect(accepted).toHaveLength(0);
  await subscribeDevice(device, 1, subscription());
  await editOperator(2, 1, { username: 'first', password: 'replacement-password-123' });
  expect((await pushStatus(device, 1)).enabled).toBe(false);
  await subscribeDevice(device, 1, subscription());
  await removeOperator(2, 1);
  expect(await (await db())`SELECT * FROM push_subscriptions`).toHaveLength(0);
});

test('test notifications target only this device and expired endpoints disable it', async () => {
  const device = context(); await subscribeDevice(device, 1, subscription());
  await testDevice(device, 1, sender); expect(accepted).toHaveLength(1);
  await expect(testDevice(device, 2, sender)).rejects.toMatchObject({ status: 409 });
  await expect(testDevice(device, 1, async () => { throw new PushDeliveryError(410); })).rejects.toMatchObject({ status: 502 });
  expect((await pushStatus(device, 1)).enabled).toBe(false);
});

test('the test button includes the latest available print thumbnail', async () => {
  const device = context(); await subscribeDevice(device, 1, subscription());
  const reserved = await reserve(submission());
  await storeThumbnail(reserved.id, reserved.capability, thumbnailRequest());
  await upload(reserved.id, reserved.capability, body(), mailer, { verifiedEmail: 'test@purdue.edu' });
  await testDevice(device, 1, sender);
  expect(new URL(accepted[0].thumbnail!, 'http://localhost:4321').pathname).toBe(`/api/print-thumbnails/${reserved.id}`);
});

test('the real Bun transport encrypts data, uses VAPID and rejects redirects', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
  try {
    await sendPush(subscription(), { eventId: 'test', title: 'test', body: 'private payload', url: '/operator' }, 60);
    const [endpoint, init] = fetchSpy.mock.calls[0];
    expect(endpoint).toContain('https://fcm.googleapis.com/');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toContain('vapid');
    expect(new Headers(init?.headers).get('ttl')).toBe('60');
    expect(Buffer.from(init?.body as Uint8Array).toString()).not.toContain('private payload');
  } finally { fetchSpy.mockRestore(); }
});

test('operator snapshots include new arrivals beyond the current page', async () => {
  const first = await operatorQueue(); await queueOne();
  const next = await operatorQueue('all', '2');
  expect(next.jobs).toHaveLength(0); expect(next.revision).not.toBe(first.revision);
});
