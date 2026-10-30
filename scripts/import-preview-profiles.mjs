import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Match the browser engine, rather than mixing current presets with an older slicer.
export const ORCA_REVISION = '8500fcdccaa10b5099ac20d252af3a7c560046f1';
const upstream = `https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/${ORCA_REVISION}/`;
const selections = [
  {
    file: 'core-one.json',
    vendor: 'Prusa',
    printerId: 'prusa-core-one-plus',
    machine: 'Prusa CORE One 0.4 nozzle',
    process: '0.20mm SPEED @CORE One 0.4',
    filament: 'Prusa Generic PLA @CORE One',
    label: 'Prusa Core ONE+ / Generic PLA / 0.4 mm',
    bed: [250, 220, 270],
  },
  {
    file: 'h2d.json',
    vendor: 'BBL',
    printerId: 'bambu-h2d',
    machine: 'Bambu Lab H2D Pro 0.4 nozzle',
    process: '0.20mm Standard @BBL H2DP',
    filament: 'Generic PLA @BBL H2DP',
    label: 'Bambu H2D Pro / Generic PLA / 0.4 mm',
    bed: [325, 320, 325],
  },
];

export async function resolvePreset(load, name, ancestors = []) {
  if (ancestors.includes(name))
    throw new Error(`Cyclic preset inheritance: ${name}`);
  const value = await load(name);
  if (!value || value.name !== name)
    throw new Error(`Wrong preset identity: ${name}`);
  const parent = value.inherits
    ? await resolvePreset(load, value.inherits, [...ancestors, name])
    : {};
  return { ...parent, ...value };
}

// These legacy aliases are converted by PrintConfigDef::handle_legacy at the pin above.
function legacyKey(key, value) {
  if (key === 'wall_infill_order') {
    const order = {
      'inner wall/outer wall/infill': 'inner wall/outer wall',
      'infill/inner wall/outer wall': 'inner wall/outer wall',
      'outer wall/inner wall/infill': 'outer wall/inner wall',
      'infill/outer wall/inner wall': 'outer wall/inner wall',
      'inner-outer-inner wall/infill': 'inner-outer-inner wall',
    };
    return ['wall_sequence', order[value] ?? value];
  }
  return [
    {
      chamber_temperatures: 'chamber_temperature',
      extruder_clearance_max_radius: 'extruder_clearance_radius',
      machine_switch_extruder_time: 'machine_tool_change_time',
    }[key] ?? key,
    value,
  ];
}

export function adaptConfiguration(resolved, options, h2d) {
  /** @type {Record<string, string | string[]>} */
  const configuration = {};
  const omitted = [];
  const vectors = new Set([
    'floats',
    'ints',
    'percents',
    'floatsOrPercents',
    'strings',
    'bools',
    'enums',
  ]);
  for (const [original, originalValue] of Object.entries(resolved)) {
    let [key, value] = legacyKey(original, originalValue);
    const definition = options[key];
    // Preset selection, desktop presentation and executable snippets are not print-body inputs.
    if (
      !definition ||
      key === 'inherits' ||
      (key.endsWith('_gcode') &&
        ['string', 'strings'].includes(definition.type)) ||
      /^(compatible_|default_(?!acceleration)|print_host|printhost_|host_type|thumbnails|post_process)/.test(
        key,
      ) ||
      [
        'silent_mode',
        'tree_support_with_infill',
        'printer_notes',
        'filament_notes',
        'printer_settings_id',
        'print_settings_id',
        'filament_settings_id',
      ].includes(key)
    ) {
      omitted.push(original);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    // Orca stores H2D process variants as left standard/HF, right standard/HF.
    // Machine limits have a normal/quiet pair per variant; keep that pair intact.
    const index =
      h2d && values.length === 4 && definition.scope !== 'filament' ? 2 : 0;
    if (vectors.has(definition.type)) {
      configuration[key] = /^machine_(max|min)_/.test(key)
        ? values.slice(
            h2d && values.length === 8 ? 4 : 0,
            h2d && values.length === 8 ? 6 : 2,
          )
        : values.length
          ? [values[index]]
          : [];
    } else if (['points', 'pointsGroups'].includes(definition.type)) {
      configuration[key] = value;
    } else {
      value = values[index];
      if (
        key === 'ensure_vertical_shell_thickness' &&
        ['0', '1'].includes(value)
      )
        value = value === '1' ? 'ensure_all' : 'ensure_moderate';
      if (key === 'overhang_fan_threshold' && value === '5%') value = '10%';
      configuration[key] = value;
    }
  }
  return { configuration, omitted: omitted.sort() };
}

async function describeRuntime(base) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base)));
  if (manifest.engine.version !== '2.4.2')
    throw new Error('Unexpected browser engine version');
  for (const key of ['module', 'wasm', 'data']) {
    const bytes = await readFile(new URL(manifest[key].file, base));
    if (
      createHash('sha256').update(bytes).digest('hex') !== manifest[key].sha256
    )
      throw new Error(`Runtime integrity mismatch: ${key}`);
  }
  const factory = (await import(new URL(manifest.module.file, base))).default;
  const module = await factory({
    wasmBinary: await readFile(new URL(manifest.wasm.file, base)),
    locateFile: (file) => fileURLToPath(new URL(file, base)),
    print() {},
    printErr() {},
  });
  const out = module._malloc(8);
  try {
    if (module._cs_describe_config(out, out + 4))
      throw new Error('Cannot describe browser engine');
    const [pointer, length] = new Uint32Array(module.HEAPU8.buffer, out, 2);
    try {
      return {
        manifest,
        options: JSON.parse(
          new TextDecoder().decode(
            module.HEAPU8.subarray(pointer, pointer + length),
          ),
        ).options,
      };
    } finally {
      module._cs_free(pointer);
    }
  } finally {
    module._free(out);
  }
}

