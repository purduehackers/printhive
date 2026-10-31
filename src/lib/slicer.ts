export const SLICERS = [
  { id: 'orca', name: 'OrcaSlicer', scheme: 'orcaslicer' },
  { id: 'bambu', name: 'Bambu Studio', scheme: 'bambustudio' },
  { id: 'prusa', name: 'PrusaSlicer', scheme: 'prusaslicer' },
] as const;
export type Slicer = typeof SLICERS[number]['id'];
export type SupportChoice = 'none' | 'normal' | 'tree';
export const MAX_EXPORT_JOBS = 10;
export const EXPORT_TTL = 15 * 60 * 1000;

export interface SlicerExportRequest {
  ids: string[];
  slicer: Slicer;
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
