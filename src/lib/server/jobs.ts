import { randomUUID } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { metadata, batchMetadata, validateGroupName, type AllowedMaterial } from './validation';
import { seal, unseal } from './tokens';
import { invariant, HttpError } from './errors';
import { removeFile, storeUpload } from './storage';
import { sendMail, confirmationMessage, statusMessage, type Mailer } from './mail';
import { MAX_BATCH_SIZE, MAX_FEEDBACK_LENGTH, transitions, type Job, type PublicJob, type Status } from '../shared';
import { logError, logFailure } from './log';
import { listMaterialsWithColors } from './materials';
import { recordQueuePush } from './push';

async function loadAllowedMaterials() {
  let allowedMaterials: AllowedMaterial[] | undefined;
  try {
    const mats = await listMaterialsWithColors();
    if (mats.length) {
      allowedMaterials = mats.map(m => ({
        name: m.name,
        is_default: m.is_default,
        colors: m.colors.map(c => c.name),
        defaultColor: (m.colors.find(c => c.is_default) ?? m.colors[0])?.name,
      }));
    }
  } catch { /* Fallback to default validation if DB not ready */ }
  return allowedMaterials;
}

export async function reserve(input: unknown, { verifiedEmail = null }: { verifiedEmail?: string | null } = {}) {
  const allowedMaterials = await loadAllowedMaterials();
  const data = metadata(input, allowedMaterials), sql = await db(), now = Date.now();
  const id = randomUUID(), expires = now + config().uploadTTL;
  // Create the capability before the pending job, so misconfiguration leaves no incomplete submission.
  const capability = seal(id, 'upload', expires);
  const rows = await sql`
    INSERT INTO jobs (id, email, title, notes, infill, walls, material, color, layer_height, supports, support_angle, copies, mirror,
      original_filename, storage_key, file_size, upload_state, pending_expires_at, upload_expires_at, created_at)
    SELECT ${id}, ${data.email}, ${data.title}, ${data.notes}, ${data.infill}, ${data.walls}, ${data.material}, ${data.color}, ${data.layer_height},
      ${data.supports}, ${data.support_angle}, ${data.copies}, ${data.mirror}, ${data.original_filename}, ${id + '.stl'}, ${data.file_size},
      'reserved', ${now + 86400000}, ${expires}, ${now}
    WHERE (SELECT COUNT(*) FROM jobs WHERE email = ${data.email} AND status = 'pending_confirmation') < ${MAX_BATCH_SIZE * 3}
    RETURNING id`;
  invariant(rows.length, 429, 'You have too many unconfirmed submissions. Confirm them or try again after cleanup.');
  const verified = Boolean(verifiedEmail && verifiedEmail.toLowerCase() === data.email.toLowerCase());
  return { id, capability, verified };
}

export async function reserveBatch(input: unknown, { verifiedEmail = null }: { verifiedEmail?: string | null } = {}) {
  const allowedMaterials = await loadAllowedMaterials();
  const itemsData = batchMetadata(input, allowedMaterials), sql = await db(), now = Date.now();
  const expires = now + config().uploadTTL;
  const batchId = randomUUID();
  const batchTitle = itemsData[0].batch_title;
  const groupName = itemsData[0].group_name;
  const ids = itemsData.map(() => randomUUID());
  // Seal all capabilities and the batch token first so misconfiguration leaves no incomplete submission.
  const items = itemsData.map((data, idx) => ({
    id: ids[idx],
    title: data.title,
    original_filename: data.original_filename,
    batch_id: batchId,
    batch_title: batchTitle,
    group_name: groupName,
    capability: seal(ids[idx], 'upload', expires),
  }));
  const batchToken = seal(ids, 'upload', expires);
  const [{ count }] = await sql`SELECT COUNT(*) AS count FROM jobs WHERE email = ${itemsData[0].email} AND status = 'pending_confirmation'`;
  invariant(Number(count) + itemsData.length <= MAX_BATCH_SIZE * 3, 429, 'You have too many unconfirmed submissions. Confirm them or try again after cleanup.');
  for (let i = 0; i < itemsData.length; i++) {
    const data = itemsData[i], id = ids[i];
    await sql`
      INSERT INTO jobs (id, email, title, notes, infill, walls, material, color, layer_height, supports, support_angle, copies, mirror,
        original_filename, storage_key, file_size, upload_state, pending_expires_at, upload_expires_at, created_at, batch_id, batch_title, group_name)
      VALUES (${id}, ${data.email}, ${data.title}, ${data.notes}, ${data.infill}, ${data.walls}, ${data.material}, ${data.color}, ${data.layer_height},
        ${data.supports}, ${data.support_angle}, ${data.copies}, ${data.mirror}, ${data.original_filename}, ${id + '.stl'}, ${data.file_size},
        'reserved', ${now + 86400000}, ${expires}, ${now + i}, ${batchId}, ${data.batch_title}, ${data.group_name})`;
  }
  const verified = Boolean(verifiedEmail && verifiedEmail.toLowerCase() === itemsData[0].email.toLowerCase());
  return { batchId, batchTitle, groupName, items, batchToken, verified };
}

