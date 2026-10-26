import { test, expect } from 'bun:test';
import { metadata, batchMetadata } from '../src/lib/server/validation';
import {
  defaultPartSettings,
  partSupportAngle,
} from '../src/lib/part-settings';
import { PREVIEW_PRINTERS, profileForPreviewBed } from '../src/lib/preview';
import { previewCacheKey } from '../src/lib/preview-cache';
import { submission } from './fixtures';

test('old requests omit angle, explicit angles validate, and null clears a batch default', () => {
  expect(metadata(submission()).support_angle).toBeNull();
  for (const value of [null, 0, 30, 90])
    expect(metadata(submission({ support_angle: value })).support_angle).toBe(
      value,
    );
  for (const value of [-1, 91, 12.5, '30', '', true, NaN])
    expect(() => metadata(submission({ support_angle: value }))).toThrow();
  const items = batchMetadata({
    ...submission(),
    support_angle: 45,
    items: [
      { original_filename: 'one.stl', file_size: 100 },
      { original_filename: 'two.stl', file_size: 100, support_angle: null },
      { original_filename: 'three.stl', file_size: 100, support_angle: 0 },
    ],
  });
  expect(items.map((item) => item.support_angle)).toEqual([45, null, 0]);
});

test('blank model angle preserves the printer profile and explicit angles invalidate cached supports', () => {
  const settings = defaultPartSettings([{ id: 1, name: 'PLA', colors: [] }]);
  expect(partSupportAngle(settings)).toBeUndefined();
  for (const value of ['0', '30', '90'])
    expect(partSupportAngle({ ...settings, supportAngle: value })).toBe(
      Number(value),
    );
  for (const value of ['-1', '91', '3.5', 'bad'])
    expect(partSupportAngle({ ...settings, supportAngle: value })).toBeNull();
  const source = {
    id: 'test',
    label: 'Test',
    configuration: { support_threshold_angle: '35' },
  };
  const printer = PREVIEW_PRINTERS[0];
  const inherited = profileForPreviewBed(source, printer);
  const custom = profileForPreviewBed(source, printer, 60);
  expect(inherited.configuration.support_threshold_angle).toBe('35');
  expect(custom.configuration.support_threshold_angle).toBe('60');
  expect(
    profileForPreviewBed(source, printer, 0).configuration
      .support_threshold_angle,
  ).toBe('0');
  expect(source.configuration.support_threshold_angle).toBe('35');
  expect(() => profileForPreviewBed(source, printer, 90.5)).toThrow();
  const options = {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    mirror: false,
    scale: 1,
    infill: 15,
    layerHeight: 0.2,
    supports: 'tree',
  };
  expect(previewCacheKey('engine', inherited, options)).not.toBe(
    previewCacheKey('engine', custom, options),
  );
});
