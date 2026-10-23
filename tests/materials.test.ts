import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, closeDb } from '../src/lib/server/db';
import {
  listMaterialsWithColors,
  addMaterial,
  removeMaterial,
  addColor,
  removeColor,
} from '../src/lib/server/materials';
import { reserve, upload, confirmation, publicQueue } from '../src/lib/server/jobs';
import { submission, asciiSTL } from './fixtures';

let dir: string;
const accepted: string[] = [];
const mailer = async (mail: { text: string }) => { accepted.push(mail.text); };
const body = (text: BodyInit = asciiSTL) => new Request('http://localhost:4321/file', { method: 'PUT', body: text });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-materials-test-'));
  process.env.DATA_DIR = dir;
  process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321';
  process.env.NODE_ENV = 'test';
  await migrate();
});

afterAll(async () => {
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('Material and colour management', () => {
  test('initial state contains PLA with black, white, yellow, and red', async () => {
    const materials = await listMaterialsWithColors();
    expect(materials).toHaveLength(1);
    expect(materials[0].name).toBe('PLA');
    expect(materials[0].colors.map(c => c.name)).toEqual(['black', 'white', 'yellow', 'red']);
  });

  test('operators can add different material types and specify colours', async () => {
    // Add PETG
    const petg = await addMaterial(1, {
      name: 'PETG',
      colors: [{ name: 'clear', code: '#e2e8f0' }],
    });
    expect(petg.name).toBe('PETG');
    expect(petg.colors).toHaveLength(1);
    expect(petg.colors[0].name).toBe('clear');

    // Add ABS with multiple initial colours
    const abs = await addMaterial(1, {
      name: 'ABS',
      colors: [
        { name: 'black', code: '#353832' },
        { name: 'red', code: '#c9493b' },
      ],
    });
    expect(abs.name).toBe('ABS');
    expect(abs.colors.map(c => c.name)).toEqual(['black', 'red']);

    // Add a colour to PETG
    const petgWhite = await addColor(1, petg.id, { name: 'white', code: '#ffffff' });
    expect(petgWhite.name).toBe('white');

    const updated = await listMaterialsWithColors();
    expect(updated.map(m => m.name)).toEqual(['PLA', 'PETG', 'ABS']);
    const petgEntry = updated.find(m => m.name === 'PETG')!;
    expect(petgEntry.colors.map(c => c.name)).toEqual(['clear', 'white']);
  });

  test('duplicate materials and colours are rejected', async () => {
    // Duplicate material name (case-insensitive)
    await expect(addMaterial(1, { name: 'pla' })).rejects.toMatchObject({ status: 409 });
    await expect(addMaterial(1, { name: 'PETG' })).rejects.toMatchObject({ status: 409 });

    // Duplicate colour in same material
    const materials = await listMaterialsWithColors();
    const pla = materials.find(m => m.name === 'PLA')!;
    await expect(addColor(1, pla.id, { name: 'BLACK' })).rejects.toMatchObject({ status: 409 });
  });

  test('colour deletion enforces at least one colour per material', async () => {
    const materials = await listMaterialsWithColors();
    const petg = materials.find(m => m.name === 'PETG')!;
    const clearColor = petg.colors.find(c => c.name === 'clear')!;

    // Can delete one color when multiple exist
    await removeColor(1, petg.id, clearColor.id);
    const afterDelete = await listMaterialsWithColors();
    const petgAfter = afterDelete.find(m => m.name === 'PETG')!;
    expect(petgAfter.colors.map(c => c.name)).toEqual(['white']);

    // Cannot delete the last remaining color
    const whiteColor = petgAfter.colors[0];
    await expect(removeColor(1, petg.id, whiteColor.id)).rejects.toMatchObject({ status: 400 });
  });

  test('material deletion enforces at least one material remaining', async () => {
    const materials = await listMaterialsWithColors();
    const abs = materials.find(m => m.name === 'ABS')!;
    const petg = materials.find(m => m.name === 'PETG')!;

    await removeMaterial(1, abs.id);
    await removeMaterial(1, petg.id);

    const remaining = await listMaterialsWithColors();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('PLA');

    // Cannot remove the last material
    await expect(removeMaterial(1, remaining[0].id)).rejects.toMatchObject({ status: 400 });
  });

  test('job submission with material and colour validation', async () => {
    // Add PETG again with orange and black
    await addMaterial(1, {
      name: 'PETG',
      colors: [
        { name: 'orange', code: '#ea580c' },
        { name: 'black', code: '#353832' },
      ],
    });

    // Valid submission with PETG and orange
    const r = await reserve(submission({ material: 'PETG', color: 'orange' }));
    expect(r.id).toBeDefined();

    // Upload STL and confirm
    await upload(r.id, r.capability, body(), mailer);
    const token = new URL(accepted.at(-1)!.match(/http[^\s]+\/confirm\?token=[^\s]+/)![0]).searchParams.get('token')!;
    await confirmation(token, true);

    const queue = await publicQueue();
    const job = queue.find(j => j.id === r.id);
    expect(job).toBeDefined();
    expect(job?.material).toBe('PETG');
    expect(job?.color).toBe('orange');

    // Reject submission with material not offering the requested color
    // (e.g. PETG does not offer 'yellow')
    await expect(
      reserve(submission({ material: 'PETG', color: 'yellow' }))
    ).rejects.toMatchObject({ status: 400 });

    // Reject submission with unknown material
    await expect(
      reserve(submission({ material: 'CarbonFiber', color: 'black' }))
    ).rejects.toMatchObject({ status: 400 });
  });
});