let activeUploads = 0;
export async function upload(
  id: string,
  token: string,
  request: Request,
  mailer: Mailer = sendMail,
  { deferEmail = false, verifiedEmail = null }: { deferEmail?: boolean; verifiedEmail?: string | null } = {},
) {
  const payload = unseal(token, 'upload');
  invariant(payload.id === id && payload.ids.length === 1, 403, 'This upload link belongs to another print.');
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
    if (deferEmail) {
      return { id, uploaded: true };
    }
    if (verifiedEmail && verifiedEmail.toLowerCase() === updated.email.toLowerCase()) {
      const now = Date.now();
      const queuedJob = await sql.begin(async tx => {
        const [job] = await tx`UPDATE jobs
          SET upload_state = 'ready', status = 'queued', confirmed_at = ${now}, queued_at = ${now}, version = version + 1
          WHERE id = ${id} AND upload_state = 'uploaded' AND status = 'pending_confirmation' AND upload_expires_at > ${now}
          RETURNING *`;
        invariant(job, 410, 'The submission expired. Please submit again.');
        await recordQueuePush(tx, [id], now);
        return job;
      });
      return {
        confirmed: true,
        job: queuedJob,
        message: 'Your print is queued. We’ll email you when the operator changes its status.',
      };
    }
    try { await mailer(confirmationMessage(updated, seal(id, 'confirm', expiry)), { jobId: id, purpose: 'confirmation' }); }
    catch (cause) { throw new HttpError(502, 'We could not send the confirmation email. Your submission was removed; please try again later.', { cause }); }
    const ready = await sql`UPDATE jobs SET upload_state = 'ready'
      WHERE id = ${id} AND upload_state = 'uploaded' AND upload_expires_at > ${Date.now()} RETURNING id`;
    invariant(ready.length, 410, 'The submission expired. Please submit again, even if an email arrived.');
    return { confirmed: false, message: 'Check your Purdue email. Open the link and confirm within 24 hours to join the queue.' };
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

export async function finalizeBatch(
  batchToken: string,
  mailer: Mailer = sendMail,
  { verifiedEmail = null }: { verifiedEmail?: string | null } = {},
) {
  const payload = unseal(batchToken, 'upload');
  const ids = payload.ids;
  const sql = await db();
  const jobs: Job[] = [];
  for (const id of ids) {
    const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    invariant(job, 410, 'One or more prints in this batch are no longer available. Please submit again.');
    invariant(job.status === 'pending_confirmation' && job.upload_expires_at > Date.now(), 410, 'The batch upload expired. Please try again.');
    invariant(job.upload_state === 'uploaded', 409, 'All files in the batch must finish uploading before sending the confirmation email.');
    jobs.push(job);
  }
  const expiry = Date.now() + 86400000;
  try {
    if (verifiedEmail && jobs.every(j => j.email.toLowerCase() === verifiedEmail.toLowerCase())) {
      const now = Date.now();
      const updatedJobs = await sql.begin(async tx => {
        const updated: Job[] = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const [queuedJob]: Job[] = await tx`UPDATE jobs
            SET upload_state = 'ready', status = 'queued', confirmed_at = ${now}, queued_at = ${now + i}, version = version + 1
            WHERE id = ${id} AND upload_state = 'uploaded' AND status = 'pending_confirmation' AND upload_expires_at > ${now}
            RETURNING *`;
          invariant(queuedJob, 410, 'The batch upload expired. Please try again.');
          updated.push(queuedJob);
        }
        await recordQueuePush(tx, updated.map(job => job.id), now);
        return updated;
      });
      return {
        confirmed: true,
        jobs: updatedJobs,
        message: 'Your prints are grouped and queued. We’ll email you when an operator changes their status.',
      };
    }
    for (const id of ids) {
      const updated = await sql`UPDATE jobs SET pending_expires_at = ${expiry}
        WHERE id = ${id} AND upload_state = 'uploaded' AND status = 'pending_confirmation' AND upload_expires_at > ${Date.now()} RETURNING id`;
      invariant(updated.length, 410, 'The batch upload expired. Please try again.');
    }
    try {
      await mailer(confirmationMessage(jobs, seal(ids, 'confirm', expiry)), { jobId: ids[0], purpose: 'confirmation' });
    } catch (cause) {
      throw new HttpError(502, 'We could not send the confirmation email. Your batch submission was removed; please try again later.', { cause });
    }
    for (const id of ids) {
      const ready = await sql`UPDATE jobs SET upload_state = 'ready'
        WHERE id = ${id} AND upload_state = 'uploaded' AND upload_expires_at > ${Date.now()} RETURNING id`;
      invariant(ready.length, 410, 'The submission expired. Please submit again, even if an email arrived.');
    }
    return { confirmed: false, message: 'Check your Purdue email. Open the link and confirm within 24 hours to join the queue.' };
  } catch (e) {
    logFailure('submission.failed', e, { jobId: ids[0] });
    try {
      for (const job of jobs) {
        const removed = await sql`DELETE FROM jobs WHERE id = ${job.id} AND status = 'pending_confirmation' RETURNING storage_key`;
        for (const row of removed) await removeFile(row.storage_key);
      }
    } catch (cleanupError) {
      logError('submission.cleanup_failed', cleanupError, { jobId: ids[0] });
      throw new HttpError(500, 'The submission failed and cleanup could not finish. Please contact the operator.', { cause: e });
    }
    throw e;
  }
}

