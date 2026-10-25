import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('regular support migration preserves custom material, files and event feedback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'printhive-regular-supports-'));
  const sql = new SQL({
    adapter: 'sqlite',
    filename: join(dir, 'jobs.sqlite'),
    create: true,
  });
  try {
    await sql.unsafe('PRAGMA foreign_keys = ON');
    const apply = async (connection: Pick<SQL, 'unsafe'>, file: string) => {
      const source = await Bun.file('migrations/' + file).text();
      for (const statement of source
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await connection.unsafe(statement);
    };
    for (const file of [
      '001_initial.sql',
      '002_rejected_feedback.sql',
      '003_materials_and_colors.sql',
    ])
      await apply(sql, file);
    await sql`INSERT INTO operators VALUES (1,'existing','hash',1)`;
    await sql`INSERT INTO materials (name,created_at) VALUES ('PETG',1)`;
    await sql`INSERT INTO jobs (id,email,title,infill,material,color,layer_height,supports,copies,mirror,original_filename,
      storage_key,file_size,upload_state,pending_expires_at,upload_expires_at,created_at)
      VALUES ('existing','user@purdue.edu','Existing',20,'PETG','blue',0.16,'tree',2,1,'part.stl','existing.stl',1024,'ready',10,10,1)`;
    await sql`INSERT INTO job_events (id,job_id,previous_status,next_status,operator_id,created_at,feedback)
      VALUES (1,'existing','printing','rejected',1,2,'Keep this feedback')`;
    const before = await sql`SELECT * FROM jobs`,
      events = await sql`SELECT * FROM job_events`;
    await sql.begin(async (tx) => apply(tx, '004_regular_supports.sql'));
    expect(await sql`SELECT * FROM jobs`).toEqual(before);
    expect(await sql`SELECT * FROM job_events`).toEqual(events);
    await sql`UPDATE jobs SET supports='normal' WHERE id='existing'`;
    expect((await sql`SELECT supports FROM jobs`)[0].supports).toBe('normal');
    expect(await sql.unsafe('PRAGMA foreign_key_check')).toHaveLength(0);
    expect(
      await sql`SELECT name FROM materials WHERE name='PETG'`,
    ).toHaveLength(1);
    await sql`DELETE FROM jobs WHERE id='existing'`;
    expect(await sql`SELECT * FROM job_events`).toHaveLength(0);
  } finally {
    await sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});
