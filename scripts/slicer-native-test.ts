import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db, migrate, closeDb } from '../src/lib/server/db';
import { reserve } from '../src/lib/server/jobs';
import { filePath } from '../src/lib/server/storage';
import { createSlicerProject, downloadSlicerProject } from '../src/lib/server/slicer-export';
import { projectEntries } from '../tests/project-archive';
import { writeProjectZip } from '../src/lib/server/project-zip';
import localProfiles from '../tests/slicer-profiles/desktop.json';
import { submission } from '../tests/fixtures';
import { reference } from '../src/lib/shared';
import type { Slicer } from '../src/lib/slicer';

const targets = [
  { slicer: 'orca', printer: 'core-one', executable: process.env.ORCA_CLI },
  { slicer: 'orca', printer: 'h2d', executable: process.env.ORCA_CLI },
  { slicer: 'bambu', printer: 'h2d', executable: process.env.BAMBU_CLI },
  { slicer: 'prusa', printer: 'core-one', executable: process.env.PRUSA_CLI },
] as const;
assert(targets.every(target => target.executable), 'Set ORCA_CLI, BAMBU_CLI and PRUSA_CLI to installed desktop slicers.');
const dir = await mkdtemp(join(tmpdir(), 'printhive-native-'));
const outputs = resolve(process.env.SLICER_NATIVE_OUTPUT ?? 'test-results/slicer-native');
process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test'; process.env.APP_ORIGIN = 'http://localhost:4321'; process.env.CONFIRMATION_SECRET = 'a'.repeat(64);
async function run(executable: string, args: string[], name: string) {
  const child = Bun.spawn([executable, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await Bun.write(join(outputs, `${name}.log`), out + '\n' + err);
  assert.equal(code, 0, `Native ${name} failed: ${out.slice(-1800)} ${err.slice(-1800)}`);
}
try {
  await mkdir(outputs, { recursive: true }); await mkdir(join(dir, 'files'), { recursive: true }); await migrate();
  const source = await readFile('tests/support-bracket.stl');
  const ids: string[] = [];
  for (const [index, overrides] of [{ infill: 50, layer_height: 0.12, supports: 'tree', support_angle: 0, copies: 2 },
    { infill: 20, layer_height: 0.28, supports: 'normal', support_angle: 80 },
    { supports: 'operator', support_angle: 45 }].entries()) {
    const item = await reserve(submission({ title: `Native sample ${index}`, file_size: source.length, ...overrides }));
    await Bun.write(filePath(`${item.id}.stl`), source);
    const sql = await db(); await sql`UPDATE jobs SET confirmed_at = ${Date.now()}, upload_state = 'ready', status = 'queued' WHERE id = ${item.id}`;
    ids.push(item.id);
  }
  for (const target of targets) {
    const name = `${target.slicer}-${target.printer}`;
    console.log(`${name}: preparing a model-only project with a separate local preset baseline.`);
    const project = await createSlicerProject({ ids, slicer: target.slicer as Slicer });
    const token = new URL(project.downloadUrl).searchParams.get('token')!;
    const publicInput = join(outputs, `${name}.3mf`), output = join(outputs, `${name}-roundtrip.3mf`);
    const publicBytes = Buffer.from(await (await downloadSlicerProject(token)).arrayBuffer());
    await Bun.write(publicInput, publicBytes);
    const publicEntries = projectEntries(publicBytes);
    assert(!publicEntries.has('Metadata/project_settings.config') && !publicEntries.has('Metadata/Slic3r_PE.config'), 'Export contains global presets');
    const baseline = (localProfiles.configurations as Record<string, Record<string, Record<string, unknown> | string>>)[`${target.slicer}/${target.printer}`].PLA;
    let input = publicInput;
    let localArgs: string[] = [];
    if (target.slicer === 'prusa') {
      const ini = String(baseline).replace(/^first_layer_height\s*=.*$/m, 'first_layer_height = 0.24')
        .replace(/^support_material\s*=.*$/m, 'support_material = 1')
        .replace(/^support_material_auto\s*=.*$/m, 'support_material_auto = 1')
        .replace(/^support_material_style\s*=.*$/m, 'support_material_style = snug')
        .replace(/^support_material_threshold\s*=.*$/m, 'support_material_threshold = 37')
        .replace(/^temperature\s*=.*$/m, 'temperature = 217').replace(/^binary_gcode\s*=.*$/m, 'binary_gcode = 0')
        .replace(/^start_gcode\s*=\s*/m, 'start_gcode = ; LOCAL_PRINTER_SENTINEL\\n');
      const path = join(outputs, `${name}-local.ini`); await Bun.write(path, ini);
      localArgs = ['--load', path, '--save', join(outputs, `${name}-resolved.ini`)];
    } else {
      // Bambu/Orca CLI requires a full config and has no selected GUI presets.
      // Compose a test-only local baseline, exactly as the GUI combines selected
      // presets with object overrides. This file is never served by PrintHive.
      const config = { ...(baseline as Record<string, unknown>), initial_layer_print_height: '0.24', nozzle_temperature: ['217'],
        filament_colour: ['#123456'], machine_start_gcode: '; LOCAL_PRINTER_SENTINEL\n' + (baseline as Record<string, unknown>).machine_start_gcode,
        enable_prime_tower: '0', enable_support: '1', support_type: 'normal(auto)', support_style: 'snug', support_threshold_angle: '37' };
      input = join(outputs, `${name}-local.3mf`);
      await writeProjectZip(input, [...publicEntries].map(([name, content]) => ({ name, content })).concat([
        { name: 'Metadata/project_settings.config', content: JSON.stringify(config) },
      ]));
    }
    const args = target.slicer === 'prusa' ? [...localArgs, '--export-3mf', '--output', output, input] :
      ['--debug', '2', '--export-3mf', output, input];
    await run(target.executable!, args, name);
    const entries = projectEntries(await readFile(output));
    const settings = entries.get(target.slicer === 'prusa' ? 'Metadata/Slic3r_PE_model.config' : 'Metadata/model_settings.config') ?? '';
    assert.match(settings, /key="layer_height" value="0.12"/);
    assert.match(settings, /key="layer_height" value="0.28"/);
    assert.match(settings, /value="50%"/); assert.match(settings, /value="20%"/);
    assert.match(settings, target.slicer === 'prusa' ? /value="organic"/ : /value="tree\(auto\)"/);
    const angleKey = target.slicer === 'prusa' ? 'support_material_threshold' : 'support_threshold_angle';
    assert.match(settings, new RegExp(`key="${angleKey}" value="0"`));
    assert.match(settings, new RegExp(`key="${angleKey}" value="80"`));
    assert.equal((settings.match(/<object /g) ?? []).length, 3, 'Native import merged distinct objects');
    const inherited = [...settings.matchAll(/<object\b[^>]*>[\s\S]*?<\/object>/g)]
      .map(match => match[0]).find(object => object.includes(`value="Print ${reference(ids[2])}"`));
    assert(inherited, 'Native import lost the object inheriting process supports');
    assert.doesNotMatch(inherited, /key="(?:enable_support|support_[^"]*)"/, 'Undecided supports override the local process');
    const geometry = [...entries].filter(([path]) => path.endsWith('.model')).map(([,value]) => value).join('');
    assert.match(geometry, /<vertex /); assert.match(geometry, /<triangle /);
    assert.equal((geometry.match(/<item /g) ?? []).length, 4, 'Native import lost a copy');
    if (target.slicer === 'prusa') {
      // Prusa's CLI does not embed --load settings in an exported model-only 3MF.
      const config = await readFile(join(outputs, `${name}-resolved.ini`), 'utf8');
      assert.match(config, /first_layer_height = 0.24/); assert.match(config, /temperature = 217/);
      assert(config.includes('LOCAL_PRINTER_SENTINEL'));
      assert.match(config, /^support_material = 1$/m); assert.match(config, /^support_material_style = snug$/m);
      assert.match(config, /^support_material_threshold = 37$/m);
    } else {
      const config = JSON.parse(entries.get('Metadata/project_settings.config')!);
      assert.equal(config.initial_layer_print_height, '0.24'); assert.equal(config.nozzle_temperature[0], '217');
      assert.equal(config.filament_colour[0], '#123456'); assert(config.machine_start_gcode.includes('LOCAL_PRINTER_SENTINEL'));
      assert.equal(config.enable_support, '1'); assert.equal(config.support_type, 'normal(auto)');
      assert.equal(config.support_style, 'snug'); assert.equal(config.support_threshold_angle, '37');
      if (target.printer === 'h2d') assert.equal(config.printer_model, 'Bambu Lab H2D Pro');
    }
    console.log(`${name}: native round-trip retained geometry, distinct object settings and supports.`);
    const sliced = join(outputs, `${name}-sliced.${target.slicer === 'prusa' ? 'gcode' : '3mf'}`);
    await run(target.executable!, target.slicer === 'prusa' ? [...localArgs, '--export-gcode', '--output', sliced, input] :
      ['--debug', '2', '--slice', '0', '--export-3mf', sliced, input], `${name}-slice`);
    const slicedBytes = await readFile(sliced);
    const gcode = target.slicer === 'prusa' ? slicedBytes.toString() : projectEntries(slicedBytes).get('Metadata/plate_1.gcode');
    assert(gcode, 'Native slicer did not produce toolpaths');
    const layers = [...gcode.matchAll(/^;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\s*$/gm)];
    assert(layers.length >= 2, 'Native slicer did not produce multiple layers');
    const firstLayer = gcode.slice(layers[0].index, layers[1].index);
    assert(firstLayer.split('\n').some(line => /^G[123]\s/.test(line) && /[XY]-?\d/.test(line) && /\bE(?:\d*\.)?\d*[1-9]\d*/.test(line)),
      'Native slicer produced no XY extrusion on the first layer');
    if (target.slicer !== 'prusa') {
      const bambuLabels = [...firstLayer.matchAll(/^; start printing object, unique label id: (\d+)/gm)].map(match => match[1]);
      const objects = bambuLabels.length ? bambuLabels :
        [...firstLayer.matchAll(/^; printing object (.+) id:(\d+) copy (\d+)/gm)].map(match => `${match[1]}:${match[2]}:${match[3]}`);
      assert.equal(new Set(objects).size, 4, 'A model copy is missing from the first layer');
    }
    console.log(`${name}: native slicing completed with actual first-layer extrusion.`);
  }
} finally { await closeDb(); await rm(dir, { recursive: true, force: true }); }
