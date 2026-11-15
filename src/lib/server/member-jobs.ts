import { db } from './db';
import { invariant } from './errors';
import { loadAllowedMaterials } from './jobs';
import { recordQueuePush } from './push';
import { metadata } from './validation';
import type { Job } from '../shared';

export function canManagePrint(job: Pick<Job, 'status' | 'started_at'>) {
  return job.status === 'queued' && job.started_at == null;
}

export async function memberJobs(memberId: string) {
  return (await db())<Job[]>`SELECT * FROM jobs WHERE member_id = ${memberId} AND confirmed_at IS NOT NULL
    ORDER BY created_at DESC, id`;
}

export async function changeMemberPrint(memberId: string, id: string, version: number, action: 'settings' | 'cancellation', input?: unknown) {
  invariant(Number.isSafeInteger(version), 400, 'Reload the print before making changes.');
  const materials = action === 'settings' ? await loadAllowedMaterials() : undefined;
  const sql = await db();
  return sql.begin(async tx => {
    const [job] = await tx<Job[]>`UPDATE jobs SET version = version WHERE id = ${id}
      AND member_id = ${memberId} AND confirmed_at IS NOT NULL RETURNING *`;
    invariant(job, 404, 'Print not found.');
    invariant(canManagePrint(job), 409, 'Only queued prints that have never started can be changed.');
    invariant(job.version === version, 409, 'This print changed. Reload to see its latest settings.');
    const now = Date.now();
    if (action === 'settings') {
      invariant(input && typeof input === 'object', 400, 'Enter valid print settings.');
      const settings = metadata({ ...job, ...input, email: job.email, title: job.title,
        original_filename: job.original_filename, file_size: job.file_size, mirror: job.mirror }, materials, true);
      if (settings.infill === job.infill && settings.walls === job.walls && settings.material === job.material &&
        settings.color === job.color && settings.layer_height === job.layer_height && settings.supports === job.supports &&
        settings.support_angle === job.support_angle && settings.copies === job.copies && settings.notes === job.notes) return;
      await tx`UPDATE jobs SET infill = ${settings.infill}, walls = ${settings.walls}, material = ${settings.material},
        color = ${settings.color}, layer_height = ${settings.layer_height}, supports = ${settings.supports},
        support_angle = ${settings.support_angle}, copies = ${settings.copies}, notes = ${settings.notes},
        version = version + 1 WHERE id = ${id}`;
    } else {
      await tx`UPDATE jobs SET status = 'canceled', version = version + 1 WHERE id = ${id}`;
    }
    await tx`INSERT INTO job_events (job_id, previous_status, next_status, created_at, feedback)
      VALUES (${id}, 'queued', ${action === 'settings' ? 'queued' : 'canceled'}, ${now},
        ${action === 'settings' ? 'Print settings changed by submitter.' : 'Canceled by submitter.'})`;
    await recordQueuePush(tx, [id], now, action);
  });
}

export async function assignLegacyPrint(id: string, memberId: string, operatorId: number) {
  const sql = await db();
  await sql.begin(async tx => {
    const [job] = await tx`UPDATE jobs SET member_id = ${memberId}, version = version + 1
      WHERE id = ${id} AND confirmed_at IS NOT NULL AND member_id IS NULL
      AND EXISTS (SELECT 1 FROM members WHERE id = ${memberId}) RETURNING status`;
    invariant(job, 409, 'Check the member account ID. Only unlinked prints can be assigned.');
    await tx`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
      VALUES (${id}, ${job.status}, ${job.status}, ${operatorId}, ${Date.now()}, 'Linked legacy print to member account.')`;
  });
}
