import { COLORS, INFILLS, LAYERS, MAX_BATCH_SIZE, MAX_FILE_BYTES, SUPPORTS } from '../shared';
import { invariant } from './errors';

export interface AllowedMaterial {
  name: string;
  is_default?: boolean;
  colors: string[];
  defaultColor?: string;
}

export function metadata(input: unknown, allowedMaterials?: AllowedMaterial[]) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid submission.');
  const d = input as Record<string, unknown>;
  const string = (key: string, max: number, optional = false) => {
    const value = d[key] ?? (optional ? '' : undefined);
    invariant(typeof value === 'string' && value.trim().length <= max && (optional || value.trim().length > 0), 400, `Invalid ${key.replaceAll('_', ' ')} (maximum ${max} characters).`);
    invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 400, `Invalid ${key}.`);
    return value.trim();
  };
  const choice = <T>(key: string, values: readonly T[], fallback: T): T => {
    const value = d[key] ?? fallback;
    invariant(values.includes(value as T), 400, `Invalid ${key.replaceAll('_', ' ')}.`);
    return value as T;
  };
  const email = string('email', 254).toLowerCase();
  invariant(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@purdue\.edu$/.test(email) && !email.startsWith('.') && !email.includes('..') && !email.includes('.@'), 400, 'Use your @purdue.edu email address.');
  const filename = string('original_filename', 255);
  invariant(/\.stl$/i.test(filename) && !/[\/\\\r\n]/.test(filename), 400, 'Choose an STL file.');
  invariant(Number.isSafeInteger(d.file_size) && Number(d.file_size) > 0 && Number(d.file_size) <= MAX_FILE_BYTES, 400, 'The STL must be between 1 byte and 500 MiB.');
  const title = string('title', 200);
  invariant(!/[\r\n]/.test(title), 400, 'Title must be a single line.');

  const allowed: AllowedMaterial[] = allowedMaterials?.length ? allowedMaterials : [{ name: 'PLA', is_default: true, colors: [...COLORS], defaultColor: COLORS[0] }];
  const defaultMat = allowed.find(m => m.is_default) ?? allowed[0];
  let material: string;
  let matchedMat = defaultMat;
  if (d.material !== undefined && d.material !== null && d.material !== '') {
    const matStr = string('material', 50);
    const found = allowed.find(m => m.name.toLowerCase() === matStr.toLowerCase());
    invariant(found, 400, 'Invalid material.');
    matchedMat = found;
    material = found.name;
  } else {
    material = defaultMat.name;
  }

  let color: string;
  if (d.color !== undefined && d.color !== null && d.color !== '') {
    const colorStr = string('color', 50);
    const foundColor = matchedMat.colors.find(c => c.toLowerCase() === colorStr.toLowerCase());
    invariant(foundColor, 400, 'Invalid color.');
    color = foundColor;
  } else {
    color = matchedMat.defaultColor ?? matchedMat.colors[0] ?? 'black';
  }

  const supportAngle = d.support_angle ?? null;
  invariant(supportAngle === null || (Number.isInteger(supportAngle) && Number(supportAngle) >= 0 && Number(supportAngle) <= 90),
    400, 'Support angle must be a whole number from 0 to 90 degrees.');
  return {
    support_angle: supportAngle as number | null,
    title, email, notes: string('notes', 5000, true), original_filename: filename,
    file_size: Number(d.file_size), infill: choice('infill', INFILLS, 15),
    material, color,
    layer_height: choice('layer_height', LAYERS, 0.2), supports: choice('supports', SUPPORTS, 'operator'),
    copies: choice('copies', [1, 2, 3, 4, 5], 1), mirror: choice('mirror', [0, 1], 0),
  };
}

export function batchMetadata(input: unknown, allowedMaterials?: AllowedMaterial[]) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 400, 'Invalid batch submission.');
  const d = input as Record<string, unknown>;
  invariant(Array.isArray(d.items) && d.items.length >= 1 && d.items.length <= MAX_BATCH_SIZE, 400, `Choose between 1 and ${MAX_BATCH_SIZE} STL files.`);
  const baseTitle = typeof d.title === 'string' ? d.title.trim() : '';
  return d.items.map((rawItem, index) => {
    invariant(rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem), 400, 'Invalid item in batch.');
    const item = rawItem as Record<string, unknown>;
    const filename = typeof item.original_filename === 'string' ? item.original_filename.trim() : '';
    const stem = filename.replace(/\.stl$/i, '').trim() || `Part ${index + 1}`;
    let itemTitle = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '';
    if (!itemTitle) {
      if (d.items && (d.items as unknown[]).length === 1 && baseTitle) {
        itemTitle = baseTitle.slice(0, 200);
      } else if (baseTitle) {
        const suffix = ` · ${stem}`;
        itemTitle = (baseTitle.slice(0, Math.max(1, 200 - suffix.length)) + suffix).slice(0, 200);
      } else {
        itemTitle = stem.slice(0, 200);
      }
    }
    return metadata({
      ...d,
      title: itemTitle,
      original_filename: item.original_filename,
      file_size: item.file_size,
      notes: item.notes ?? d.notes,
      infill: item.infill ?? d.infill,
      material: item.material ?? d.material,
      color: item.color ?? d.color,
      layer_height: item.layer_height ?? d.layer_height,
      supports: item.supports ?? d.supports,
      support_angle: item.support_angle === undefined ? d.support_angle : item.support_angle,
      copies: item.copies ?? d.copies,
      mirror: item.mirror ?? d.mirror,
    }, allowedMaterials);
  });
}
