import { SQL } from 'bun';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { logError } from './log';

let connection: Promise<SQL> | undefined;
export function db(): Promise<SQL> {
  return connection ??= (async () => {
    const { dataDir } = config();
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const sql = new SQL({ adapter: 'sqlite', filename: join(dataDir, 'printhive.sqlite'), create: true });
    await sql.unsafe('PRAGMA journal_mode = WAL');
    await sql.unsafe('PRAGMA foreign_keys = ON');
    await sql.unsafe('PRAGMA busy_timeout = 5000');
    return sql;
  })().catch(error => {
    logError('database.open_failed', error);
    throw error;
  });
}
export async function migrate() {
  const sql = await db();
  await sql.unsafe('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const files = (await readdir('migrations')).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    try {
      await sql.begin(async tx => {
        if ((await tx`SELECT version FROM schema_migrations WHERE version = ${file}`).length) return;
        const source = await Bun.file(join('migrations', file)).text();
        // Migration sources are trusted repository files, never request input.
        for (const statement of source.split(';').map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement);
        await tx`INSERT INTO schema_migrations VALUES (${file}, ${Date.now()})`;
      });
    } catch (error) {
      logError('database.migration_failed', error, { migration: file });
      throw error;
    }
  }
}
