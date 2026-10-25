import type { PreviewProfile } from '@time-estimator/browser-preview';
import { AVAILABLE_PRINTERS, type PrinterSpec } from './shared';

const coreOne = AVAILABLE_PRINTERS.find(
  (printer) => printer.id === 'prusa-core-one-plus',
)!;
// The H2D's combined 350 mm width needs both nozzles. This preview slices one material/nozzle.
const h2d: PrinterSpec = {
  ...AVAILABLE_PRINTERS.find((printer) => printer.id === 'bambu-h2d')!,
  buildVolume: { x: 325, y: 320, z: 325 },
  buildVolumeFormatted: '325 × 320 × 325 mm',
};
export const PREVIEW_PRINTERS = [coreOne, h2d];

export function fitsPreviewPrinter(
  dimensions: number[],
  printer: PrinterSpec,
): boolean {
  const limits = [
    printer.buildVolume.x,
    printer.buildVolume.y,
    printer.buildVolume.z,
  ];
  return (
    dimensions.length === 3 &&
    dimensions.every(
      (value, axis) =>
        Number.isFinite(value) && value >= 0 && value <= limits[axis] + 1e-5,
    )
  );
}

export function selectPreviewPrinter(dimensions: number[]): PrinterSpec {
  return fitsPreviewPrinter(dimensions, coreOne) ? coreOne : h2d;
}

/** Change physical bed limits only; speed/material settings remain operator-owned. */
export function profileForPreviewBed(
  profile: PreviewProfile,
  printer: PrinterSpec,
): PreviewProfile {
  const { x, y, z } = printer.buildVolume;
  return {
    ...profile,
    id: `${profile.id}:bed:${printer.id}`,
    configuration: {
      ...profile.configuration,
      printable_area: ['0x0', `${x}x0`, `${x}x${y}`, `0x${y}`],
      printable_height: String(z),
    },
  };
}

export function formatPrintTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  if (seconds < 60) return 'Under 1 min';
  const minutes = Math.round(seconds / 60),
    hours = Math.floor(minutes / 60),
    remainder = minutes % 60;
  if (!hours) return `About ${minutes} min`;
  return `About ${hours} hr${remainder ? ` ${remainder} min` : ''}`;
}
