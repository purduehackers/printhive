import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, closeDb } from '../src/lib/server/db';

let dir: string;
const previousDataDir = process.env.DATA_DIR;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-database-'));
  process.env.DATA_DIR = dir;
  await (await db()).unsafe('CREATE TABLE concurrency_test (id TEXT PRIMARY KEY)');
});
beforeEach(async () => { await (await db()).unsafe('DELETE FROM concurrency_test'); });
afterAll(async () => {
  await closeDb(); await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
});

test('plain queries and another transaction wait for rollback and retain their own writes', async () => {
  const sql = await db(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const first = sql.begin(async tx => {
    await tx`INSERT INTO concurrency_test VALUES (${'uncommitted'})`;
    entered.resolve(); await release.promise;
    throw new Error('rollback');
  });
  const rejected = first.catch(() => {});
  await entered.promise;
  let readFinished = false;
  const read = sql`SELECT id FROM concurrency_test`.then(rows => { readFinished = true; return rows; });
  const write = sql`INSERT INTO concurrency_test VALUES (${'outside'})`;
  const second = sql.begin(async tx => {
    await tx`INSERT INTO concurrency_test VALUES (${'second'})`;
    return tx`SELECT id FROM concurrency_test ORDER BY id`;
  });
  try { await Bun.sleep(25); expect(readFinished).toBe(false); }
  finally { release.resolve(); await rejected; }
  expect(await read).toEqual([]);
  await write;
  expect(await second).toEqual([{ id: 'outside' }, { id: 'second' }]);
});

test('concurrent transactions commit in order without nested BEGIN errors', async () => {
  const sql = await db();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => sql.begin(async tx => {
    await tx`INSERT INTO concurrency_test VALUES (${String(index)})`;
    const [{ count }] = await tx`SELECT COUNT(*) AS count FROM concurrency_test`;
    return Number(count);
  })));
  expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test('failed ordinary queries release the queue and parameter binding is preserved', async () => {
  const sql = await db();
  const value = "quote'); DROP TABLE concurrency_test; --";
  await sql`INSERT INTO concurrency_test VALUES (${value})`;
  await expect(sql`INSERT INTO concurrency_test VALUES (${value})`).rejects.toThrow();
  expect(await sql`SELECT id FROM concurrency_test`).toEqual([{ id: value }]);
  await expect(sql.unsafe('SELECT * FROM no_such_table')).rejects.toThrow();
  expect(await sql`SELECT id FROM concurrency_test`).toHaveLength(1);
});

test('using the parent client within a transaction fails clearly instead of deadlocking', async () => {
  const sql = await db();
  await expect(sql.begin(async () => { await sql`SELECT 1`; })).rejects.toThrow('supplied transaction client');
  expect(await sql`SELECT id FROM concurrency_test`).toEqual([]);
});

test('close drains accepted operations, rejects new queries and permits reopening', async () => {
  const sql = await db(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const first = sql.begin(async tx => {
    entered.resolve(); await release.promise;
    await tx`INSERT INTO concurrency_test VALUES (${'retained'})`;
  });
  await entered.promise;
  const close = sql.close();
  try { await expect(sql`SELECT 1`).rejects.toThrow('closing'); }
  finally { release.resolve(); await first; await close; await closeDb(); }
  expect(await (await db())`SELECT id FROM concurrency_test`).toEqual([{ id: 'retained' }]);
});
