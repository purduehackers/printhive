import { test, expect } from 'bun:test';
import {
  PREVIEW_PRINTERS,
  PREVIEW_PROFILE_FILES,
  parsePreviewProfile,
  fitsPreviewPrinter,
  selectPreviewPrinter,
  profileForPreviewBed,
  formatPrintTime,
  applyPrintTimeAllowance,
} from '../src/lib/preview';

test('preview bed uses actual oriented axes and height, preferring Core ONE then single-nozzle H2D', () => {
  expect(selectPreviewPrinter([30, 10, 24]).id).toBe('prusa-core-one-plus');
  expect(selectPreviewPrinter([250, 220, 270]).id).toBe('prusa-core-one-plus');
  for (const dimensions of [
    [251, 20, 20],
    [20, 221, 20],
    [20, 20, 271],
    [220, 250, 20],
  ])
    expect(selectPreviewPrinter(dimensions).id).toBe('bambu-h2d');
  expect(fitsPreviewPrinter([325, 320, 325], PREVIEW_PRINTERS[1])).toBe(true);
  expect(
    fitsPreviewPrinter([326, 100, 100], selectPreviewPrinter([326, 100, 100])),
  ).toBe(false);
  expect(fitsPreviewPrinter([20, 20, 326], PREVIEW_PRINTERS[1])).toBe(false);
});

test('bed selection changes explicit native limits without mutating the source settings', () => {
  const profile = {
    id: 'test',
    label: 'Test',
    configuration: {
      printable_area: ['0x0', '200x0', '200x200', '0x200'],
      printable_height: '200',
      outer_wall_speed: '99',
    },
  };
  const selected = profileForPreviewBed(profile, PREVIEW_PRINTERS[0]);
  expect(selected.configuration.printable_area).toEqual([
    '0x0',
    '250x0',
    '250x220',
    '0x220',
  ]);
  expect(selected.configuration.printable_height).toBe('270');
  expect(selected.configuration.outer_wall_speed).toBe('99');
  expect(selected.id).toContain('prusa-core-one-plus');
  expect(profile.configuration.printable_height).toBe('200');
  expect(profile.configuration.printable_area[1]).toBe('200x0');
});

test('preview applies wall count to the slicer profile without mutating its defaults', () => {
  const profile = { id: 'test', label: 'Test', configuration: { wall_loops: '2' } };
  for (const walls of [2, 3, 4, 5, 6])
    expect(profileForPreviewBed(profile, PREVIEW_PRINTERS[0], undefined, walls).configuration.wall_loops).toBe(String(walls));
  expect(profile.configuration.wall_loops).toBe('2');
  for (const walls of [1, 7, 2.5])
    expect(() => profileForPreviewBed(profile, PREVIEW_PRINTERS[0], undefined, walls)).toThrow('Number of walls');
});

test('print time uses readable hours and minutes with minute rounding', () => {
  expect(formatPrintTime(0)).toBe('Under 1 min');
  expect(formatPrintTime(59)).toBe('Under 1 min');
  expect(formatPrintTime(90)).toBe('About 2 min');
  expect(formatPrintTime(3599)).toBe('About 1 hr');
  expect(formatPrintTime(4800)).toBe('About 1 hr 20 min');
  expect(formatPrintTime(7200)).toBe('About 2 hr');
  expect(formatPrintTime(NaN)).toBe('Unavailable');
});

test('each printer has an editable, identified profile; mismatched or unresolved settings fail closed', async () => {
  const ids = PREVIEW_PRINTERS.map((printer) => printer.id);
  expect(Object.keys(PREVIEW_PROFILE_FILES).sort()).toEqual([...ids].sort());
  for (const printer of PREVIEW_PRINTERS) {
    const file = new URL(
      '../public' + PREVIEW_PROFILE_FILES[printer.id],
      import.meta.url,
    );
    const value = await Bun.file(file).json();
    const profile = parsePreviewProfile(value, printer.id);
    expect(profile.configuration.nozzle_diameter).toEqual(['0.4']);
    expect(profile.configuration.printable_height).toBe(
      String(printer.buildVolume.z),
    );
    for (const invalid of [
      null,
      {},
      { ...value, schemaVersion: 2 },
      { ...value, printerId: 'another-printer' },
      {
        ...value,
        configuration: { ...value.configuration, inherits: 'missing-parent' },
      },
      {
        ...value,
        configuration: {
          ...value.configuration,
          nozzle_diameter: ['0.4', '0.4'],
        },
      },
      {
        ...value,
        configuration: { ...value.configuration, layer_height: 'bad' },
      },
      {
        ...value,
        configuration: { ...value.configuration, support_style: 'unqualified' },
      },
    ])
      expect(() => parsePreviewProfile(invalid, printer.id)).toThrow();
  }
});

test('incomplete timing profiles cannot inherit generic flow, speed, acceleration or cooling defaults', async () => {
  const file = new URL(
    '../public/preview-profiles/core-one.json',
    import.meta.url,
  );
  const profile = await Bun.file(file).json();
  for (const key of [
    'filament_max_volumetric_speed',
    'outer_wall_speed',
    'default_acceleration',
    'machine_max_speed_x',
    'slow_down_layer_time',
    'slow_down_for_layer_cooling',
  ]) {
    const configuration = { ...profile.configuration };
    delete configuration[key];
    expect(() =>
      parsePreviewProfile({ ...profile, configuration }, profile.printerId),
    ).toThrow(key);
  }
  for (const value of ['', [], ['nil'], ['NaN'], ['-1']]) {
    const configuration = {
      ...profile.configuration,
      filament_max_volumetric_speed: value,
    };
    expect(() =>
      parsePreviewProfile({ ...profile, configuration }, profile.printerId),
    ).toThrow('filament_max_volumetric_speed');
  }
  // An explicit zero is Orca's unlimited-flow setting, distinct from an omitted value.
  const configuration = {
    ...profile.configuration,
    filament_max_volumetric_speed: ['0'],
  };
  expect(
    parsePreviewProfile({ ...profile, configuration }, profile.printerId)
      .configuration.filament_max_volumetric_speed,
  ).toEqual(['0']);
});

test('the conservative allowance changes displayed time without invalidating raw slice caches', async () => {
  const value = await Bun.file(
    new URL('../public/preview-profiles/core-one.json', import.meta.url),
  ).json();
  const standard = parsePreviewProfile(value, value.printerId);
  const larger = parsePreviewProfile(
    { ...value, timeAllowancePercent: 50 },
    value.printerId,
  );
  expect(standard.timeAllowancePercent).toBe(30);
  expect(applyPrintTimeAllowance(44 * 60, 30)).toBeCloseTo(57.2 * 60);
  expect(formatPrintTime(applyPrintTimeAllowance(44 * 60, 30), true)).toBe(
    'About 58 min',
  );
  expect(applyPrintTimeAllowance(100, 0)).toBe(100);
  expect(profileForPreviewBed(standard, PREVIEW_PRINTERS[0])).toEqual(
    profileForPreviewBed(larger, PREVIEW_PRINTERS[0]),
  );
  expect(
    profileForPreviewBed(standard, PREVIEW_PRINTERS[0]).configuration
      .timeAllowancePercent,
  ).toBeUndefined();
  for (const timeAllowancePercent of [-1, 101, '30', NaN])
    expect(() =>
      parsePreviewProfile({ ...value, timeAllowancePercent }, value.printerId),
    ).toThrow('allowance');
});
