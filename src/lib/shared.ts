export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_BATCH_SIZE = 10;
export const INFILLS = [15, 20, 30, 50] as const;
export const COLORS = ['black', 'white', 'yellow', 'red'] as const;
export const LAYERS = [0.12, 0.16, 0.2, 0.28] as const;
export const SUPPORTS = ['operator', 'none', 'tree', 'normal'] as const;
export const MAX_FEEDBACK_LENGTH = 5000;
export const STATUSES = ['queued', 'printing', 'completed', 'canceled', 'failed', 'rejected'] as const;
export type Status = typeof STATUSES[number];
export const transitions: Record<Status, Status[]> = {
  queued: ['printing', 'canceled', 'failed', 'rejected'],
  printing: ['completed', 'canceled', 'failed', 'rejected'],
  completed: ['queued'], canceled: ['queued'], failed: ['queued'], rejected: ['queued'],
};
export interface PrintSettings {
  infill: number; material: string; color: string; layer_height: number; supports: string; support_angle?: number | null; copies: number; mirror: number;
}
export interface MaterialColor {
  id: number;
  material_id: number;
  name: string;
  code: string;
  is_default?: boolean;
  created_at?: number;
}
export interface Material {
  id: number;
  name: string;
  is_default?: boolean;
  created_at?: number;
  colors: MaterialColor[];
}
export const DEFAULT_COLOR_CODES: Record<string, string> = {
  black: '#414442',
  white: '#f5f1e7',
  yellow: '#efc84a',
  red: '#c9493b',
  blue: '#2563eb',
  green: '#16a34a',
  orange: '#ea580c',
  purple: '#9333ea',
  gray: '#6b7280',
  grey: '#6b7280',
  silver: '#9ca3af',
  gold: '#d97706',
  pink: '#db2777',
  cyan: '#06b6d4',
  brown: '#78350f',
  clear: '#e2e8f0',
};
export const SWATCH_COLOR_CODES: Record<string, string> = {
  black: '#353832',
  white: '#ffffff',
  yellow: '#edc54d',
  red: '#c9493b',
  blue: '#2563eb',
  green: '#22c55e',
  orange: '#f97316',
  purple: '#a855f7',
  gray: '#6b7280',
  grey: '#6b7280',
  silver: '#9ca3af',
  gold: '#eab308',
  pink: '#ec4899',
  cyan: '#06b6d4',
  brown: '#854d0e',
  clear: '#e2e8f0',
};
export function resolveColor(name: string, customCode?: string): string {
  if (customCode && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(customCode.trim())) return customCode.trim();
  const lower = (name || '').toLowerCase().trim();
  if (SWATCH_COLOR_CODES[lower]) return SWATCH_COLOR_CODES[lower];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(lower)) return lower;
  return '#686d60';
}
export function previewColor(name: string, customCode?: string): string {
  if (customCode && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(customCode.trim())) return customCode.trim();
  const lower = (name || '').toLowerCase().trim();
  if (DEFAULT_COLOR_CODES[lower]) return DEFAULT_COLOR_CODES[lower];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(lower)) return lower;
  return '#686d60';
}
export interface PublicJob extends PrintSettings {
  id: string; title: string; status: Status; queued_at: number; confirmed_at: number; version: number;
  batch_id?: string | null; batch_title?: string | null; group_name?: string | null;
}
export interface Job extends Omit<PublicJob, 'status'> {
  status: Status | 'pending_confirmation'; email: string; notes: string; original_filename: string;
  storage_key: string; file_size: number; upload_state: 'reserved' | 'uploading' | 'uploaded' | 'ready';
  pending_expires_at: number; upload_expires_at: number; created_at: number;
}
export const reference = (id: string) => id.slice(0, 8).toUpperCase();
export const supportLabel = (value: string) => value === 'operator' ? 'Operator decides' : value === 'tree' ? 'Tree' : value === 'normal' ? 'Regular' : 'None';

export function effectiveGroupName(job: Pick<PublicJob, 'group_name' | 'batch_title'>): string | null {
  if (typeof job.group_name === 'string' && job.group_name.trim()) return job.group_name.trim();
  if (job.group_name === null && job.batch_title !== undefined) return null;
  if (typeof job.batch_title === 'string' && job.batch_title.trim()) return job.batch_title.trim();
  return null;
}

export interface GroupStatusSummary {
  status: Status;
  label: string;
  mixed: boolean;
  counts: Partial<Record<Status, number>>;
  total: number;
}

const STATUS_PRIORITY: Record<Status, number> = {
  printing: 0,
  queued: 1,
  completed: 2,
  rejected: 3,
  failed: 4,
  canceled: 5,
};

