export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const INFILLS = [15, 20, 30, 50] as const;
export const COLORS = ['black', 'white', 'yellow', 'red'] as const;
export const LAYERS = [0.12, 0.16, 0.2, 0.28] as const;
export const SUPPORTS = ['operator', 'none', 'tree'] as const;
export const MAX_FEEDBACK_LENGTH = 5000;
export const STATUSES = ['queued', 'printing', 'completed', 'canceled', 'failed', 'rejected'] as const;
export type Status = typeof STATUSES[number];
export const transitions: Record<Status, Status[]> = {
  queued: ['printing', 'canceled', 'failed', 'rejected'],
  printing: ['completed', 'canceled', 'failed', 'rejected'],
  completed: ['queued'], canceled: ['queued'], failed: ['queued'], rejected: ['queued'],
};
export interface PrintSettings {
  infill: number; color: string; layer_height: number; supports: string; copies: number; mirror: number;
}
export interface PublicJob extends PrintSettings {
  id: string; title: string; status: Status; queued_at: number; confirmed_at: number; version: number;
}
export interface Job extends Omit<PublicJob, 'status'> {
  status: Status | 'pending_confirmation'; email: string; notes: string; original_filename: string;
  storage_key: string; file_size: number; upload_state: 'reserved' | 'uploading' | 'uploaded' | 'ready';
  pending_expires_at: number; upload_expires_at: number; created_at: number;
}
export const reference = (id: string) => id.slice(0, 8).toUpperCase();
export const supportLabel = (value: string) => value === 'operator' ? 'Operator decides' : value === 'tree' ? 'Tree' : 'None';
