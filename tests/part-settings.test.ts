import { test, expect } from 'bun:test';
import {
  defaultPartSettings,
  resolvePartSettings,
  normalizePartOverrides,
  partScale,
  type PartOptions,
} from '../src/lib/part-settings';
import type { Material } from '../src/lib/shared';

const materials: Material[] = [
  {
    id: 1,
    name: 'PLA',
    colors: [
      { id: 1, material_id: 1, name: 'black', code: '#000' },
      { id: 2, material_id: 1, name: 'red', code: '#f00' },
    ],
  },
  {
    id: 2,
    name: 'PETG',
    colors: [{ id: 3, material_id: 2, name: 'clear', code: '#fff' }],
  },
];

test('global updates reach existing and new parts without overwriting explicit per-field overrides', () => {
  const global = defaultPartSettings(materials);
  const part: PartOptions = {
    copies: 3,
    mirror: true,
    overrides: { infill: 30, scalePercent: '150' },
  };
  const changed = {
    ...global,
    color: 'red',
    layerHeight: 0.12,
    infill: 50,
    scalePercent: '200',
  };
  const inherited = resolvePartSettings(changed, undefined, materials);
  const custom = resolvePartSettings(changed, part, materials);
  expect(inherited.infill).toBe(50);
  expect(inherited.scalePercent).toBe('200');
  expect(custom.infill).toBe(30);
  expect(custom.scalePercent).toBe('150');
  expect(custom.layerHeight).toBe(0.12);
  expect(custom.color).toBe('red');
  expect(custom.copies).toBe(3);
  expect(custom.mirror).toBe(true);
  expect(
    resolvePartSettings(changed, { ...part, overrides: {} }, materials).infill,
  ).toBe(50);
});

test('material changes keep colors valid without discarding unrelated overrides', () => {
  const global = defaultPartSettings(materials);
  const overrides = { color: 'red', layerHeight: 0.12 };
  expect(
    normalizePartOverrides(
      { ...global, material: 'PETG' },
      overrides,
      materials,
    ),
  ).toEqual({ layerHeight: 0.12 });
  expect(
    resolvePartSettings({ ...global, material: 'PETG' }, undefined, materials)
      .color,
  ).toBe('clear');
  expect(
    normalizePartOverrides(
      { ...global, material: 'PETG' },
      { ...overrides, material: 'PLA' },
      materials,
    ).color,
  ).toBe('red');
});

test('percentage and model units produce a single validated preview/export multiplier', () => {
  const global = defaultPartSettings(materials);
  expect(partScale(global)).toBe(1);
  expect(partScale({ ...global, scalePercent: '150' })).toBe(1.5);
  expect(partScale({ ...global, units: 'm', scalePercent: '50' })).toBe(500);
  expect(partScale({ ...global, units: 'in', scalePercent: '200' })).toBe(50.8);
  for (const scalePercent of ['', '0', '-1', 'Infinity', 'abc', '10001'])
    expect(partScale({ ...global, scalePercent })).toBeNull();
});

test('defaultPartSettings and resolvePartSettings honor operator-configured default material and colour', () => {
  const configuredMaterials: Material[] = [
    {
      id: 1,
      name: 'PLA',
      is_default: false,
      colors: [
        { id: 1, material_id: 1, name: 'black', code: '#000', is_default: false },
        { id: 2, material_id: 1, name: 'red', code: '#f00', is_default: true },
      ],
    },
    {
      id: 2,
      name: 'PETG',
      is_default: true,
      colors: [
        { id: 3, material_id: 2, name: 'clear', code: '#fff', is_default: false },
        { id: 4, material_id: 2, name: 'orange', code: '#f80', is_default: true },
      ],
    },
  ];

  const defaults = defaultPartSettings(configuredMaterials);
  expect(defaults.material).toBe('PETG');
  expect(defaults.color).toBe('orange');

  // Overriding a part's material without overriding its colour uses that material's default colour
  const resolvedPart = resolvePartSettings(
    defaults,
    { copies: 1, mirror: false, overrides: { material: 'PLA' } },
    configuredMaterials,
  );
  expect(resolvedPart.material).toBe('PLA');
  expect(resolvedPart.color).toBe('red');
});
