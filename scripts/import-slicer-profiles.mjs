import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Native test fixtures only. These profiles are never included in PrintHive exports.
// Read unmodified installed stock profiles, never user/network printer presets.
// Preset attribution/license: public/preview-profiles/NOTICE.md. No preview adaptations are used.
const [orcaDir, bambuDir, prusaDir] = process.argv.slice(2);
if (!orcaDir || !bambuDir || !prusaDir) throw new Error('Pass Orca, Bambu Studio and PrusaSlicer installation directories. ORCA_CLI may select a console host for Orca.');
const temporary = await mkdtemp(join(tmpdir(), 'printhive-desktop-profiles-'));
const materials = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];
const configurations = {};
const sources = [];
const attribution = [
  { project: 'OrcaSlicer', version: '2.3.2', repository: 'https://github.com/OrcaSlicer/OrcaSlicer', license: 'AGPL-3.0', licenseFile: 'public/preview-profiles/LICENSE.txt' },
  { project: 'Bambu Studio', version: '02.04.00.70', repository: 'https://github.com/bambulab/BambuStudio', license: 'AGPL-3.0', licenseFile: 'public/preview-profiles/LICENSE.txt' },
  { project: 'PrusaSlicer', version: '2.9.4', repository: 'https://github.com/prusa3d/PrusaSlicer', license: 'AGPL-3.0', licenseFile: 'public/preview-profiles/LICENSE.txt' },
];
async function readSource(path) {
  const bytes = await readFile(path);
  const project = path.toLowerCase().startsWith(resolve(orcaDir).toLowerCase()) ? 'OrcaSlicer' : path.toLowerCase().startsWith(resolve(bambuDir).toLowerCase()) ? 'Bambu Studio' : 'PrusaSlicer';
  sources.push({ project, file: path.replaceAll('\\', '/').replace(/^.*\/resources\//, 'resources/'), sha256: createHash('sha256').update(bytes).digest('hex') });
  return bytes.toString('utf8');
}
// Read only this small, trusted native output archive, not uploaded ZIP files.
function zipEntry(bytes, name) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Invalid native ZIP');
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const filename = bytes.subarray(offset + 46, offset + 46 + length).toString();
    if (filename === name) {
      const start = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 20);
      const dataStart = start + 30 + bytes.readUInt16LE(start + 26) + bytes.readUInt16LE(start + 28);
      const data = bytes.subarray(dataStart, dataStart + size);
      return (bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    offset += 46 + length + extra + comment;
  }
  throw new Error(`Native export missing ${name}`);
}
async function run(executable, args) {
  const child = Bun.spawn([executable, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`Native profile export failed (${code}): ${out.slice(-2000)} ${err.slice(-2000)}`);
}
async function family(slicer, install, vendor, printer, machineName, processName) {
  const presets = new Map();
  for (const kind of ['machine', 'process', 'filament']) {
    const dir = join(install, 'resources/profiles', vendor, kind);
    for (const name of await readdir(dir)) if (name.endsWith('.json')) {
      const path = join(dir, name), value = JSON.parse(await readFile(path, 'utf8'));
      presets.set(value.name, { value, path });
    }
  }
  async function expand(name, chain = []) {
    if (chain.includes(name)) throw new Error('Cyclic desktop profile');
    const entry = presets.get(name);
    if (!entry) throw new Error(`Missing stock profile: ${name}`);
    await readSource(entry.path);
    return { ...(entry.value.inherits ? await expand(entry.value.inherits, [...chain, name]) : {}), ...entry.value, inherits: '' };
  }
  const machine = await expand(machineName), process = await expand(processName);
  process.compatible_printers = [machineName];
  const machinePath = join(temporary, 'machine.json'), processPath = join(temporary, 'process.json'), filamentPath = join(temporary, 'filament.json');
  await writeFile(machinePath, JSON.stringify(machine)); await writeFile(processPath, JSON.stringify(process));
  const output = join(temporary, 'native.3mf');
  const configs = {};
  for (const material of materials) {
    const name = vendor === 'Prusa' ? `Prusa Generic ${material} @CORE One` : `Generic ${material === 'TPU' ? 'TPU for AMS' : material} @BBL H2DP`;
    const fallback = vendor === 'BBL' && material === 'TPU' ? 'Generic TPU @BBL H2DP' : name;
    const filament = await expand(presets.has(name) ? name : fallback);
    filament.compatible_printers = [machineName];
    await writeFile(filamentPath, JSON.stringify(filament));
    const executable = slicer === 'orca' ? processEnvOrca() : join(install, 'bambu-studio.exe');
    await run(executable, ['--debug', '2', '--load-settings', `${machinePath};${processPath}`, '--load-filaments', filamentPath,
      '--export-3mf', output, '--min-save', resolve('tests/support-bracket.stl')]);
    const archive = await readFile(output), model = zipEntry(archive, '3D/3dmodel.model');
    const expected = slicer === 'orca' ? '<metadata name="Application">BambuStudio-2.3.2</metadata>' : '<metadata name="Application">BambuStudio-02.04.00.70</metadata>';
    if (!model.includes(expected)) throw new Error(`Unqualified ${slicer} release: update format handling and rerun native tests before upgrading.`);
    const config = JSON.parse(zipEntry(archive, 'Metadata/project_settings.config'));
    // No network credentials are read; strip source-machine presentation paths as well.
    config.bed_custom_model = ''; config.bed_custom_texture = ''; config.post_process = [];
    configs[material] = config;
  }
  configurations[`${slicer}/${printer}`] = configs;
}
function processEnvOrca() { return process.env.ORCA_CLI || join(orcaDir, 'orca-slicer.exe'); }
async function prusa() {
  const sections = new Map(); let current;
  for (const line of (await readSource(join(prusaDir, 'resources/profiles/PrusaResearch.ini'))).split(/\r?\n/)) {
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { current = {}; sections.set(section[1], current); }
    else if (current) { const value = /^([^;#][^=]*?)\s*=\s*(.*)$/.exec(line); if (value) current[value[1].trim()] = value[2]; }
  }
  function expand(kind, name, chain = []) {
    if (chain.includes(name)) throw new Error('Cyclic Prusa profile');
    const section = sections.get(`${kind}:${name}`); if (!section) throw new Error(`Missing Prusa profile ${name}`);
    return { ...Object.assign({}, ...(section.inherits ? section.inherits.split(';').map(parent => expand(kind, parent.trim(), [...chain, name])) : [])), ...section };
  }
  const configs = {};
  for (const material of materials) {
    const name = material === 'TPU' ? 'Generic FLEX @PG' : `Generic ${material} @PG`;
    if (!sections.has(`filament:${name}`)) continue;
    const config = { ...expand('printer', 'Prusa CORE One 0.4 nozzle'), ...expand('print', '0.20mm SPEED @COREONE 0.4'), ...expand('filament', name) };
    for (const key of ['inherits', 'renamed_from', 'alias', 'printer_model', 'printer_variant', 'default_print_profile', 'default_filament_profile']) delete config[key];
    config.printer_settings_id = 'Prusa CORE One 0.4 nozzle'; config.print_settings_id = '0.20mm SPEED @COREONE 0.4'; config.filament_settings_id = name;
    const input = join(temporary, 'prusa.ini'), output = join(temporary, 'prusa.3mf'), saved = join(temporary, 'resolved.ini');
    await writeFile(input, Object.entries(config).map(([k,v]) => `${k} = ${v}`).join('\n'));
    await run(join(prusaDir, 'prusa-slicer-console.exe'), ['--load', input, '--save', saved, '--export-3mf', '--output', output, resolve('tests/support-bracket.stl')]);
    configs[material] = await readFile(saved, 'utf8');
    if (!configs[material].includes('PrusaSlicer 2.9.4')) throw new Error('Unqualified PrusaSlicer release.');
  }
  configurations['prusa/core-one'] = configs;
}
try {
  await family('orca', orcaDir, 'Prusa', 'core-one', 'Prusa CORE One 0.4 nozzle', '0.20mm SPEED @CORE One 0.4');
  await family('orca', orcaDir, 'BBL', 'h2d', 'Bambu Lab H2D Pro 0.4 nozzle', '0.20mm Standard @BBL H2DP');
  await family('bambu', bambuDir, 'BBL', 'h2d', 'Bambu Lab H2D Pro 0.4 nozzle', '0.20mm Standard @BBL H2DP');
  await prusa();
  await mkdir('tests/slicer-profiles', { recursive: true });
  const uniqueSources = Array.from(new Map(sources.map(s => [s.project + s.file + s.sha256, s])).values());
  await writeFile('tests/slicer-profiles/desktop.json', JSON.stringify({ schemaVersion: 1, attribution, sources: uniqueSources, configurations }, null, 2) + '\n');
  console.log('Imported desktop projects:', Object.keys(configurations));
} finally { await rm(temporary, { recursive: true, force: true }); }
