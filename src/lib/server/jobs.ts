import { randomUUID } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { metadata } from './validation';
import { seal, unseal } from './tokens';
import { invariant, HttpError } from './errors';
import { removeFile, storeUpload } from './storage';
import { sendMail, confirmationMessage, statusMessage, type Mailer } from './mail';
import { MAX_FEEDBACK_LENGTH, transitions, type Job, type PublicJob, type Status } from '../shared';
import { logError, logFailure } from './log';

export async function reserve(input: unknown) {
  const data = metadata(input), sql = await db(), now = Date.now();
  const id = randomUUID(), expires = now + config().uploadTTL;
  // Create the capability before the pending job, so misconfiguration leaves no incomplete submission.
  const capability = seal(id, 'upload', expires);
  const rows = await sql`
    INSERT INTO jobs (id, email, title, notes, infill, color, layer_height, supports, copies, mirror,
      original_filename, storage_key, file_size, upload_state, pending_expires_at, upload_expires_at, created_at)
    SELECT ${id}, ${data.email}, ${data.title}, ${data.notes}, ${data.infill}, ${data.color}, ${data.layer_height},
      ${data.supports}, ${data.copies}, ${data.mirror}, ${data.original_filename}, ${id + '.stl'}, ${data.file_size},
      'reserved', ${now + 86400000}, ${expires}, ${now}
    WHERE (SELECT COUNT(*) FROM jobs WHERE email = ${data.email} AND status = 'pending_confirmation') < 3
    RETURNING id`;
  invariant(rows.length, 429, 'You have three unconfirmed submissions. Confirm them or try again after cleanup.');
  return { id, capability };
}
let activeUploads = 0;
export async function upload(id: string, token: string, request: Request, mailer: Mailer = sendMail) {
  const payload = unseal(token, 'upload');
  invariant(payload.id === id, 403, 'This upload link belongs to another print.');
  const sql = await db();
  invariant(activeUploads < config().maxUploads, 503, 'The upload slots are busy. Please try again shortly.');
  activeUploads++;
  let claimed: Job | undefined;
  try {
    [claimed] = await sql`UPDATE jobs SET upload_state = 'uploading'
      WHERE id = ${id} AND upload_state = 'reserved' AND status = 'pending_confirmation' AND upload_expires_at > ${Date.now()}
      RETURNING *`;
    invariant(claimed, 409, 'This upload has already been used or has expired. Submit a new print.');
    await storeUpload(request, claimed.storage_key, claimed.file_size, claimed.upload_expires_at);
    const expiry = Date.now() + 86400000;
    const [updated] = await sql`UPDATE jobs SET upload_state = 'uploaded', pending_expires_at = ${expiry}
      WHERE id = ${id} AND upload_state = 'uploading' AND upload_expires_at > ${Date.now()} RETURNING *`;
    invariant(updated, 410, 'The upload expired. Please try again.');
    try { await mailer(confirmationMessage(updated, seal(id, 'confirm', expiry)), { jobId: id, purpose: 'confirmation' }); }
    catch (cause) { throw new HttpError(502, 'We could not send the confirmation email. Your submission was removed; please try again later.', { cause }); }
    const ready = await sql`UPDATE jobs SET upload_state = 'ready'
      WHERE id = ${id} AND upload_state = 'uploaded' AND upload_expires_at > ${Date.now()} RETURNING id`;
    invariant(ready.length, 410, 'The submission expired. Please submit again, even if an email arrived.');
    return { message: 'Check your Purdue email. Open the link and confirm within 24 hours to join the queue.' };
  } catch (e) {
    logFailure('submission.failed', e, { jobId: id });
    if (claimed) {
      try {
        await sql`DELETE FROM jobs WHERE id = ${id} AND status = 'pending_confirmation'`;
        await removeFile(claimed.storage_key);
      } catch (cleanupError) {
        logError('submission.cleanup_failed', cleanupError, { jobId: id });
        throw new HttpError(500, 'The submission failed and cleanup could not finish. Please contact the operator.', { cause: e });
      }
    }
    throw e;
  } finally { activeUploads--; }
}
export async function confirmation(token: string, commit = false) {
  const { id } = unseal(token, 'confirm');
  const sql = await db();
  const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
  invariant(job, 410, 'This submission is no longer available. Please submit your print again.');
  if (job.confirmed_at) return { job, already: true };
  invariant(job.pending_expires_at > Date.now(), 410, 'This confirmation has expired. Please submit again.');
  invariant(job.upload_state === 'ready', 409, 'This submission is not ready. Wait a moment and open the link again.');
  if (commit) {
    const now = Date.now();
    const rows = await sql`UPDATE jobs SET status = 'queued', confirmed_at = ${now}, queued_at = ${now}, version = version + 1
      WHERE id = ${id} AND status = 'pending_confirmation' AND upload_state = 'ready' AND pending_expires_at > ${now} RETURNING *`;
    if (rows.length) return { job: rows[0] as Job, already: false };
    const [current]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    invariant(current?.confirmed_at, 410, 'This confirmation expired. Please submit again.');
    return { job: current, already: true };
  }
  return { job, already: false };
}
export async function publicQueue(): Promise<PublicJob[]> {
  const sql = await db();
  return sql`SELECT id, title, status, infill, color, layer_height, supports, copies, mirror, queued_at, confirmed_at, version
    FROM jobs WHERE status IN ('queued', 'printing') AND confirmed_at IS NOT NULL
    ORDER BY CASE status WHEN 'printing' THEN 0 ELSE 1 END, queued_at, id`;
}
export async function updateStatus(id: string, next: Status, version: number, operator: number,
  { feedback: input = '', mailer = sendMail }: { feedback?: unknown; mailer?: Mailer } = {}) {
  invariant(Object.hasOwn(transitions, next) && Number.isSafeInteger(version), 400, 'Invalid status update.');
  invariant(typeof input === 'string' && input.length <= MAX_FEEDBACK_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input),
    400, `Feedback must be text with at most ${MAX_FEEDBACK_LENGTH} characters.`);
  const feedback = input.trim();
  invariant(next !== 'rejected' || feedback.length > 0, 400, 'Provide feedback before rejecting and returning this print.');
  invariant(next === 'rejected' || feedback.length === 0, 400, 'Feedback is only supported when rejecting and returning a print.');
  const sql = await db();
  const result = await sql.begin(async tx => {
    // A conditional UPDATE is the first statement, acquiring SQLite's write lock before reading.
    const [job]: Job[] = await tx`UPDATE jobs SET version = version WHERE id = ${id} AND confirmed_at IS NOT NULL RETURNING *`;
    invariant(job, 404, 'Print not found.');
    invariant(job.version === version, 409, 'Another operator changed this print. Refresh before trying again.');
    if (job.status === next) return { job, changed: false };
    invariant(transitions[job.status as Status]?.includes(next), 400, 'That status transition is not allowed.');
    const now = Date.now();
    const [updated]: Job[] = await tx`UPDATE jobs SET status = ${next}, version = version + 1,
      queued_at = ${next === 'queued' ? now : job.queued_at} WHERE id = ${id} RETURNING *`;
    await tx`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
      VALUES (${id}, ${job.status}, ${next}, ${operator}, ${now}, ${feedback})`;
    return { job: updated, changed: true };
  });
  let warning: string | undefined;
  if (result.changed) {
    try { await mailer(statusMessage(result.job, feedback), { jobId: id, purpose: 'status' }); }
    catch (error) {
      logError('job.notification_failed', error, { jobId: id, operatorId: operator, jobStatus: result.job.status, version: result.job.version });
      warning = 'Status saved, but the notification email failed. Contact the submitter directly; email will not be retried automatically.';
    }
  }
  return { ...result, warning };
}