let confirmChain: Promise<unknown> = Promise.resolve();

export async function confirmation(token: string, commit = false) {
  const { ids } = unseal(token, 'confirm');
  const sql = await db();
  const jobs: Job[] = [];
  for (const id of ids) {
    const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    invariant(job, 410, 'This submission is no longer available. Please submit your print again.');
    jobs.push(job);
  }
  if (jobs.every(j => Boolean(j.confirmed_at))) return { job: jobs[0], jobs, already: true };
  for (const job of jobs) {
    if (job.confirmed_at) continue;
    invariant(job.pending_expires_at > Date.now(), 410, 'This confirmation has expired. Please submit again.');
    invariant(job.upload_state === 'ready', 409, 'This submission is not ready. Wait a moment and open the link again.');
  }
  if (commit) {
    const run = () => sql.begin(async tx => {
      const now = Date.now();
      const updatedJobs: Job[] = [];
      let anyUpdated = false;
      const newIds: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const rows = await tx`UPDATE jobs SET status = 'queued', confirmed_at = ${now}, queued_at = ${now + i}, version = version + 1
          WHERE id = ${id} AND status = 'pending_confirmation' AND upload_state = 'ready' AND pending_expires_at > ${now} RETURNING *`;
        if (rows.length) {
          updatedJobs.push(rows[0] as Job);
          anyUpdated = true;
          newIds.push(id);
        } else {
          const [current]: Job[] = await tx`SELECT * FROM jobs WHERE id = ${id}`;
          invariant(current?.confirmed_at, 410, 'This confirmation expired. Please submit again.');
          updatedJobs.push(current);
        }
      }
      await recordQueuePush(tx, newIds, now);
      return { job: updatedJobs[0], jobs: updatedJobs, already: !anyUpdated };
    });
    const next = confirmChain.then(run, run);
    confirmChain = next.then(() => undefined, () => undefined);
    return next;
  }
  return { job: jobs[0], jobs, already: false };
}
export async function publicQueue(): Promise<PublicJob[]> {
  const sql = await db();
  return sql`SELECT id, title, status, infill, walls, material, color, layer_height, supports, support_angle, copies, mirror, queued_at, confirmed_at, version, batch_id, batch_title, group_name
    FROM jobs WHERE status IN ('queued', 'printing') AND confirmed_at IS NOT NULL
    ORDER BY CASE status WHEN 'printing' THEN 0 ELSE 1 END, queued_at, id`;
}

