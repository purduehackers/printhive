import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { migrate, closeDb, db } from '../src/lib/server/db';
import { reserve, upload, confirmation, updateStatus, batchUpdateStatus, resendNotification, resendBatchNotifications } from '../src/lib/server/jobs';
import { isTransientMailError } from '../src/lib/server/mail';
import { submission, asciiSTL } from './fixtures';

let dir: string;
// Minimal SMTP sink so route-level tests exercise the real sendMail path.
let smtp: ReturnType<typeof createServer>;
const smtpSockets = new Set<Socket>();
const smtpMessages: string[] = [];
const accepted: string[] = [];
const mailer = async (mail: { text: string }) => { accepted.push(mail.text); };
const rejectedMailer = async () => { throw new Error('SMTP unavailable'); };
const body = (text: BodyInit = asciiSTL) => new Request('http://localhost:4321/file', { method: 'PUT', body: text });
const confirmationToken = () => new URL(accepted.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0]).searchParams.get('token')!;

async function ready(custom: Partial<Parameters<typeof submission>[0]> = {}) {
  const r = await reserve(submission(custom));
  await upload(r.id, r.capability, body(), mailer);
  return { ...r, token: confirmationToken() };
}

async function queued(custom: Partial<Parameters<typeof submission>[0]> = {}) {
  const r = await ready(custom);
  await confirmation(r.token, true);
  return r;
}

