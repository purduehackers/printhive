import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, closeDb, db } from '../src/lib/server/db';
import { reserveBatch, upload, finalizeBatch, confirmation, publicQueue } from '../src/lib/server/jobs';
import { batchMetadata } from '../src/lib/server/validation';
import { filePath } from '../src/lib/server/storage';
import { asciiSTL } from './fixtures';
import { MAX_BATCH_SIZE } from '../src/lib/shared';

let dir: string;
const accepted: string[] = [];
const mailer = async (mail: { text: string }) => { accepted.push(mail.text); };
const rejectedMailer = async () => { throw new Error('SMTP unavailable'); };
const body = (text: BodyInit = asciiSTL) => new Request('http://localhost:4321/file', { method: 'PUT', body: text });
const confirmationToken = () => new URL(accepted.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0]).searchParams.get('token')!;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-batch-submit-test-'));
  process.env.DATA_DIR = dir;
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321';
  process.env.NODE_ENV = 'test';
  await migrate();
});

beforeEach(async () => {
  const sql = await db();
  await sql`DELETE FROM jobs`;
  accepted.length = 0;
});

afterAll(async () => {
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('batch submission flow', () => {
  test('batchMetadata validates items and derives titles from base title and filenames', () => {
    const valid = batchMetadata({
      title: 'Robot Arm',
      email: 'student@purdue.edu',
      infill: 20,
      material: 'PLA',
      color: 'yellow',
      layer_height: 0.16,
      supports: 'tree',
      copies: 2,
      mirror: 1,
      items: [
        { original_filename: 'base_plate.stl', file_size: 120 },
        { original_filename: 'gripper.stl', file_size: 240 },
      ],
    });
    expect(valid).toHaveLength(2);
    expect(valid[0]).toMatchObject({
      title: 'Robot Arm · base_plate',
      original_filename: 'base_plate.stl',
      file_size: 120,
      infill: 20,
      color: 'yellow',
      layer_height: 0.16,
      supports: 'tree',
      copies: 2,
      mirror: 1,
    });
    expect(valid[1]).toMatchObject({
      title: 'Robot Arm · gripper',
      original_filename: 'gripper.stl',
      file_size: 240,
    });

    // Reject empty or oversized batches
    expect(() => batchMetadata({ title: 'Test', email: 'student@purdue.edu', items: [] })).toThrow();
    const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ original_filename: `part${i}.stl`, file_size: 100 }));
    expect(() => batchMetadata({ title: 'Test', email: 'student@purdue.edu', items: tooMany })).toThrow();
  });

  test('reserveBatch, deferred uploads, finalizeBatch, and single confirmation enqueue all items in order', async () => {
    const batch = await reserveBatch({
      title: 'Gearbox Assembly',
      email: 'maker@purdue.edu',
      notes: 'Print together if possible',
      infill: 30,
      color: 'red',
      items: [
        { original_filename: 'housing.stl', file_size: Buffer.byteLength(asciiSTL), copies: 2 },
        { original_filename: 'pinion.stl', file_size: Buffer.byteLength(asciiSTL) },
        { original_filename: 'cover.stl', file_size: Buffer.byteLength(asciiSTL), copies: 3 },
      ],
    });

    expect(batch.items).toHaveLength(3);
    expect(typeof batch.batchToken).toBe('string');

    // Finalizing before all files are uploaded should fail with 409
    await upload(batch.items[0].id, batch.items[0].capability, body(), mailer, { deferEmail: true });
    await expect(finalizeBatch(batch.batchToken, mailer)).rejects.toMatchObject({ status: 409 });
    expect(accepted).toHaveLength(0);

    // Upload remaining files
    await upload(batch.items[1].id, batch.items[1].capability, body(), mailer, { deferEmail: true });
    await upload(batch.items[2].id, batch.items[2].capability, body(), mailer, { deferEmail: true });
    expect(accepted).toHaveLength(0);

    // Finalize batch sends a single confirmation email covering all 3 prints
    await finalizeBatch(batch.batchToken, mailer);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain('Gearbox Assembly · housing');
    expect(accepted[0]).toContain('Gearbox Assembly · pinion');
    expect(accepted[0]).toContain('Gearbox Assembly · cover');

    const token = confirmationToken();
    // GET preview does not enqueue
    const preview = await confirmation(token, false);
    expect(preview.jobs).toHaveLength(3);
    expect(preview.already).toBe(false);
    expect(await publicQueue()).toHaveLength(0);

    // Racing POST confirmations enqueue all 3 prints once in order
    const raceResults = await Promise.all([confirmation(token, true), confirmation(token, true)]);
    expect(raceResults.filter(r => !r.already)).toHaveLength(1);
    const confirmed = raceResults.find(r => !r.already)!;
    expect(confirmed.jobs).toHaveLength(3);
    expect(confirmed.already).toBe(false);

    const queue = await publicQueue();
    expect(queue.map(j => j.title)).toEqual([
      'Gearbox Assembly · housing',
      'Gearbox Assembly · pinion',
      'Gearbox Assembly · cover',
    ]);
    expect(queue.every(j => j.color === 'red' && j.infill === 30)).toBe(true);
    expect(queue.map(j => j.copies)).toEqual([2, 1, 3]);
    expect(typeof batch.batchId).toBe('string');
    expect(batch.batchTitle).toBe('Gearbox Assembly');
    expect(batch.groupName).toBe('Gearbox Assembly');
    expect(queue.every(j => j.batch_id === batch.batchId && j.batch_title === 'Gearbox Assembly' && j.group_name === 'Gearbox Assembly')).toBe(true);

    // Confirming again is idempotent
    const repeat = await confirmation(token, true);
    expect(repeat.already).toBe(true);
    expect((await publicQueue()).map(j => j.id)).toEqual(batch.items.map(i => i.id));
  });

  test('finalizeBatch SMTP failure cleans up all jobs and uploaded files in the batch', async () => {
    const batch = await reserveBatch({
      title: 'Failed SMTP Batch',
      email: 'maker@purdue.edu',
      items: [
        { original_filename: 'part1.stl', file_size: Buffer.byteLength(asciiSTL) },
        { original_filename: 'part2.stl', file_size: Buffer.byteLength(asciiSTL) },
      ],
    });

    for (const item of batch.items) {
      await upload(item.id, item.capability, body(), mailer, { deferEmail: true });
      expect(await Bun.file(filePath(item.id + '.stl')).exists()).toBe(true);
    }

    await expect(finalizeBatch(batch.batchToken, rejectedMailer)).rejects.toMatchObject({ status: 502 });

    const sql = await db();
    expect(await sql`SELECT * FROM jobs`).toHaveLength(0);
    for (const item of batch.items) {
      expect(await Bun.file(filePath(item.id + '.stl')).exists()).toBe(false);
    }
  });
});
