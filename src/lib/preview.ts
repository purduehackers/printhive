import type { PreviewProfile } from '@time-estimator/browser-preview';
import { AVAILABLE_PRINTERS, type PrinterSpec } from './shared';

const coreOne = AVAILABLE_PRINTERS.find(
  (printer) => printer.id === 'prusa-core-one-plus',
)!;
// The H2D Pro's combined 350 mm width needs both nozzles. This preview slices one material/nozzle.
const h2d: PrinterSpec = {
  ...AVAILABLE_PRINTERS.find((printer) => printer.id === 'bambu-h2d')!,
  buildVolume: { x: 325, y: 320, z: 325 },
  buildVolumeFormatted: '325 × 320 × 325 mm',
};
export const PREVIEW_PRINTERS = [coreOne, h2d];

export const PREVIEW_PROFILE_FILES: Record<string, string> = {
  'prusa-core-one-plus': '/preview-profiles/core-one.json',
  'bambu-h2d': '/preview-profiles/h2d.json',
};

// Omitting these lets Orca silently use generic defaults, including a 2 mm³/s PLA flow cap.
const positiveTimingSettings = [
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
  'internal_solid_infill_speed',
  'top_surface_speed',
  'initial_layer_speed',
  'travel_speed',
  'support_speed',
  'support_interface_speed',
  'default_acceleration',
  'machine_max_acceleration_x',
  'machine_max_acceleration_y',
  'machine_max_speed_x',
  'machine_max_speed_y',
  'line_width',
];
const nonnegativeTimingSettings = [
  'filament_max_volumetric_speed',
  'slow_down_layer_time',
  'slow_down_min_speed',
];
function timingNumber(value: unknown): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === 'number' ||
    (typeof scalar === 'string' && scalar.trim() !== '')
    ? Number(scalar)
    : NaN;
}
function requireTimingSettings(config: PreviewProfile['configuration']) {
  for (const key of [...positiveTimingSettings, ...nonnegativeTimingSettings]) {
    const value = timingNumber(config[key]);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (value === 0 && positiveTimingSettings.includes(key))
    )
      throw new Error(`Complete printer timing settings required: ${key}`);
  }
  if (![0, 1].includes(timingNumber(config.slow_down_for_layer_cooling)))
    throw new Error(
      'Complete printer timing settings required: slow_down_for_layer_cooling',
    );
}

export interface PrinterPreviewProfile extends PreviewProfile {
  timeAllowancePercent: number;
}

/** Display policy only; the reusable slicer's raw result and support geometry stay unchanged. */
export function applyPrintTimeAllowance(
  seconds: number,
  percent: number,
): number {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100
  )
    return NaN;
  return seconds * (1 + percent / 100);
}

/** An effective configuration, not an unresolved desktop preset with parents. */
export function parsePreviewProfile(
  value: unknown,
  printerId: string,
): PrinterPreviewProfile {
  const profile = value as
    | (Partial<PrinterPreviewProfile> & {
        schemaVersion?: number;
        printerId?: string;
      })
    | null;
  const config = profile?.configuration;
  if (
    !profile ||
    profile.schemaVersion !== 1 ||
    profile.printerId !== printerId ||
    typeof profile.id !== 'string' ||
    !profile.id.trim() ||
    typeof profile.label !== 'string' ||
    !profile.label.trim() ||
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    'inherits' in config ||
    !Array.isArray(config.nozzle_diameter) ||
    config.nozzle_diameter.length !== 1 ||
    !Array.isArray(config.filament_diameter) ||
    config.filament_diameter.length !== 1 ||
    !Array.isArray(config.printable_area) ||
    config.printable_area.length !== 4 ||
    !Number.isFinite(Number(config.layer_height)) ||
    Number(config.layer_height) <= 0 ||
    !Number.isFinite(Number(config.printable_height)) ||
    Number(config.printable_height) <= 0 ||
    (config.support_style !== undefined && config.support_style !== 'default')
  )
    throw new Error(
      'Use a resolved, single-nozzle preview profile with the default support style.',
    );
  requireTimingSettings(config);
  const timeAllowancePercent = profile.timeAllowancePercent ?? 30;
  if (
    typeof timeAllowancePercent !== 'number' ||
    !Number.isFinite(timeAllowancePercent) ||
    timeAllowancePercent < 0 ||
    timeAllowancePercent > 100
  )
    throw new Error('Print-time allowance must be between 0 and 100 percent.');
  return {
    timeAllowancePercent,
    id: profile.id,
    label: profile.label,
    ...(typeof profile.basis === 'string' ? { basis: profile.basis } : {}),
    configuration: config,
  };
}

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

/** Apply physical bed limits and an optional per-part support threshold. */
export function profileForPreviewBed(
  profile: PreviewProfile,
  printer: PrinterSpec,
  supportAngle?: number,
): PreviewProfile {
  if (
    supportAngle !== undefined &&
    (!Number.isInteger(supportAngle) || supportAngle < 0 || supportAngle > 90)
  )
    throw new Error(
      'Support angle must be a whole number from 0 to 90 degrees.',
    );
  const { x, y, z } = printer.buildVolume;
  return {
    // Do not include display-only allowances in engine inputs or the expensive-result cache key.
    label: profile.label,
    ...(profile.basis === undefined ? {} : { basis: profile.basis }),
    id: `${profile.id}:bed:${printer.id}`,
    configuration: {
      ...profile.configuration,
      ...(supportAngle === undefined
        ? {}
        : { support_threshold_angle: String(supportAngle) }),
      printable_area: ['0x0', `${x}x0`, `${x}x${y}`, `0x${y}`],
      printable_height: String(z),
    },
  };
}

export function formatPrintTime(seconds: number, roundUp = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  if (seconds < 60) return 'Under 1 min';
  const minutes = roundUp ? Math.ceil(seconds / 60) : Math.round(seconds / 60),
    hours = Math.floor(minutes / 60),
    remainder = minutes % 60;
  if (!hours) return `About ${minutes} min`;
  return `About ${hours} hr${remainder ? ` ${remainder} min` : ''}`;
}
