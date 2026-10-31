import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises';
import { statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, migrate, closeDb } from '../src/lib/server/db';
import { reserve } from '../src/lib/server/jobs';
import { filePath } from '../src/lib/server/storage';
import { createSlicerProject, downloadSlicerProject, exportRequest, cleanupSlicerExports } from '../src/lib/server/slicer-export';
import { objectSettings } from '../src/lib/server/slicer-settings';
import { EXPORT_TTL, slicerLaunchUrl, type Slicer } from '../src/lib/slicer';
import { seal, unseal } from '../src/lib/server/tokens';
import { tetraSTL, submission } from './fixtures';
import { projectEntries } from './project-archive';

let dir: string;
const solidSTL = tetraSTL();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'printhive-slicer-'));
  process.env.DATA_DIR = dir; process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
  process.env.APP_ORIGIN = 'http://localhost:4321'; process.env.NODE_ENV = 'test';
  await migrate(); await mkdir(join(dir, 'files'), { recursive: true });
});
beforeEach(async () => { const sql = await db(); await sql`DELETE FROM jobs`; });
afterAll(async () => { await closeDb(); await rm(dir, { recursive: true, force: true }); });
async function job(overrides: Record<string, unknown> = {}) {
  const result = await reserve(submission({ supports: 'none', file_size: Buffer.byteLength(solidSTL), ...overrides }));
  await Bun.write(filePath(`${result.id}.stl`), solidSTL);
  const sql = await db();
  await sql`UPDATE jobs SET upload_state = 'ready', status = 'queued', confirmed_at = ${Date.now()} WHERE id = ${result.id}`;
  return result.id;
}
async function archive(result: Awaited<ReturnType<typeof createSlicerProject>>) {
  const token = new URL(result.downloadUrl).searchParams.get('token')!;
  const response = await downloadSlicerProject(token);
  return projectEntries(Buffer.from(await response.arrayBuffer()));
}
const request = (ids: string[], slicer: Slicer = 'orca') => ({ ids, slicer });