export function summarizeGroupStatus(jobs: readonly { status: Status | 'pending_confirmation' }[]): GroupStatusSummary {
  const counts: Partial<Record<Status, number>> = {};
  for (const job of jobs) {
    const s = (job.status === 'pending_confirmation' ? 'queued' : job.status) as Status;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const present = (Object.keys(counts) as Status[]).sort((a, b) => (STATUS_PRIORITY[a] ?? 99) - (STATUS_PRIORITY[b] ?? 99));
  if (present.length === 0) {
    return { status: 'queued', label: 'queued', mixed: false, counts, total: 0 };
  }
  if (present.length === 1) {
    const status = present[0];
    return { status, label: status, mixed: false, counts, total: jobs.length };
  }
  const dominant = present[0];
  const label = present.map(s => `${counts[s]} ${s}`).join(' · ');
  return { status: dominant, label, mixed: true, counts, total: jobs.length };
}

export type SortOption = 'queue' | 'group' | 'status' | 'material-color' | 'submitter' | 'title' | 'newest';

export function sortJobs<T extends Omit<PublicJob, 'status'> & { status: Status | 'pending_confirmation'; email?: string; created_at?: number }>(
  jobs: readonly T[],
  sortBy: SortOption,
  getGroup: (job: T) => string | null = effectiveGroupName,
): T[] {
  const list = [...jobs];
  const compareQueueOrder = (a: T, b: T) => {
    const rank = (s: string) => s === 'printing' ? 0 : s === 'queued' ? 1 : 2;
    const ra = rank(a.status), rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    if (ra <= 1) {
      const qa = a.queued_at ?? a.confirmed_at ?? 0;
      const qb = b.queued_at ?? b.confirmed_at ?? 0;
      if (qa !== qb) return qa - qb;
    } else {
      const ca = a.created_at ?? a.confirmed_at ?? 0;
      const cb = b.created_at ?? b.confirmed_at ?? 0;
      if (ca !== cb) return cb - ca;
    }
    return a.id.localeCompare(b.id);
  };

  if (sortBy === 'queue') {
    return list.sort(compareQueueOrder);
  }
  if (sortBy === 'group') {
    return list.sort((a, b) => {
      const ga = getGroup(a), gb = getGroup(b);
      if (ga && !gb) return -1;
      if (!ga && gb) return 1;
      if (ga && gb && ga !== gb) return ga.localeCompare(gb);
      if (a.batch_id && b.batch_id && a.batch_id !== b.batch_id) return a.batch_id.localeCompare(b.batch_id);
      return compareQueueOrder(a, b);
    });
  }
  if (sortBy === 'status') {
    return list.sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status as Status] ?? 99;
      const pb = STATUS_PRIORITY[b.status as Status] ?? 99;
      if (pa !== pb) return pa - pb;
      return compareQueueOrder(a, b);
    });
  }
  if (sortBy === 'material-color') {
    return list.sort((a, b) => {
      const ma = `${a.material ?? 'PLA'} · ${a.color}`.toLowerCase();
      const mb = `${b.material ?? 'PLA'} · ${b.color}`.toLowerCase();
      if (ma !== mb) return ma.localeCompare(mb);
      return compareQueueOrder(a, b);
    });
  }
  if (sortBy === 'submitter') {
    return list.sort((a, b) => {
      const ea = (a.email ?? '').toLowerCase();
      const eb = (b.email ?? '').toLowerCase();
      if (ea !== eb) return ea.localeCompare(eb);
      return compareQueueOrder(a, b);
    });
  }
  if (sortBy === 'title') {
    return list.sort((a, b) => {
      const cmp = a.title.localeCompare(b.title);
      return cmp !== 0 ? cmp : compareQueueOrder(a, b);
    });
  }
  if (sortBy === 'newest') {
    return list.sort((a, b) => {
      const ca = a.created_at ?? a.confirmed_at ?? a.queued_at ?? 0;
      const cb = b.created_at ?? b.confirmed_at ?? b.queued_at ?? 0;
      if (ca !== cb) return cb - ca;
      return a.id.localeCompare(b.id);
    });
  }
  return list;
}

export interface PrinterSpec {
  id: string;
  name: string;
  manufacturer: string;
  buildVolume: { x: number; y: number; z: number };
  buildVolumeFormatted: string;
  technology: string;
  chamber: string;
  maxNozzleTemp: string;
  features: string[];
  description: string;
}

export const AVAILABLE_PRINTERS: PrinterSpec[] = [
  {
    id: 'bambu-h2d',
    name: 'Bambu H2D',
    manufacturer: 'Bambu Lab',
    buildVolume: { x: 350, y: 320, z: 325 },
    buildVolumeFormatted: '350 × 320 × 325 mm',
    technology: 'Dual-Nozzle CoreXY',
    chamber: 'Active heating (up to 65°C)',
    maxNozzleTemp: '350°C',
    features: [
      'Dual-nozzle multi-material extrusion',
      'Active chamber heating (65°C)',
      'High-temp nozzle (350°C)',
      'High-speed precision servo motion',
    ],
    description: 'Large-format dual-nozzle system ideal for multi-material prints and high-temperature engineering polymers without purge waste.',
  },
  {
    id: 'prusa-core-one-plus',
    name: 'Prusa Core ONE+',
    manufacturer: 'Prusa Research',
    buildVolume: { x: 250, y: 220, z: 270 },
    buildVolumeFormatted: '250 × 220 × 270 mm',
    technology: 'Fully Enclosed CoreXY',
    chamber: 'Active temperature regulation',
    maxNozzleTemp: '300°C',
    features: [
      'Fully enclosed active temperature regulation',
      'Nextruder with quick-swap nozzles',
      'High-speed CoreXY kinematics',
      'Exceptional precision & dimensional accuracy',
    ],
    description: 'Fully enclosed high-performance printer engineered for dimensional accuracy, crisp detail, and reliable printing across PLA, PETG, ABS, and ASA.',
  },
];

export function checkPrinterFit(dimensions: [number, number, number], printer: PrinterSpec): boolean {
  const modelSorted = [...dimensions].sort((a, b) => a - b);
  const bedSorted = [printer.buildVolume.x, printer.buildVolume.y, printer.buildVolume.z].sort((a, b) => a - b);
  return modelSorted[0] <= bedSorted[0] && modelSorted[1] <= bedSorted[1] && modelSorted[2] <= bedSorted[2];
}
