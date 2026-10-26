import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('rejection migration preserves existing jobs, events, operators and sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'printhive-migration-'));
  const sql = new SQL({ adapter: 'sqlite', filename: join(dir, 'printhive.sqlite'), create: true });
  try {
    await sql.unsafe('PRAGMA foreign_keys = ON');
    const initial = await Bun.file('migrations/001_initial.sql').text();
    for (const statement of initial.split(';').map(s => s.trim()).filter(Boolean)) await sql.unsafe(statement);
    await sql.unsafe('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    await sql`INSERT INTO schema_migrations VALUES ('001_initial.sql', 1)`;
    await sql`INSERT INTO operators VALUES (1, 'existing', 'hash', 1)`;
    await sql`INSERT INTO sessions VALUES ('session-hash', 1, 9999999999999)`;
    await sql`INSERT INTO jobs (id, email, title, notes, infill, color, layer_height, supports, copies, mirror,
      original_filename, storage_key, file_size, upload_state, status, pending_expires_at, upload_expires_at,
      created_at, confirmed_at, queued_at, version)
      VALUES ('existing-job', 'existing@purdue.edu', 'Existing print', 'Keep these notes', 15, 'black', 0.2,
      'operator', 1, 0, 'part.stl', 'existing.stl', 100, 'ready', 'printing', 100, 100, 1, 2, 2, 2)`;
    await sql`INSERT INTO job_events VALUES (7, 'existing-job', 'queued', 'printing', 1, 3)`;
    const [before] = await sql`SELECT * FROM jobs`;
    const [event] = await sql`SELECT * FROM job_events`;
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn([process.execPath, 'scripts/migrate.ts'], {
        env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
      });
      const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(error).toBe(''); expect(exit).toBe(0);
    }
    expect(await sql`SELECT * FROM jobs`).toEqual([{ ...before, material: 'PLA', support_angle: null }]);
    expect(await sql`SELECT * FROM job_events`).toEqual([{ ...event, feedback: '' }]);
    expect(await sql`SELECT * FROM operators`).toEqual([{ id: 1, username: 'existing', password_hash: 'hash', active: 1 }]);
    expect(await sql`SELECT * FROM sessions`).toHaveLength(1);
    expect(await sql`SELECT * FROM schema_migrations`).toHaveLength(5);
    expect(await sql`SELECT name FROM materials`).toEqual([{ name: 'PLA' }]);
    expect(await sql`SELECT name FROM material_colors ORDER BY id ASC`).toEqual([{ name: 'black' }, { name: 'white' }, { name: 'yellow' }, { name: 'red' }]);
    await sql`UPDATE jobs SET supports = 'normal' WHERE id = 'existing-job'`;
    expect((await sql`SELECT supports FROM jobs`)[0].supports).toBe('normal');
    await sql`UPDATE jobs SET status = 'rejected' WHERE id = 'existing-job'`;
    await sql`INSERT INTO job_events (job_id, previous_status, next_status, operator_id, created_at, feedback)
      VALUES ('existing-job', 'printing', 'rejected', 1, 4, 'Fix the walls.')`;
    expect(await sql.unsafe('PRAGMA foreign_key_check')).toHaveLength(0);
    expect((await sql.unsafe("PRAGMA index_list('jobs')")).map((row: { name: string }) => row.name)).toEqual(expect.arrayContaining(['jobs_queue', 'jobs_expiry', 'jobs_email']));
    await sql`DELETE FROM jobs WHERE id = 'existing-job'`;
    expect(await sql`SELECT * FROM job_events`).toHaveLength(0);
  } finally { await sql.close(); await rm(dir, { recursive: true, force: true }); }
});
