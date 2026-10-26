import { test, expect } from 'bun:test';
import {
  resolvePreset,
  adaptConfiguration,
  ORCA_REVISION,
} from '../scripts/import-preview-profiles.mjs';

test('preset inheritance keeps parent limits and replaces child arrays without merging their elements', async () => {
  const presets: Record<string, any> = {
    base: {
      name: 'base',
      machine_max_speed_x: ['350', '160'],
      outer_wall_speed: ['80', '120'],
    },
    child: { name: 'child', inherits: 'base', outer_wall_speed: ['170'] },
  };
  const resolved = await resolvePreset(
    async (name: string) => presets[name],
    'child',
  );
  expect(resolved.machine_max_speed_x).toEqual(['350', '160']);
  expect(resolved.outer_wall_speed).toEqual(['170']);
  await expect(
    resolvePreset(async (name: string) => ({ name, inherits: name }), 'loop'),
  ).rejects.toThrow('Cyclic');
  await expect(
    resolvePreset(async () => ({ name: 'wrong' }), 'child'),
  ).rejects.toThrow('identity');
});

test('H2D selects the right standard nozzle, preserving normal/quiet limit pairs and inherited material limits', () => {
  const options = {
    outer_wall_speed: { type: 'float', scope: 'print' },
    default_acceleration: { type: 'float', scope: 'print' },
    machine_max_speed_x: { type: 'floats', scope: 'machine' },
    filament_max_volumetric_speed: { type: 'floats', scope: 'filament' },
    printable_area: { type: 'points', scope: 'machine' },
    wall_sequence: { type: 'enum', scope: 'print' },
    machine_start_gcode: { type: 'string', scope: 'machine' },
  };
  const { configuration, omitted } = adaptConfiguration(
    {
      outer_wall_speed: ['200', '500', '210', '510'],
      default_acceleration: ['8000', '9000', '8100', '9100'],
      machine_max_speed_x: [
        '1000',
        '500',
        '1100',
        '600',
        '1200',
        '700',
        '1300',
        '800',
      ],
      filament_max_volumetric_speed: ['12', '24'],
      printable_area: ['0x0', '350x0', '350x320', '0x320'],
      wall_infill_order: 'outer wall/inner wall/infill',
      machine_start_gcode: 'Do not execute desktop snippets',
      obsolete_option: 'not supported',
    },
    options,
    true,
  );
  expect(configuration.outer_wall_speed).toBe('210');
  expect(configuration.default_acceleration).toBe('8100');
  expect(configuration.machine_max_speed_x).toEqual(['1200', '700']);
  expect(configuration.filament_max_volumetric_speed).toEqual(['12']);
  expect(configuration.printable_area).toHaveLength(4);
  expect(configuration.wall_sequence).toBe('outer wall/inner wall');
  expect(omitted).toEqual(['machine_start_gcode', 'obsolete_option']);
});

test('shipped profiles retain real printer/process/PLA settings and pinned source provenance', async () => {
  const base = new URL('../public/preview-profiles/', import.meta.url);
  const core = await Bun.file(new URL('core-one.json', base)).json();
  const h2d = await Bun.file(new URL('h2d.json', base)).json();
  const sources = await Bun.file(new URL('sources.json', base)).json();
  expect(sources.revision).toBe(ORCA_REVISION);
  expect(sources.sources).toHaveLength(21);
  for (const source of sources.sources) {
    expect(source.url).toContain(
      `/OrcaSlicer/${ORCA_REVISION}/resources/profiles/`,
    );
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(core.configuration.outer_wall_speed).toBe('170');
  expect(core.configuration.default_acceleration).toBe('3000');
  expect(core.configuration.travel_speed).toBe('350');
  expect(core.configuration.filament_max_volumetric_speed).toEqual(['15']);
  expect(core.configuration.support_threshold_angle).toBe('35');
  expect(h2d.configuration.outer_wall_speed).toBe('200');
  expect(h2d.configuration.default_acceleration).toBe('8000');
  expect(h2d.configuration.filament_max_volumetric_speed).toEqual(['12']);
  expect(h2d.configuration.machine_max_speed_x).toHaveLength(2);
  for (const profile of [core, h2d]) {
    expect(profile.configuration.nozzle_diameter).toEqual(['0.4']);
    expect(profile.configuration.support_style).toBe('default');
    expect(profile.configuration.slow_down_for_layer_cooling).toEqual(['1']);
    expect(profile.configuration.inherits).toBeUndefined();
    expect(profile.configuration.silent_mode).toBeUndefined();
    expect(profile.configuration.machine_start_gcode).toBe('');
  }
});