export async function operatorQueue(status: string | null = null, pageInput: string | null = null) {
  const filter = Object.hasOwn(transitions, status ?? '') ? status! : 'all';
  const page = Math.min(1000000, Math.max(1, Number.parseInt(pageInput ?? '1') || 1));
  const sql = await db();
  return sql.begin(async tx => {
    const jobs: Job[] = await tx`SELECT * FROM jobs WHERE confirmed_at IS NOT NULL AND (${filter} = 'all' OR status = ${filter})
      ORDER BY CASE status WHEN 'printing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('queued','printing') THEN queued_at ELSE -created_at END, id LIMIT 51 OFFSET ${(page - 1) * 50}`;
    const [revision] = await tx`SELECT COUNT(*) AS count, COALESCE(SUM(version), 0) AS version FROM jobs WHERE confirmed_at IS NOT NULL`;
    return { jobs: jobs.slice(0, 50), hasNext: jobs.length > 50, filter, page, revision: `${revision.count}:${revision.version}` };
  });
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
  const result: { job: Job; changed: boolean; eventId?: number } = await sql.begin(async tx => {
    // A conditional UPDATE is the first statement, acquiring SQLite's write lock before reading.
    const [job]: Job[] = await tx`UPDATE jobs SET version = version WHERE id = ${id} AND confirmed_at IS NOT NULL RETURNING *`;
    invariant(job, 404, 'Print not found.');
    invariant(job.version === version, 409, 'Another operator changed this print. Refresh before trying again.');
    if (job.status === next) return { job, changed: false };
    invariant(transitions[job.status as Status]?.includes(next), 400, 'That status transition is not allowed.');
    const now = Date.now();
    const [updated]: Job[] = await tx`UPDATE jobs SET status = ${next}, version = version + 1,
      queued_at = ${next === 'queued' ? now : job.queued_at} WHERE id = ${id} RETURNING *`;
    const [event] = await tx`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
      VALUES (${id}, ${job.status}, ${next}, ${operator}, ${now}, ${feedback}) RETURNING id`;
    return { job: updated, changed: true, eventId: Number(event.id) };
  });
  let warning: string | undefined;
  if (result.changed) {
    let delivered = true;
    try { await mailer(statusMessage(result.job, feedback), { jobId: id, purpose: 'status' }); }
    catch (error) {
      delivered = false;
      logError('job.notification_failed', error, { jobId: id, operatorId: operator, jobStatus: result.job.status, version: result.job.version, eventId: result.eventId });
      warning = 'Status saved, but the notification email failed. It is not retried automatically — use “Retry email” or contact the submitter directly.';
    }
    await markNotificationStatus(result.eventId!, delivered, { jobId: id });
  }
  return { ...result, warning };
}

async function markNotificationStatus(eventId: number, delivered: boolean, context: { jobId: string }) {
  try {
    const sql = await db();
    await sql`UPDATE job_events SET notification_status = ${delivered ? 'sent' : 'failed'} WHERE id = ${eventId}`;
  } catch (error) { logError('job.notification_status_failed', error, { ...context, eventId }); }
}

export interface BatchStatusItem {
  id: string;
  version?: number;
}

export interface BatchStatusResult {
  updated: Job[];
  unchanged: Job[];
  errors: { id: string; error: string }[];
  warnings: string[];
  failed: string[];
}

