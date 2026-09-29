export interface PrintSettings {
  infill: number;
  layerHeight: number;
  material: string;
  supports: string;
  color?: string;
}

export interface PrintJob {
  id: string;
  title: string;
  email: string;
  fileName: string;
  fileUrl?: string;
  fileSize: number;
  settingsDiff: Record<string, any>;
  settingsFull: PrintSettings;
  status: 'queued' | 'printing' | 'completed' | 'cancelled';
  notes?: string;
  created: string;
  updated: string;
}

export interface QueueResponse {
  currentlyPrinting: PrintJob[];
  nextInQueue: PrintJob[];
  completed: PrintJob[];
  all: PrintJob[];
  source: 'pocketbase' | 'local';
}

export const DEFAULT_SETTINGS: PrintSettings = {
  infill: 20,
  layerHeight: 0.20,
  material: 'PLA',
  supports: 'default',
  color: 'Any',
};

export function formatSettingDisplay(key: string, value: any): { label: string; value: string } {
  const normKey = key.toLowerCase();
  if (normKey === 'supports') {
    const valStr = String(value).toLowerCase();
    const formattedVal =
      valStr === 'default'
        ? 'Default (Operator Decides)'
        : valStr === 'none'
        ? 'None'
        : valStr === 'tree'
        ? 'Tree'
        : String(value);
    return { label: 'Supports', value: formattedVal };
  }
  return { label: key.charAt(0).toUpperCase() + key.slice(1), value: String(value) };
}

