export const SLICERS = [
  { id: 'orca', name: 'OrcaSlicer', scheme: 'orcaslicer' },
  { id: 'bambu', name: 'Bambu Studio', scheme: 'bambustudio' },
  { id: 'prusa', name: 'PrusaSlicer', scheme: 'prusaslicer' },
] as const;
export type Slicer = typeof SLICERS[number]['id'];
export const SLICER_PRINTERS = [
  { id: 'core-one', name: 'Prusa Core ONE+', bed: [250, 220, 270], slicers: ['orca', 'prusa'] },
  // Shared area reachable by either H2D Pro nozzle. The local preset selects the nozzle.
  { id: 'h2d', name: 'Bambu H2D Pro', bed: [325, 320, 325], slicers: ['orca', 'bambu'] },
] as const;
export type SlicerPrinter = typeof SLICER_PRINTERS[number]['id'];
export type SupportChoice = 'none' | 'normal' | 'tree';
export const MAX_EXPORT_JOBS = 10;
export const EXPORT_TTL = 15 * 60 * 1000;

export interface SlicerExportRequest {
  ids: string[];
  slicer: Slicer;
  printer: SlicerPrinter;
}
export interface SlicerExportResult {
  downloadUrl: string;
  launchUrl: string | null;
  expiresAt: number;
}

export function slicerLaunchUrl(slicer: Slicer, downloadUrl: string) {
  // Prusa's downloader only accepts approved domains; provide its native project download.
  if (slicer === 'prusa') return null;
  return `${SLICERS.find(item => item.id === slicer)!.scheme}://open?file=${encodeURIComponent(downloadUrl)}`;
}