async function eventOf(jobId: string) {
  const sql = await db();
  const [event] = await sql`SELECT * FROM job_events WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`;
  return event as { id: number; notification_status: string; next_status: string; feedback: string };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-notify-test-'));
  process.env.DATA_DIR = dir;
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321';
  process.env.NODE_ENV = 'test';
  smtp = createServer(socket => {
    smtpSockets.add(socket); socket.on('close', () => smtpSockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.write('220 localhost ESMTP test sink\r\n');
    let buffer = '', inData = false, message = '';
    socket.on('data', data => {
      buffer += data;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') { inData = false; smtpMessages.push(message); message = ''; socket.write('250 queued\r\n'); }
          else message += line + '\r\n';
        } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 End with dot\r\n'); }
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = (smtp.address() as { port: number }).port;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USERNAME = '';
  process.env.SMTP_PASSWORD = '';
  process.env.SMTP_FROM = 'PrintHive <test@example.test>';
  await migrate();
  const sql = await db();
  await sql`INSERT INTO operators (id, username, password_hash) VALUES (1, 'operator', 'test')`;
});

beforeEach(async () => {
  const sql = await db();
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_events`;
  accepted.length = 0;
  smtpMessages.length = 0;
});

afterAll(async () => {
  await closeDb();
  for (const socket of smtpSockets) socket.destroy();
  await new Promise<void>(resolve => smtp.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('transient mail error classification', () => {
  test('socket/timeout codes and SMTP 4xx are transient; auth, envelope and 5xx are not', () => {
    expect(isTransientMailError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientMailError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientMailError(Object.assign(new Error('greylisted'), { code: 'ESOCKET', responseCode: 421 }))).toBe(true);
    expect(isTransientMailError(Object.assign(new Error('rate limited'), { responseCode: 450 }))).toBe(true);
    expect(isTransientMailError(Object.assign(new Error('rejected'), { code: 'EENVELOPE', responseCode: 550 }))).toBe(false);
    expect(isTransientMailError(Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 }))).toBe(false);
    expect(isTransientMailError(Object.assign(new Error('permanent'), { responseCode: 550 }))).toBe(false);
    expect(isTransientMailError(new Error('SMTP unavailable'))).toBe(false);
    expect(isTransientMailError('nope')).toBe(false);
    expect(isTransientMailError(null)).toBe(false);
  });
});

describe('notification delivery tracking and retry', () => {
  test('a failed status email marks the event failed, reports the event id, and a retry resends it', async () => {
    const job = await queued({ title: 'Retry Me' });
    accepted.length = 0;
    const result = await updateStatus(job.id, 'printing', 1, 1, { mailer: rejectedMailer });
    expect(result.warning).toContain('Status saved, but the notification email failed');
    expect(Number.isSafeInteger(result.eventId)).toBe(true);
    expect((await eventOf(job.id)).notification_status).toBe('failed');
    expect(accepted).toHaveLength(0);

    accepted.length = 0;
    const retry = await resendNotification(job.id, 1, { mailer });
    expect(retry).toMatchObject({ sent: true, eventId: result.eventId });
    expect((await eventOf(job.id)).notification_status).toBe('sent');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain('printing');
    expect(accepted[0]).toContain('Retry Me');
  });

  test('a retry that fails again keeps the event failed and returns a warning', async () => {
    const job = await queued();
    await updateStatus(job.id, 'printing', 1, 1, { mailer: rejectedMailer });
    const retry = await resendNotification(job.id, 1, { mailer: rejectedMailer });
    expect(retry.sent).toBe(false);
    expect(retry.warning).toContain('failed again');
    expect((await eventOf(job.id)).notification_status).toBe('failed');
  });

  test('retrying a rejection resends the operator feedback', async () => {
    const job = await queued({ title: 'Bad Overhangs' });
    const feedback = 'Overhangs exceed 45 degrees. Add supports.';
    await updateStatus(job.id, 'rejected', 1, 1, { feedback, mailer: rejectedMailer });
    accepted.length = 0;
    const retry = await resendNotification(job.id, 1, { mailer });
    expect(retry.sent).toBe(true);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain(feedback);
    expect(accepted[0]).toContain('rejected');
    expect((await eventOf(job.id)).notification_status).toBe('sent');
  });

  test('retry validates the job, event and event ownership', async () => {
    const job = await queued();
    await expect(resendNotification('not-a-job', 1, { mailer })).rejects.toMatchObject({ status: 404 });
    await expect(resendNotification(job.id, 1, { mailer })).rejects.toMatchObject({ status: 409 });
    await expect(resendNotification(job.id, 0, { mailer })).rejects.toMatchObject({ status: 401 });

    const other = await queued();
    const failed = await updateStatus(job.id, 'printing', 1, 1, { mailer: rejectedMailer });
    await expect(resendNotification(other.id, 1, { eventId: failed.eventId, mailer })).rejects.toMatchObject({ status: 404 });
    await expect(resendNotification(job.id, 1, { eventId: 'x' as any, mailer })).rejects.toMatchObject({ status: 400 });
    // A specific event can be resent explicitly.
    const explicit = await resendNotification(job.id, 1, { eventId: failed.eventId, mailer });
    expect(explicit.sent).toBe(true);
  });

  test('batch failures are tracked per print and a batch retry consolidates one email per submitter', async () => {
    const a1 = await queued({ title: 'Alice One', email: 'alice@purdue.edu' });
    const a2 = await queued({ title: 'Alice Two', email: 'alice@purdue.edu' });
    const b1 = await queued({ title: 'Bob One', email: 'bob@purdue.edu' });

    const result = await batchUpdateStatus([a1.id, a2.id, b1.id], 'printing', 1, { mailer: rejectedMailer });
    expect(result.updated).toHaveLength(3);
    expect(result.failed.sort()).toEqual([a1.id, a2.id, b1.id].sort());
    expect(result.warnings).toHaveLength(3);
    for (const id of [a1.id, a2.id, b1.id]) expect((await eventOf(id)).notification_status).toBe('failed');

    accepted.length = 0;
    const retry = await resendBatchNotifications([a1.id, a2.id, b1.id], 1, { mailer });
    expect(retry.warnings).toHaveLength(0);
    expect(retry.skipped).toHaveLength(0);
    expect(retry.notified).toHaveLength(3);
    expect(retry.notified.every(n => n.sent)).toBe(true);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toContain('Alice One');
    expect(accepted[0]).toContain('Alice Two');
    expect(accepted[0]).not.toContain('Bob One');
    expect(accepted[1]).toContain('Bob One');
    for (const id of [a1.id, a2.id, b1.id]) expect((await eventOf(id)).notification_status).toBe('sent');
  });

  test('batch retry skips prints without a failed notification and reports repeat failures', async () => {
    const ok = await queued({ title: 'Fine Print' });
    const bad = await queued({ title: 'Broken Print' });
    await updateStatus(ok.id, 'printing', 1, 1, { mailer });
    await updateStatus(bad.id, 'printing', 1, 1, { mailer: rejectedMailer });

    const skipped = await resendBatchNotifications([ok.id, bad.id], 1, { mailer });
    expect(skipped.skipped).toEqual([ok.id]);
    expect(skipped.notified).toHaveLength(1);
    expect(skipped.notified[0]).toMatchObject({ id: bad.id, sent: true });
    expect((await eventOf(ok.id)).notification_status).toBe('sent');
    expect((await eventOf(bad.id)).notification_status).toBe('sent');

    await updateStatus(bad.id, 'completed', 2, 1, { mailer: rejectedMailer });
    const stillFailing = await resendBatchNotifications([bad.id], 1, { mailer: rejectedMailer });
    expect(stillFailing.notified).toHaveLength(1);
    expect(stillFailing.notified[0].sent).toBe(false);
    expect(stillFailing.warnings).toHaveLength(1);
    expect((await eventOf(bad.id)).notification_status).toBe('failed');

    await expect(resendBatchNotifications([], 1, { mailer })).rejects.toMatchObject({ status: 400 });
    await expect(resendBatchNotifications(['nope'], 1, { mailer })).rejects.toMatchObject({ status: 400 });
  });

  test('notification retry endpoints require an operator and resend on success', async () => {
    const { ALL } = await import('../src/pages/api/[...path]');
    const job = await queued({ title: 'API Notify' });
    await updateStatus(job.id, 'printing', 1, 1, { mailer: rejectedMailer });
    const event = await eventOf(job.id);

    const post = (path: string, payload: unknown, token?: string) => ALL({
      request: new Request(`http://localhost:4321/api/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Cookie: `printhive_session=${token}` } : {}),
        },
        body: JSON.stringify(payload),
      }),
      params: { path },
      cookies: { get: (key: string) => key === 'printhive_session' && token ? { value: token } : undefined },
    } as any);

    expect((await post(`jobs/${job.id}/notify`, {})).status).toBe(401);
    expect((await post('jobs/batch-notify', { ids: [job.id] })).status).toBe(401);

    const token = 'f'.repeat(64);
    const sql = await db();
    await sql`INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES (${createHash('sha256').update(token).digest('hex')}, 1, ${Date.now() + 60000})`;

    const single = await post(`jobs/${job.id}/notify`, { eventId: event.id }, token);
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ sent: true, eventId: event.id });
    expect(smtpMessages).toHaveLength(1);
    expect(smtpMessages[0]).toContain('printing');
    expect(smtpMessages[0]).toContain('API Notify');
    expect((await eventOf(job.id)).notification_status).toBe('sent');

    // Nothing left to retry for this print, so batch-notify skips it.
    const batch = await post('jobs/batch-notify', { ids: [job.id] }, token);
    expect(batch.status).toBe(200);
    expect(await batch.json()).toMatchObject({ skipped: [job.id], warnings: [] });
  });
});