export async function batchUpdateStatus(
  rawItems: unknown,
  next: Status,
  operator: number,
  { feedback: input = '', mailer = sendMail }: { feedback?: unknown; mailer?: Mailer } = {}
): Promise<BatchStatusResult> {
  invariant(Object.hasOwn(transitions, next), 400, 'Invalid status update.');
  invariant(Array.isArray(rawItems) && rawItems.length > 0 && rawItems.length <= 100, 400, 'Must provide between 1 and 100 prints to update.');
  invariant(typeof input === 'string' && input.length <= MAX_FEEDBACK_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input),
    400, `Feedback must be text with at most ${MAX_FEEDBACK_LENGTH} characters.`);
  const feedback = input.trim();
  invariant(next !== 'rejected' || feedback.length > 0, 400, 'Provide feedback before rejecting and returning this print.');
  invariant(next === 'rejected' || feedback.length === 0, 400, 'Feedback is only supported when rejecting and returning a print.');

  const items: BatchStatusItem[] = rawItems.map(item => {
    if (typeof item === 'string') return { id: item };
    invariant(item && typeof item === 'object' && typeof (item as any).id === 'string', 400, 'Invalid print ID in batch.');
    const version = typeof (item as any).version === 'number' && Number.isSafeInteger((item as any).version) ? (item as any).version : undefined;
    return { id: (item as any).id, version };
  });

  const sql = await db();
  const updated: Job[] = [];
  const unchanged: Job[] = [];
  const errors: { id: string; error: string }[] = [];
  const warnings: string[] = [];
  const failed: string[] = [];
  const toNotify: { job: Job; eventId: number }[] = [];

  for (const item of items) {
    try {
      const res: { job: Job; changed: boolean; eventId?: number } = await sql.begin(async tx => {
        const [job]: Job[] = await tx`UPDATE jobs SET version = version WHERE id = ${item.id} AND confirmed_at IS NOT NULL RETURNING *`;
        if (!job) throw new Error('Print not found.');
        if (item.version !== undefined && job.version !== item.version) {
          throw new Error('Another operator changed this print. Refresh before trying again.');
        }
        if (job.status === next) return { job, changed: false };
        if (!transitions[job.status as Status]?.includes(next)) {
          throw new Error(`Cannot transition from ${job.status} to ${next}.`);
        }
        const now = Date.now();
        const [updatedJob]: Job[] = await tx`UPDATE jobs SET status = ${next}, version = version + 1,
          queued_at = ${next === 'queued' ? now : job.queued_at} WHERE id = ${item.id} RETURNING *`;
        const [event] = await tx`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
          VALUES (${item.id}, ${job.status}, ${next}, ${operator}, ${now}, ${feedback}) RETURNING id`;
        return { job: updatedJob, changed: true, eventId: Number(event.id) };
      });

      if (res.changed) {
        updated.push(res.job);
        toNotify.push({ job: res.job, eventId: res.eventId! });
      } else {
        unchanged.push(res.job);
      }
    } catch (err: any) {
      errors.push({ id: item.id, error: err?.message || 'Update failed.' });
    }
  }

  const byRecipient = new Map<string, { job: Job; eventId: number }[]>();
  for (const target of toNotify) {
    const key = target.job.email.toLowerCase();
    if (!byRecipient.has(key)) byRecipient.set(key, []);
    byRecipient.get(key)!.push(target);
  }

  for (const recipientTargets of byRecipient.values()) {
    const recipientJobs = recipientTargets.map(t => t.job);
    try {
      await mailer(statusMessage(recipientJobs, feedback), { jobId: recipientJobs[0].id, purpose: 'status' });
      for (const target of recipientTargets) await markNotificationStatus(target.eventId, true, { jobId: target.job.id });
    } catch (error) {
      for (const target of recipientTargets) {
        logError('job.notification_failed', error, { jobId: target.job.id, operatorId: operator, jobStatus: target.job.status, version: target.job.version, eventId: target.eventId });
        await markNotificationStatus(target.eventId, false, { jobId: target.job.id });
        warnings.push(`Status saved for ${target.job.title}, but the notification email failed.`);
        failed.push(target.job.id);
      }
    }
  }

  return { updated, unchanged, errors, warnings, failed };
}

