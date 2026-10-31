import { randomUUID } from 'node:crypto';
import { db } from './db';
import { HttpError, invariant } from './errors';
import { rateLimit } from './http';
import { cancellationMessage, sendMail, type Mailer } from './mail';
import { seal, unseal } from './tokens';
import { MAX_BATCH_SIZE, type Job } from '../shared';

interface CancellationItem { id: string; version: number }
interface CancellationRequest { id: string; items: string; expires_at: number; consumed_at: number | null }

export async function requestCancellation(rawIds: unknown, rawEmail: unknown, mailer: Mailer = sendMail) {
  invariant(Array.isArray(rawIds) && rawIds.length > 0 && rawIds.length <= MAX_BATCH_SIZE &&
    rawIds.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) && new Set(rawIds).size === rawIds.length,
  400, `Select between 1 and ${MAX_BATCH_SIZE} prints from one submission.`);
  invariant(typeof rawEmail === 'string' && rawEmail.length <= 254, 400, 'Enter the email used for this submission.');
  const email = rawEmail.trim().toLowerCase();
  invariant(email.endsWith('@purdue.edu'), 400, 'Enter the Purdue email used for this submission.');
  const sql = await db(), jobs: Job[] = [];
  for (const id of rawIds) {
    const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id} AND confirmed_at IS NOT NULL`;
    invariant(job && job.email.toLowerCase() === email, 400, 'The selected prints do not match that submission email. Check your selection and email.');
    invariant(job.status === 'queued', 409, 'Only queued prints can be canceled here. If printing has started, contact an operator.');
    jobs.push(job);
  }
  const first = jobs[0];
  invariant(jobs.every(job => (job.batch_id ?? job.id) === (first.batch_id ?? first.id)),
    400, 'Select prints from the same original submission.');
  rateLimit('cancellation-email:' + first.email.toLowerCase(), 3, 15 * 60 * 1000);
  rateLimit('cancellation-submission:' + (first.batch_id ?? first.id), 1, 60 * 1000);
  const id = randomUUID(), expires = Date.now() + 60 * 60 * 1000;
  const token = seal(id, 'cancel', expires);
  const items = JSON.stringify(jobs.map(job => ({ id: job.id, version: job.version })));
  await sql`INSERT INTO cancellation_requests (id, items, expires_at) VALUES (${id}, ${items}, ${expires})`;
  try {
    await mailer(cancellationMessage(jobs, token), { jobId: first.id, purpose: 'cancellation' });
  } catch (cause) {
    await sql`DELETE FROM cancellation_requests WHERE id = ${id}`;
    throw new HttpError(502, 'We could not send the cancellation email. Your prints are still queued. Please try again later.', { cause });
  }
  return { message: 'Check your email to confirm cancellation.' };
}

export async function cancellation(token: string, commit = false) {
  const { id } = unseal(token, 'cancel');
  const sql = await db();
  return sql.begin(async tx => {
    // Acquire the write lock before checking versions, so operators and repeated confirmations cannot race the cancellation.
    const [request]: CancellationRequest[] = commit
      ? await tx`UPDATE cancellation_requests SET id = id WHERE id = ${id} RETURNING *`
      : await tx`SELECT * FROM cancellation_requests WHERE id = ${id}`;
    invariant(request && request.expires_at > Date.now(), 410, 'This cancellation link has expired or is no longer available. Request a new link from the queue.');
    const items: CancellationItem[] = JSON.parse(request.items), jobs: Job[] = [];
    for (const item of items) {
      const [job]: Job[] = await tx`SELECT * FROM jobs WHERE id = ${item.id} AND confirmed_at IS NOT NULL`;
      invariant(job, 410, 'One of these prints is no longer available. Return to the queue.');
      jobs.push(job);
    }
    if (request.consumed_at !== null) return { jobs, already: true };
    for (let i = 0; i < jobs.length; i++) {
      invariant(jobs[i].status === 'queued', 409, 'One or more selected prints are no longer queued. Nothing was canceled with this link. If printing has started, contact an operator.');
      invariant(jobs[i].version === items[i].version, 409, 'One or more selected prints have changed. Nothing was canceled with this link. Return to the queue and request a new link.');
    }
    if (!commit) return { jobs, already: false };
    const now = Date.now(), updated: Job[] = [];
    for (const job of jobs) {
      const [changed]: Job[] = await tx`UPDATE jobs SET status = 'canceled', version = version + 1
        WHERE id = ${job.id} AND status = 'queued' AND version = ${job.version} RETURNING *`;
      invariant(changed, 409, 'A selected print has changed. Nothing was canceled. Request a new link from the queue.');
      await tx`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
        VALUES (${job.id}, 'queued', 'canceled', NULL, ${now}, 'Canceled by submitter via email confirmation.')`;
      updated.push(changed);
    }
    await tx`UPDATE cancellation_requests SET consumed_at = ${now} WHERE id = ${id}`;
    return { jobs: updated, already: false };
  });
}
