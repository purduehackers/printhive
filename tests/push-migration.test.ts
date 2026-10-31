import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('submission details migration backfills queued alerts without changing delivery state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'printhive-push-migration-'));
  const sql = new SQL({ adapter: 'sqlite', filename: join(dir, 'printhive.sqlite'), create: true });
  try {
    await sql.unsafe('PRAGMA foreign_keys = ON');
    await sql.unsafe('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const files = (await readdir('migrations')).filter(file => /^00[1-8]_.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const source = await Bun.file(join('migrations', file)).text();
      for (const statement of source.split(';').map(value => value.trim()).filter(Boolean)) await sql.unsafe(statement);
      await sql`INSERT INTO schema_migrations VALUES (${file}, 1)`;
    }
    await sql`INSERT INTO operators (id, username, password_hash) VALUES (1, 'operator', 'hash')`;
    for (const [id, title, batchTitle] of [['single', 'Gearbox', null], ['batch-left', 'Robot arm · left', 'Robot arm'], ['batch-right', 'Robot arm · right', 'Robot arm']]) {
      await sql`INSERT INTO jobs (id, email, title, batch_title, infill, color, layer_height, supports, copies, mirror,
        original_filename, storage_key, file_size, upload_state, status, pending_expires_at, upload_expires_at, created_at, confirmed_at, queued_at)
        VALUES (${id}, 'student@purdue.edu', ${title}, ${batchTitle}, 15, 'black', 0.2, 'operator', 1, 0,
        'part.stl', ${id + '.stl'}, 100, 'ready', 'queued', 1, 1, 1, 1, 1)`;
    }
    await sql`INSERT INTO push_subscriptions VALUES ('device', 1, 'https://fcm.googleapis.com/test', 'key', 'auth', 1)`;
    await sql`INSERT INTO push_events VALUES ('single-event', 1, 1, 9999999999999), ('batch-event', 2, 1, 9999999999999)`;
    await sql`INSERT INTO push_event_jobs VALUES ('single', 'single-event'), ('batch-left', 'batch-event'), ('batch-right', 'batch-event')`;
    await sql`INSERT INTO push_deliveries (event_id, subscription_id, attempts, next_attempt_at, lease_until)
      VALUES ('single-event', 'device', 2, 1234, 0), ('batch-event', 'device', 1, 5678, 9000)`;
    const deliveries = await sql`SELECT * FROM push_deliveries ORDER BY event_id`;
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn([process.execPath, 'scripts/migrate.ts'], {
        env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
      });
      const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(error).toBe(''); expect(exit).toBe(0);
    }
    expect(await sql`SELECT submission_title, submitter_email, print_count FROM push_events ORDER BY id`).toEqual([
      { submission_title: 'Robot arm', submitter_email: 'student@purdue.edu', print_count: 2 },
      { submission_title: 'Gearbox', submitter_email: 'student@purdue.edu', print_count: 1 },
    ]);
    expect(await sql`SELECT * FROM push_deliveries ORDER BY event_id`).toEqual(deliveries);
    expect(await sql.unsafe('PRAGMA foreign_key_check')).toEqual([]);
  } finally { await sql.close(); await rm(dir, { recursive: true, force: true }); }
});