export async function resendNotification(id: string, operator: number,
  { eventId = null, mailer = sendMail }: { eventId?: number | null; mailer?: Mailer } = {}) {
  invariant(Number.isSafeInteger(operator) && operator > 0, 401, 'Please log in as an operator.');
  const sql = await db();
  const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id} AND confirmed_at IS NOT NULL`;
  invariant(job, 404, 'Print not found.');
  let event: { id: number; next_status: string; feedback: string } | undefined;
  if (eventId !== null) {
    invariant(Number.isSafeInteger(eventId), 400, 'Invalid status event.');
    [event] = await sql`SELECT id, next_status, feedback FROM job_events WHERE id = ${eventId} AND job_id = ${id}`;
    invariant(event, 404, 'That status update was not found for this print.');
  } else {
    [event] = await sql`SELECT id, next_status, feedback FROM job_events WHERE job_id = ${id} ORDER BY id DESC LIMIT 1`;
    invariant(event, 409, 'This print has no status update to notify about yet.');
  }
  try {
    await mailer(statusMessage({ ...job, status: event.next_status as Status }, event.feedback), { jobId: id, purpose: 'status' });
    await markNotificationStatus(event.id, true, { jobId: id });
    return { sent: true, eventId: event.id };
  } catch (error) {
    logError('job.notification_failed', error, { jobId: id, operatorId: operator, eventId: event.id, retried: true });
    await markNotificationStatus(event.id, false, { jobId: id });
    return { sent: false, eventId: event.id, warning: 'The notification email failed again. Contact the submitter directly.' };
  }
}

export async function resendBatchNotifications(rawIds: unknown, operator: number, { mailer = sendMail }: { mailer?: Mailer } = {}) {
  invariant(Number.isSafeInteger(operator) && operator > 0, 401, 'Please log in as an operator.');
  invariant(Array.isArray(rawIds) && rawIds.length > 0 && rawIds.length <= 100, 400, 'Must provide between 1 and 100 prints to notify.');
  const ids = Array.from(new Set(rawIds.map(id => {
    invariant(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 400, 'Invalid print ID.');
    return id;
  })));
  const sql = await db();
  const targets: { job: Job; event: { id: number; next_status: string; feedback: string } }[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const [job]: Job[] = await sql`SELECT * FROM jobs WHERE id = ${id} AND confirmed_at IS NOT NULL`;
    const [event]: { id: number; next_status: string; feedback: string }[] = job ? await sql`
      SELECT id, next_status, feedback FROM job_events WHERE job_id = ${id} AND notification_status = 'failed' ORDER BY id DESC LIMIT 1` : [];
    if (!job || !event) { skipped.push(id); continue; }
    targets.push({ job, event });
  }
  // Consolidate per submitter and status/feedback, mirroring batchUpdateStatus.
  const groups = new Map<string, typeof targets>();
  for (const target of targets) {
    const key = `${target.job.email.toLowerCase()}\0${target.event.next_status}\0${target.event.feedback}`;
    const list = groups.get(key) ?? [];
    list.push(target);
    groups.set(key, list);
  }
  const notified: { id: string; eventId: number; sent: boolean }[] = [];
  const warnings: string[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    const jobs = list.map(t => ({ ...t.job, status: t.event.next_status as Status }));
    try {
      await mailer(statusMessage(jobs, first.event.feedback), { jobId: first.job.id, purpose: 'status' });
      for (const target of list) {
        await markNotificationStatus(target.event.id, true, { jobId: target.job.id });
        notified.push({ id: target.job.id, eventId: target.event.id, sent: true });
      }
    } catch (error) {
      logError('job.notification_failed', error, { jobId: first.job.id, operatorId: operator, retried: true, jobs: list.length });
      for (const target of list) {
        await markNotificationStatus(target.event.id, false, { jobId: target.job.id });
        notified.push({ id: target.job.id, eventId: target.event.id, sent: false });
        warnings.push(`The notification email for ${target.job.title} failed again.`);
      }
    }
  }
  return { notified, skipped, warnings };
}

export async function updateJobGroup(
  rawIds: unknown,
  rawGroupName: unknown,
  operator: number,
  { ungroup = false }: { ungroup?: boolean } = {}
): Promise<{ updated: Job[]; group_name: string | null }> {
  invariant(Number.isSafeInteger(operator) && operator > 0, 401, 'Please log in as an operator.');
  const groupName = ungroup ? null : validateGroupName(rawGroupName);
  const sql = await db();

  if (ungroup && (!Array.isArray(rawIds) || rawIds.length === 0)) {
    const targetName = validateGroupName(rawGroupName);
    invariant(targetName, 400, 'Specify a group name or print IDs to ungroup.');
    const updated: Job[] = await sql`
      UPDATE jobs SET group_name = NULL
      WHERE group_name = ${targetName} AND confirmed_at IS NOT NULL
      RETURNING *`;
    return { updated, group_name: null };
  }

  invariant(Array.isArray(rawIds) && rawIds.length > 0 && rawIds.length <= 100, 400, 'Must provide between 1 and 100 prints to group.');
  const ids = Array.from(new Set(rawIds.map(id => {
    invariant(typeof id === 'string' && id.trim().length > 0, 400, 'Invalid print ID.');
    return id.trim();
  })));

  const updated: Job[] = [];
  await sql.begin(async tx => {
    for (const id of ids) {
      const [row]: Job[] = await tx`
        UPDATE jobs SET group_name = ${groupName}
        WHERE id = ${id} AND confirmed_at IS NOT NULL
        RETURNING *`;
      if (row) updated.push(row);
    }
  });

  return { updated, group_name: groupName };
}
