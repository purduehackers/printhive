import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('support angle upgrade preserves old submissions, files, status, history and constraints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'printhive-support-angle-'));
  const sql = new SQL({
    adapter: 'sqlite',
    filename: join(dir, 'jobs.sqlite'),
    create: true,
  });
  try {
    await sql.unsafe('PRAGMA foreign_keys = ON');
    const apply = async (file: string) => {
      const source = await Bun.file('migrations/' + file).text();
      for (const statement of source
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean))
        await sql.unsafe(statement);
    };
    for (const file of [
      '001_initial.sql',
      '002_rejected_feedback.sql',
      '003_materials_and_colors.sql',
      '004_regular_supports.sql',
    ])
      await apply(file);
    await sql`INSERT INTO operators VALUES (1,'existing','hash',1)`;
    await sql`INSERT INTO sessions VALUES ('session-hash',1,9999999999999)`;
    for (const [index, status] of [
      'pending_confirmation',
      'queued',
      'printing',
      'completed',
      'canceled',
      'failed',
      'rejected',
    ].entries()) {
      const id = `old-${index}`;
      await sql`INSERT INTO jobs (id,email,title,notes,infill,material,color,layer_height,supports,copies,mirror,
        original_filename,storage_key,file_size,upload_state,status,pending_expires_at,upload_expires_at,created_at,version)
        VALUES (${id},'old@purdue.edu','Existing','Keep notes',20,'PLA','black',0.16,'tree',2,1,
          'part.stl',${id + '.stl'},1024,'ready',${status},10,10,1,4)`;
      await sql`INSERT INTO job_events (job_id,previous_status,next_status,operator_id,created_at,feedback)
        VALUES (${id},'printing',${status},1,2,'Keep feedback')`;
    }
    const before = await sql`SELECT * FROM jobs ORDER BY id`;
    const events = await sql`SELECT * FROM job_events ORDER BY id`;
    const indexes = await sql.unsafe("PRAGMA index_list('jobs')");
    await apply('005_support_overhang_angle.sql');
    expect(await sql`SELECT * FROM jobs ORDER BY id`).toEqual(
      before.map((row: Record<string, unknown>) => ({ ...row, support_angle: null })),
    );
    expect(await sql`SELECT * FROM job_events ORDER BY id`).toEqual(events);
    expect(await sql.unsafe("PRAGMA index_list('jobs')")).toEqual(indexes);
    expect(await sql`SELECT * FROM operators`).toHaveLength(1);
    expect(await sql`SELECT * FROM sessions`).toHaveLength(1);
    for (const angle of [0, 30, 90]) {
      await sql`UPDATE jobs SET support_angle=${angle} WHERE id='old-0'`;
      expect(
        (await sql`SELECT support_angle FROM jobs WHERE id='old-0'`)[0]
          .support_angle,
      ).toBe(angle);
    }
    for (const angle of [-1, 91, 30.5]) {
      let rejected = false;
      try {
        await sql`UPDATE jobs SET support_angle=${angle} WHERE id='old-0'`;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
    expect(await sql.unsafe('PRAGMA foreign_key_check')).toHaveLength(0);
  } finally {
    await sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});
