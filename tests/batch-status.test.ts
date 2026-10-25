import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, closeDb, db } from '../src/lib/server/db';
import { reserve, upload, confirmation, publicQueue, batchUpdateStatus } from '../src/lib/server/jobs';
import { submission, asciiSTL } from './fixtures';
import { MAX_FEEDBACK_LENGTH } from '../src/lib/shared';

let dir: string;
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-batch-test-'));
  process.env.DATA_DIR = dir;
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321';
  process.env.NODE_ENV = 'test';
  await migrate();
  const sql = await db();
  await sql`INSERT INTO operators (id, username, password_hash) VALUES (1, 'operator', 'test')`;
});

beforeEach(async () => {
  const sql = await db();
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_events`;
  accepted.length = 0;
});

afterAll(async () => {
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('batch status updates for grouped queue items', () => {
  test('multiple queued prints can be transitioned to printing simultaneously', async () => {
    const job1 = await queued({ title: 'Bracket 1' });
    const job2 = await queued({ title: 'Bracket 2' });
    const job3 = await queued({ title: 'Bracket 3' });
    accepted.length = 0;

    const result = await batchUpdateStatus(
      [job1.id, job2.id, job3.id],
      'printing',
      1,
      { mailer }
    );

    expect(result.updated).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.updated.every(j => j.status === 'printing')).toBe(true);
    expect(accepted).toHaveLength(3);
    expect(accepted.every(msg => msg.includes('printing'))).toBe(true);

    const queue = await publicQueue();
    expect(queue.filter(j => j.status === 'printing')).toHaveLength(3);

    const sql = await db();
    const events = await sql`SELECT * FROM job_events ORDER BY id ASC`;
    expect(events).toHaveLength(3);
    expect(events.every((e: { previous_status: string; next_status: string }) => e.previous_status === 'queued' && e.next_status === 'printing')).toBe(true);
  });

  test('multiple printing prints can be transitioned to completed simultaneously', async () => {
    const job1 = await queued({ title: 'Part A' });
    const job2 = await queued({ title: 'Part B' });

    // Move to printing first
    await batchUpdateStatus([job1.id, job2.id], 'printing', 1, { mailer });
    accepted.length = 0;

    // Transition all to completed
    const result = await batchUpdateStatus(
      [job1.id, job2.id],
      'completed',
      1,
      { mailer }
    );

    expect(result.updated).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.updated.every(j => j.status === 'completed')).toBe(true);
    expect(accepted).toHaveLength(2);
    expect(accepted.every(msg => msg.includes('completed'))).toBe(true);

    const queue = await publicQueue();
    expect(queue).toHaveLength(0); // Completed jobs leave the active queue
  });

  test('multiple prints can be rejected and returned together with feedback', async () => {
    const job1 = await queued({ title: 'Overhang test 1' });
    const job2 = await queued({ title: 'Overhang test 2' });
    accepted.length = 0;

    const feedback = 'Overhangs exceed 45 degrees without supports. Please revise mesh.';
    const result = await batchUpdateStatus(
      [job1.id, job2.id],
      'rejected',
      1,
      { feedback, mailer }
    );

    expect(result.updated).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.updated.every(j => j.status === 'rejected')).toBe(true);
    expect(accepted).toHaveLength(2);
    expect(accepted.every(msg => msg.includes(feedback))).toBe(true);

    const sql = await db();
    const events = await sql`SELECT * FROM job_events WHERE next_status = 'rejected'`;
    expect(events).toHaveLength(2);
    expect(events.every((e: { feedback: string }) => e.feedback === feedback)).toBe(true);
  });

  test('batch rejection requires feedback and disallows feedback for non-rejections', async () => {
    const job1 = await queued();
    const job2 = await queued();

    // Rejection without feedback should fail
    await expect(batchUpdateStatus([job1.id, job2.id], 'rejected', 1, { feedback: '', mailer }))
      .rejects.toMatchObject({ status: 400 });

    await expect(batchUpdateStatus([job1.id, job2.id], 'rejected', 1, { feedback: '   ', mailer }))
      .rejects.toMatchObject({ status: 400 });

    // Non-rejection with feedback should fail
    await expect(batchUpdateStatus([job1.id, job2.id], 'printing', 1, { feedback: 'Unwanted feedback', mailer }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('stale version checks and invalid transitions report errors for affected prints while valid prints succeed', async () => {
    const job1 = await queued({ title: 'Valid job' });
    const job2 = await queued({ title: 'Stale job' });
    const job3 = await queued({ title: 'Completed job' });

    // Move job3 to completed
    await batchUpdateStatus([job3.id], 'printing', 1, { mailer });
    await batchUpdateStatus([job3.id], 'completed', 1, { mailer });

    accepted.length = 0;

    // Now update batch to 'printing':
    // job1 has version 1 (queued -> printing is valid)
    // job2 has version 999 (version mismatch)
    // job3 is completed (completed -> printing is invalid)
    const result = await batchUpdateStatus(
      [
        { id: job1.id, version: 1 },
        { id: job2.id, version: 999 },
        { id: job3.id, version: 3 },
      ],
      'printing',
      1,
      { mailer }
    );

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(job1.id);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.find(e => e.id === job2.id)?.error).toContain('Another operator changed this print');
    expect(result.errors.find(e => e.id === job3.id)?.error).toContain('Cannot transition from completed to printing');
    expect(accepted).toHaveLength(1);
  });

  test('items already having the target status are reported in unchanged and do not email', async () => {
    const job1 = await queued();
    accepted.length = 0;

    const result = await batchUpdateStatus([job1.id], 'queued', 1, { mailer });
    expect(result.updated).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].id).toBe(job1.id);
    expect(accepted).toHaveLength(0);
  });

  test('email failure preserves status and returns delivery warnings', async () => {
    const job1 = await queued({ title: 'Email test 1' });
    const job2 = await queued({ title: 'Email test 2' });

    const result = await batchUpdateStatus(
      [job1.id, job2.id],
      'printing',
      1,
      { mailer: rejectedMailer }
    );

    expect(result.updated).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('notification email failed');

    const queue = await publicQueue();
    expect(queue.filter(j => j.status === 'printing')).toHaveLength(2);
  });

  test('input boundary validations', async () => {
    // Empty array
    await expect(batchUpdateStatus([], 'printing', 1, { mailer })).rejects.toMatchObject({ status: 400 });

    // Over 100 items
    const many = Array.from({ length: 101 }, () => 'some-id');
    await expect(batchUpdateStatus(many, 'printing', 1, { mailer })).rejects.toMatchObject({ status: 400 });

    // Invalid status
    await expect(batchUpdateStatus(['abc'], 'invalid_status' as any, 1, { mailer })).rejects.toMatchObject({ status: 400 });

    // Excessive feedback
    await expect(batchUpdateStatus(['abc'], 'rejected', 1, { feedback: 'x'.repeat(MAX_FEEDBACK_LENGTH + 1), mailer })).rejects.toMatchObject({ status: 400 });
  });

  test('POST /api/jobs/batch-status route enforces operator auth and updates prints', async () => {
    const { ALL } = await import('../src/pages/api/[...path]');
    const job1 = await queued({ title: 'API Batch 1' });
    const job2 = await queued({ title: 'API Batch 2' });

    // 1. Unauthenticated request rejected
    const unauthContext = {
      request: new Request('http://localhost:4321/api/jobs/batch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
        body: JSON.stringify({ ids: [job1.id, job2.id], status: 'printing' }),
      }),
      params: { path: 'jobs/batch-status' },
      cookies: { get: () => undefined },
    } as any;

    const unauthRes = await ALL(unauthContext);
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated request succeeds
    const token = 'e'.repeat(64);
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const sql = await db();
    await sql`INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES (${tokenHash}, 1, ${Date.now() + 60000})`;

    const authContext = {
      request: new Request('http://localhost:4321/api/jobs/batch-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:4321',
          Cookie: `printhive_session=${token}`,
        },
        body: JSON.stringify({ ids: [job1.id, job2.id], status: 'printing' }),
      }),
      params: { path: 'jobs/batch-status' },
      cookies: { get: (key: string) => key === 'printhive_session' ? { value: token } : undefined },
    } as any;

    const authRes = await ALL(authContext);
    expect(authRes.status).toBe(200);
    const data = await authRes.json();
    expect(data.updated).toHaveLength(2);
    expect(data.updated.every((j: any) => j.status === 'printing')).toBe(true);

    const [updated1] = await sql`SELECT status FROM jobs WHERE id = ${job1.id}`;
    const [updated2] = await sql`SELECT status FROM jobs WHERE id = ${job2.id}`;
    expect(updated1.status).toBe('printing');
    expect(updated2.status).toBe('printing');
  });
});
