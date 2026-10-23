import { COLORS, INFILLS, LAYERS, MAX_FILE_BYTES, SUPPORTS } from '../shared';
import { invariant } from './errors';

export function metadata(input: unknown, allowedMaterials?: { name: string; colors: string[] }[]) {
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

  const allowed = allowedMaterials?.length ? allowedMaterials : [{ name: 'PLA', colors: [...COLORS] }];
  let material: string;
  let matchedMat = allowed[0];
  if (d.material !== undefined && d.material !== null && d.material !== '') {
    const matStr = string('material', 50);
    const found = allowed.find(m => m.name.toLowerCase() === matStr.toLowerCase());
    invariant(found, 400, 'Invalid material.');
    matchedMat = found;
    material = found.name;
  } else {
    material = allowed[0].name;
  }

  let color: string;
  if (d.color !== undefined && d.color !== null && d.color !== '') {
    const colorStr = string('color', 50);
    const foundColor = matchedMat.colors.find(c => c.toLowerCase() === colorStr.toLowerCase());
    invariant(foundColor, 400, 'Invalid color.');
    color = foundColor;
  } else {
    color = matchedMat.colors[0] ?? 'black';
  }

  return {
    title, email, notes: string('notes', 5000, true), original_filename: filename,
    file_size: Number(d.file_size), infill: choice('infill', INFILLS, 15),
    material, color,
    layer_height: choice('layer_height', LAYERS, 0.2), supports: choice('supports', SUPPORTS, 'operator'),
    copies: choice('copies', [1, 2, 3, 4, 5], 1), mirror: choice('mirror', [0, 1], 0),
  };
}
