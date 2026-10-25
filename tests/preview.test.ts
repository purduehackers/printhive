import { test, expect } from 'bun:test';
import {
  PREVIEW_PRINTERS,
  fitsPreviewPrinter,
  selectPreviewPrinter,
  profileForPreviewBed,
  formatPrintTime,
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

test('print time uses readable hours and minutes with minute rounding', () => {
  expect(formatPrintTime(0)).toBe('Under 1 min');
  expect(formatPrintTime(59)).toBe('Under 1 min');
  expect(formatPrintTime(90)).toBe('About 2 min');
  expect(formatPrintTime(3599)).toBe('About 1 hr');
  expect(formatPrintTime(4800)).toBe('About 1 hr 20 min');
  expect(formatPrintTime(7200)).toBe('About 2 hr');
  expect(formatPrintTime(NaN)).toBe('Unavailable');
});
