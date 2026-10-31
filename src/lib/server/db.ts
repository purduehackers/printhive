import { SQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { logError } from './log';

// This is the application's SQL surface, not Bun's full lazy-query API. Queries
// execute when called; transaction helpers must use the supplied query client.
export interface DatabaseQueries {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  unsafe<T = any>(statement: string): Promise<T>;
}
interface Database extends DatabaseQueries {
  begin<T>(action: (tx: DatabaseQueries) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function serializeConnection(sql: SQL): Database {
  let pending = Promise.resolve();
  let closing: Promise<void> | undefined;
  const transaction = new AsyncLocalStorage<boolean>();
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (transaction.getStore()) return Promise.reject(new Error('Use the supplied transaction client inside a database transaction.'));
    if (closing) return Promise.reject(new Error('The database connection is closing.'));
    const result = pending.then(action);
    // A failed operation must release its slot so later requests can proceed.
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  const client: Database = Object.assign(
    <T = any>(strings: TemplateStringsArray, ...values: unknown[]) => enqueue(async () => await sql<T>(strings, ...values)),
    {
      unsafe: <T = any>(statement: string) => enqueue(async () => await sql.unsafe<T>(statement)),
      begin: <T>(action: (tx: DatabaseQueries) => Promise<T>): Promise<T> =>
        enqueue(async () => await sql.begin(tx => transaction.run(true, () => action(tx)))),
      close: () => {
        if (transaction.getStore()) return Promise.reject(new Error('Cannot close the database inside a transaction.'));
        closing ??= enqueue(async () => { await sql.close(); });
        return closing;
      },
    },
  );
  return client;
}

let connection: Promise<Database> | undefined;
export function db(): Promise<Database> {
  return connection ??= (async () => {
    const { dataDir } = config();
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const sql = new SQL({ adapter: 'sqlite', filename: join(dataDir, 'printhive.sqlite'), create: true });
    await sql.unsafe('PRAGMA journal_mode = WAL');
    await sql.unsafe('PRAGMA foreign_keys = ON');
    await sql.unsafe('PRAGMA busy_timeout = 5000');
    // Bun 1.4.2/1.4.3 share one SQLite connection without isolating concurrent
    // transactions or plain queries. Queue both kinds until COMMIT/ROLLBACK.
    return serializeConnection(sql);
  })().catch(error => {
    connection = undefined;
    logError('database.open_failed', error);
    throw error;
  });
}
export async function closeDb(): Promise<void> {
  if (connection) {
    const c = connection;
    connection = undefined;
    const sql = await c.catch(() => null);
    if (sql) await sql.close();
  }
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