describe('native slicer project export', () => {
  test('exports a valid repaired mesh when BunFile size metadata is uninitialized', async () => {
    const id = await job();
    const originalFile = Bun.file;
    let wrapped = 0;
    const fileMock = spyOn(Bun, 'file').mockImplementation(((...args: Parameters<typeof Bun.file>) => {
      const file = originalFile(...args);
      if (!/[\\/]mesh-\d+\.bin$/.test(String(args[0]))) return file;
      wrapped++;
      return new Proxy(file, {
        get(target, key) {
          if (key === 'size') return 0;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof Bun.file);
    try {
      const entries = await archive(await createSlicerProject(request([id])));
      const geometry = [...entries].filter(([name]) => name.endsWith('.model')).map(([, value]) => value).join('');
      expect(geometry.match(/<vertex /g)).toHaveLength(4);
      expect(geometry.match(/<triangle /g)).toHaveLength(4);
      expect(wrapped).toBeGreaterThan(0);
    } finally { fileMock.mockRestore(); }
  });
  test('still rejects a repaired mesh whose payload is truncated after a valid header', async () => {
    const id = await job();
    const originalFile = Bun.file;
    let truncated = false;
    const fileMock = spyOn(Bun, 'file').mockImplementation(((...args: Parameters<typeof Bun.file>) => {
      const path = String(args[0]);
      if (!truncated && /[\\/]mesh-\d+\.bin$/.test(path)) {
        truncateSync(path, statSync(path).size - 4);
        truncated = true;
      }
      return originalFile(...args);
    }) as typeof Bun.file);
    try {
      await expect(createSlicerProject(request([id]))).rejects.toMatchObject({
        status: 500, message: 'Invalid repaired mesh.',
        cause: { message: 'Repaired mesh validation: vertices=4, triangles=4, expectedBytes=116, actualBytes=112' },
      });
      expect(truncated).toBe(true);
    } finally { fileMock.mockRestore(); }
  });
  test('exports repaired meshes larger than 16 KiB without trailing buffer bytes', async () => {
    const count = 1500, triangles = count * 4;
    const bytes = new Uint8Array(84 + triangles * 50), view = new DataView(bytes.buffer);
    view.setUint32(80, triangles, true);
    const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
    let faceIndex = 0;
    for (let i = 0; i < count; i++) {
      const ox = (i % 50) * 2, oy = Math.floor(i / 50) * 2;
      for (const face of faces) {
        const base = 84 + faceIndex++ * 50 + 12;
        for (let v = 0; v < 3; v++) {
          const point = vertices[face[v]];
          view.setFloat32(base + v * 12, point[0] + ox, true);
          view.setFloat32(base + v * 12 + 4, point[1] + oy, true);
          view.setFloat32(base + v * 12 + 8, point[2], true);
        }
      }
    }
    const id = await job({ file_size: bytes.byteLength });
    await Bun.write(filePath(`${id}.stl`), bytes);
    const entries = await archive(await createSlicerProject(request([id])));
    const geometry = [...entries].filter(([name]) => name.endsWith('.model')).map(([, value]) => value).join('');
    expect(geometry.match(/<vertex /g)).toHaveLength(count * 4);
    expect(geometry.match(/<triangle /g)).toHaveLength(triangles);
  });
  test('preserves different settings and copies, omits private metadata, and emits a valid ZIP', async () => {
    const first = await job({ copies: 2, infill: 50, walls: 6, layer_height: 0.12, supports: 'tree', support_angle: 0 });
    const second = await job({ infill: 20, walls: 3, layer_height: 0.28, supports: 'normal', support_angle: 80 });
    const result = await createSlicerProject(request([first, second]));
    expect(result.launchUrl).toStartWith('orcaslicer://open?file=');
    expect(decodeURIComponent(result.launchUrl!.split('file=')[1])).toBe(result.downloadUrl);
    expect(result.downloadUrl.split('/').at(-1)).toMatch(/^printhive-[A-F0-9]+\.3mf$/);
    const entries = await archive(result), model = entries.get('3D/3dmodel.model')!, settings = entries.get('Metadata/model_settings.config')!;
    expect(model.match(/<object /g)).toHaveLength(2); expect(model.match(/<item /g)).toHaveLength(3);
    expect(settings).toContain('key="sparse_infill_density" value="50%"');
    expect(settings).toContain('key="sparse_infill_density" value="20%"');
    expect(settings).toContain('key="wall_loops" value="6"');
    expect(settings).toContain('key="wall_loops" value="3"');
    expect(settings).toContain('key="layer_height" value="0.12"'); expect(settings).toContain('key="layer_height" value="0.28"');
    expect(settings).toContain('key="support_threshold_angle" value="0"'); expect(settings).toContain('key="support_threshold_angle" value="80"');
    expect(settings).toContain('value="tree(auto)"'); expect(settings).toContain('value="normal(auto)"');
    expect(entries.has('Metadata/project_settings.config')).toBe(false);
    for (const text of entries.values()) for (const privateValue of ['test@purdue.edu', 'Private notes', 'bracket.stl', 'Test bracket']) expect(text).not.toContain(privateValue);
  });
  test('all slicers receive object settings without replacing local printer, filament or process presets', async () => {
    const id = await job({ infill: 30, walls: 5, supports: 'tree', support_angle: 45 });
    for (const slicer of ['orca', 'bambu', 'prusa'] as const) {
      const result = await createSlicerProject(request([id], slicer)), entries = await archive(result);
      expect(entries.has('Metadata/project_settings.config')).toBe(false);
      expect(entries.has('Metadata/Slic3r_PE.config')).toBe(false);
      expect([...entries.keys()].some(name => /(?:print|process|filament|machine)_settings?_/.test(name))).toBe(false);
      for (const text of entries.values()) for (const key of ['printer_settings_id', 'printer_model', 'machine_start_gcode', 'start_gcode',
        'nozzle_temperature', 'first_layer_temperature', 'filament_colour', 'enable_prime_tower', 'print_sequence', 'initial_layer_print_height'])
        expect(text).not.toContain(key);
      if (slicer !== 'prusa') {
        expect(entries.get('Metadata/model_settings.config')).toContain('key="wall_loops" value="5"');
        expect(result.launchUrl).toStartWith(slicer === 'bambu' ? 'bambustudio://' : 'orcaslicer://');
        expect(entries.get('3D/3dmodel.model')).not.toContain('name="OrcaSlicer"');
      } else {
        expect(result.launchUrl).toBeNull();
        expect(entries.get('Metadata/Slic3r_PE_model.config')).toContain('key="fill_density" value="30%"');
        expect(entries.get('Metadata/Slic3r_PE_model.config')).toContain('key="perimeters" value="5"');
        expect(entries.get('Metadata/Slic3r_PE_model.config')).toContain('key="support_material_style" value="organic"');
      }
    }
  });
  test('undecided supports inherit the local process while explicit none still disables supports', async () => {
    const id = await job({ supports: 'operator', support_angle: 45 });
    const none = await job({ supports: 'none' });
    for (const slicer of ['orca', 'bambu', 'prusa'] as const) {
      const result = await createSlicerProject(request([id], slicer));
      const entries = await archive(result);
      const settingsFile = slicer === 'prusa' ? 'Metadata/Slic3r_PE_model.config' : 'Metadata/model_settings.config';
      expect(entries.get(settingsFile)).not.toMatch(/key="(?:enable_support|support_[^"]*)"/);
      expect(entries.get(settingsFile)).toContain('key="layer_height"');
      const disabled = await archive(await createSlicerProject(request([none], slicer)));
      expect(disabled.get(settingsFile)).toContain(`key="${slicer === 'prusa' ? 'support_material' : 'enable_support'}" value="0"`);
    }
    const sql = await db();
    expect((await sql`SELECT supports, support_angle FROM jobs WHERE id = ${id}`)[0]).toMatchObject({ supports: 'operator', support_angle: 45 });
    expect(() => exportRequest({ ...request([id]), supports: { [id]: 'tree' } })).toThrow('Unsupported export option');
  });
  test('snapshot survives subsequent database changes and links permit retries until expiry', async () => {
    const id = await job(); const result = await createSlicerProject(request([id]));
    const token = new URL(result.downloadUrl).searchParams.get('token')!, decoded = unseal(token, 'slicer-export');
    expect(decoded.expires).toBeGreaterThan(Date.now());
    const before = await (await downloadSlicerProject(token)).arrayBuffer();
    const sql = await db(); await sql`UPDATE jobs SET infill = 50 WHERE id = ${id}`;
    const after = await (await downloadSlicerProject(token)).arrayBuffer(); expect(Buffer.from(after)).toEqual(Buffer.from(before));
    await expect(downloadSlicerProject(seal(decoded.id, 'slicer-export', Date.now() - 1))).rejects.toThrow('expired');
    await expect(downloadSlicerProject(seal(decoded.id, 'upload', Date.now() + 10000))).rejects.toThrow('invalid');
    await expect(downloadSlicerProject('x' + token)).rejects.toThrow('invalid');
    await expect(downloadSlicerProject(seal(randomUUID(), 'slicer-export', Date.now() + 10000))).rejects.toThrow('no longer');
  });
  test('rejects unconfirmed/missing jobs, incompatible materials and oversized inputs', async () => {
    await expect(createSlicerProject(request([randomUUID()]))).rejects.toThrow('unavailable');
    const id = await job(); const sql = await db();
    await sql`UPDATE jobs SET confirmed_at = NULL WHERE id = ${id}`;
    await expect(createSlicerProject(request([id]))).rejects.toThrow('unavailable');
    await sql`UPDATE jobs SET confirmed_at = ${Date.now()} WHERE id = ${id}`;
    const other = await job();
    await sql`UPDATE jobs SET material = 'PLA', file_size = ${500 * 1024 * 1024} WHERE id = ${id}`;
    await expect(createSlicerProject(request([id, other]))).rejects.toThrow('500 MiB');
    await sql`UPDATE jobs SET file_size = ${Buffer.byteLength(solidSTL)} WHERE id = ${id}`;
    await sql`UPDATE jobs SET color = 'white' WHERE id = ${other}`;
    await expect(createSlicerProject(request([id, other]))).rejects.toThrow('same material and color');
  });
  test('exports oversized models and copies at original scale for every slicer', async () => {
    const id = await job({ copies: 5 });
    const large = solidSTL.replaceAll('vertex 10 0 0', 'vertex 400 0 0')
      .replaceAll('vertex 0 10 0', 'vertex 0 350 0').replaceAll('vertex 0 0 10', 'vertex 0 0 400');
    await Bun.write(filePath(`${id}.stl`), large); const sql = await db();
    await sql`UPDATE jobs SET file_size = ${Buffer.byteLength(large)} WHERE id = ${id}`;
    for (const slicer of ['orca', 'bambu', 'prusa'] as const) {
      const entries = await archive(await createSlicerProject(request([id], slicer)));
      const geometry = [...entries].filter(([name]) => name.endsWith('.model')).map(([, value]) => value).join('');
      const vertices = [...geometry.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(vertex => vertex.slice(1).map(Number));
      for (const [axis, extent] of [400, 350, 400].entries())
        expect(Math.max(...vertices.map(vertex => vertex[axis])) - Math.min(...vertices.map(vertex => vertex[axis]))).toBe(extent);
      const transforms = [...geometry.matchAll(/<item [^>]*transform="([^"]+)"/g)].map(item => item[1].split(' ').map(Number));
      expect(transforms).toHaveLength(5);
      for (const transform of transforms) expect(transform.slice(0, 9)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      for (let first = 0; first < transforms.length; first++) for (let second = first + 1; second < transforms.length; second++) {
        const [a, b] = [transforms[first], transforms[second]];
        expect(a[9] + 400 <= b[9] || b[9] + 400 <= a[9] || a[10] + 350 <= b[10] || b[10] + 350 <= a[10]).toBe(true);
      }
    }
  });
  test('expired artifacts and abandoned builds are cleaned without deleting source files', async () => {
    const id = await job(), result = await createSlicerProject(request([id]));
    const decoded = unseal(new URL(result.downloadUrl).searchParams.get('token')!, 'slicer-export');
    const path = join(dir, 'slicer-exports', `${decoded.id}.3mf`), old = new Date(Date.now() - EXPORT_TTL - 120000);
    await utimes(path, old, old); await cleanupSlicerExports();
    expect(await Bun.file(path).exists()).toBe(false); expect(await Bun.file(filePath(`${id}.stl`)).exists()).toBe(true);
  });
  test('rejects invalid selections, slicers and unsupported options', () => {
    const id = randomUUID();
    for (const body of [null, {}, request([]), request([id, id]), request(Array.from({length:11}, randomUUID)),
      { ...request([id]), slicer: 'evil' }, { ...request([id]), layout: 'unknown' },
      { ...request([id]), supports: { [id]: 'auto' } }, { ...request([id]), settings: { layer_height: 99 } }])
      expect(() => exportRequest(body)).toThrow();
    expect(slicerLaunchUrl('prusa', 'https://example.test')).toBeNull();
    expect(exportRequest({ ...request([id], 'prusa'), printer: 'h2d' })).toEqual(request([id], 'prusa'));
  });
  test('blank support angle inherits while explicit zero is retained', () => {
    const settings = { infill:15, walls:2, layer_height:0.2, supports:'tree', copies:1, mirror:0, material:'PLA', color:'black' };
    expect(objectSettings(settings, 'tree', 'orca').support_threshold_angle).toBeUndefined();
    expect(objectSettings({...settings,support_angle:0}, 'tree', 'orca').support_threshold_angle).toBe('0');
  });
  test('legacy mirroring flips geometry and winding once without injecting filament colors', async () => {
    const id = await job({ mirror: 1 });
    const sql = await db();
    const [saved] = await sql`SELECT code FROM material_colors WHERE name = 'black'`;
    try {
      await sql`UPDATE material_colors SET code = '#123456' WHERE name = 'black'`;
      const entries = await archive(await createSlicerProject(request([id])));
      const model = [...entries].filter(([name]) => name.endsWith('.model')).map(([,value]) => value).join('');
      expect(model).toContain('<vertex x="10" y="0" z="0"/>');
      expect(model).toContain('<vertex x="0" y="0" z="0"/>');
      expect(model).toContain('<triangle v1="0" v2="2" v3="1"/>');
      expect(entries.has('Metadata/project_settings.config')).toBe(false);
      expect([...entries.values()].join('')).not.toContain('#123456');
    } finally { await sql`UPDATE material_colors SET code = ${saved.code} WHERE name = 'black'`; }
  });
  test('canceled generation releases its slot and invalid support types cannot select a preset', async () => {
    const id = await job();
    expect(() => exportRequest({ ...request([id]), supports: { [id]: ['none'] } })).toThrow('Unsupported export option');
    await expect(createSlicerProject(request([id]), AbortSignal.abort())).rejects.toThrow('canceled');
    expect((await createSlicerProject(request([id]))).downloadUrl).toContain('/api/slicer-projects?token=');
  });
  test('all slicers retain shared edges and repair STL seams without changing copies or dimensions', async () => {
    const id = await job({ copies: 2 });
    const source = tetraSTL(0.000001);
    await Bun.write(filePath(`${id}.stl`), source);
    const sql = await db(); await sql`UPDATE jobs SET file_size = ${Buffer.byteLength(source)} WHERE id = ${id}`;
    for (const slicer of ['orca', 'bambu', 'prusa'] as const) {
      const entries = await archive(await createSlicerProject(request([id], slicer)));
      const model = [...entries].filter(([name]) => name.endsWith('.model')).map(([, value]) => value).join('');
      expect(model.match(/<vertex /g)).toHaveLength(4);
      expect(model.match(/<triangle /g)).toHaveLength(4);
      expect(model.match(/<item /g)).toHaveLength(2);
      const edges = new Map<string, number>();
      for (const face of model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
        const indices = face.slice(1).map(Number);
        for (let axis = 0; axis < 3; axis++) {
          const a = indices[axis], b = indices[(axis + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect([...edges.values()]).toEqual([2, 2, 2, 2, 2, 2]);
      const vertices = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(vertex => vertex.slice(1).map(Number));
      for (let axis = 0; axis < 3; axis++) expect(Math.max(...vertices.map(vertex => vertex[axis]))).toBeCloseTo(10, 5);
    }
  });
});