async function main() {
  const app = new URL('../', import.meta.url);
  const { manifest, options } = await describeRuntime(
    new URL('public/preview-engine/', app),
  );
  const cache = new Map(),
    sources = new Map();
  async function load(vendor, type, name) {
    const path = `resources/profiles/${vendor}/${type}/${name}.json`;
    if (!cache.has(path))
      cache.set(
        path,
        (async () => {
          const url =
            upstream + path.split('/').map(encodeURIComponent).join('/');
          const response = await fetch(url);
          if (!response.ok)
            throw new Error(`Cannot fetch preset: ${response.status} ${url}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          sources.set(path, {
            path,
            url,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
          return JSON.parse(bytes);
        })(),
      );
    return cache.get(path);
  }
  const generated = [];
  for (const selection of selections) {
    const chains = await Promise.all(
      ['machine', 'process', 'filament'].map((type) =>
        resolvePreset(
          (name) => load(selection.vendor, type, name),
          selection[type],
        ),
      ),
    );
    const h2d = selection.vendor === 'BBL';
    const { configuration, omitted } = adaptConfiguration(
      Object.assign({}, ...chains),
      options,
      h2d,
    );
    const [x, y, z] = selection.bed;
    Object.assign(configuration, {
      nozzle_diameter: ['0.4'],
      filament_diameter: ['1.75'],
      printable_area: ['0x0', `${x}x0`, `${x}x${y}`, `0x${y}`],
      printable_height: String(z),
      // One standard nozzle/material, with no toolchange/timelapse helpers or custom G-code.
      extruder_offset: ['0x0'],
      extruder_printable_area: [`0x0,${x}x0,${x}x${y},0x${y}`],
      extruder_printable_height: [String(z)],
      printer_extruder_id: ['1'],
      printer_extruder_variant: ['Direct Drive Standard'],
      print_extruder_id: ['1'],
      print_extruder_variant: ['Direct Drive Standard'],
      filament_extruder_variant: ['Direct Drive Standard'],
      nozzle_volume_type: ['Standard'],
      master_extruder_id: '1',
      support_style: 'default',
      enable_prime_tower: '0',
      use_relative_e_distances: '0',
      machine_start_gcode: '',
      machine_end_gcode: '',
      filament_start_gcode: [''],
      filament_end_gcode: [''],
    });
    const profile = {
      schemaVersion: 1,
      timeAllowancePercent: 30,
      printerId: selection.printerId,
      id: `${selection.printerId}-generic-pla-0.4-orca-2.4.2-v1`,
      label: selection.label,
      basis: `OrcaSlicer 2.4.2 (${ORCA_REVISION}): ${selection.machine}; ${selection.process}; ${selection.filament}. Resolved inheritance, single standard nozzle, default support style; print body only, uncalibrated.`,
      configuration: Object.fromEntries(
        Object.entries(configuration).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    generated.push({ selection, profile, omitted });
  }
  const provenance = {
    schemaVersion: 1,
    repository: 'https://github.com/OrcaSlicer/OrcaSlicer',
    revision: ORCA_REVISION,
    license: 'AGPL-3.0-only',
    runtimeSha256: manifest.wasm.sha256,
    profiles: generated.map(({ selection, omitted }) => ({
      ...selection,
      omitted,
    })),
    sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  for (const { selection, profile } of generated)
    await writeFile(
      new URL(`public/preview-profiles/${selection.file}`, app),
      JSON.stringify(profile, null, 2) + '\n',
    );
  await writeFile(
    new URL('public/preview-profiles/sources.json', app),
    JSON.stringify(provenance, null, 2) + '\n',
  );
  console.log(
    `Imported ${generated.length} profiles from ${sources.size} pinned Orca presets.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
