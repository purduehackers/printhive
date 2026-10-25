import { db } from './db';
import { invariant } from './errors';
import { resolveColor, type Material, type MaterialColor } from '../shared';

function sanitizeName(value: unknown, fieldName: string): string {
  invariant(typeof value === 'string', 400, `Invalid ${fieldName}.`);
  const trimmed = value.trim();
  invariant(trimmed.length >= 1 && trimmed.length <= 50, 400, `${fieldName} must be between 1 and 50 characters.`);
  invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed), 400, `Invalid characters in ${fieldName.toLowerCase()}.`);
  return trimmed;
}

function sanitizeCode(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim();
    invariant(trimmed.length <= 50, 400, 'Color code must be at most 50 characters.');
    invariant(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed), 400, 'Invalid color code.');
    return trimmed;
  }
  return resolveColor(name);
}

export async function listMaterialsWithColors(): Promise<Material[]> {
  const sql = await db();
  const materials: { id: number; name: string; created_at: number }[] = await sql`
    SELECT id, name, created_at FROM materials ORDER BY id ASC`;
  const colors: { id: number; material_id: number; name: string; code: string; created_at: number }[] = await sql`
    SELECT id, material_id, name, code, created_at FROM material_colors ORDER BY id ASC`;

  const colorMap = new Map<number, MaterialColor[]>();
  for (const c of colors) {
    const list = colorMap.get(c.material_id) ?? [];
    list.push(c);
    colorMap.set(c.material_id, list);
  }

  return materials.map(m => ({
    ...m,
    colors: colorMap.get(m.id) ?? [],
  }));
}

export async function addMaterial(
  _operatorId: number,
  input: unknown,
): Promise<Material> {
  invariant(input && typeof input === 'object', 400, 'Invalid material input.');
  const body = input as Record<string, unknown>;
  const name = sanitizeName(body.name, 'Material name');

  const sql = await db();
  const existing = await sql`SELECT id FROM materials WHERE LOWER(name) = LOWER(${name})`;
  invariant(!existing.length, 409, 'A material with this name already exists.');

  const now = Date.now();
  const [created]: { id: number; name: string; created_at: number }[] = await sql`
    INSERT INTO materials (name, created_at) VALUES (${name}, ${now}) RETURNING id, name, created_at`;

  // If initial colors are provided
  const initialColors: MaterialColor[] = [];
  if (Array.isArray(body.colors) && body.colors.length > 0) {
    for (const item of body.colors) {
      const colorName = typeof item === 'string' ? sanitizeName(item, 'Colour name') : sanitizeName(item?.name, 'Colour name');
      const colorCode = typeof item === 'object' && item !== null ? sanitizeCode(item.code, colorName) : resolveColor(colorName);
      const [col]: MaterialColor[] = await sql`
        INSERT INTO material_colors (material_id, name, code, created_at)
        VALUES (${created.id}, ${colorName}, ${colorCode}, ${Date.now()})
        RETURNING id, material_id, name, code, created_at`;
      initialColors.push(col);
    }
  } else {
    // Default to at least one colour: black
    const defaultName = 'black';
    const defaultCode = resolveColor(defaultName);
    const [col]: MaterialColor[] = await sql`
      INSERT INTO material_colors (material_id, name, code, created_at)
      VALUES (${created.id}, ${defaultName}, ${defaultCode}, ${now})
      RETURNING id, material_id, name, code, created_at`;
    initialColors.push(col);
  }

  return { ...created, colors: initialColors };
}

export async function removeMaterial(_operatorId: number, id: number): Promise<void> {
  invariant(Number.isSafeInteger(id) && id > 0, 400, 'Invalid material ID.');
  const sql = await db();
  const [{ count }] = await sql`SELECT COUNT(*) as count FROM materials`;
  invariant(Number(count) > 1, 400, 'At least one material must remain.');

  const existing = await sql`SELECT id FROM materials WHERE id = ${id}`;
  invariant(existing.length > 0, 404, 'Material not found.');

  await sql`DELETE FROM materials WHERE id = ${id}`;
}

export async function addColor(
  _operatorId: number,
  materialId: number,
  input: unknown,
): Promise<MaterialColor> {
  invariant(Number.isSafeInteger(materialId) && materialId > 0, 400, 'Invalid material ID.');
  invariant(input && typeof input === 'object', 400, 'Invalid colour input.');
  const body = input as Record<string, unknown>;
  const name = sanitizeName(body.name, 'Colour name');
  const code = sanitizeCode(body.code, name);

  const sql = await db();
  const material = await sql`SELECT id FROM materials WHERE id = ${materialId}`;
  invariant(material.length > 0, 404, 'Material not found.');

  const existing = await sql`
    SELECT id FROM material_colors WHERE material_id = ${materialId} AND LOWER(name) = LOWER(${name})`;
  invariant(!existing.length, 409, 'That colour is already available for this material.');

  const [created]: MaterialColor[] = await sql`
    INSERT INTO material_colors (material_id, name, code, created_at)
    VALUES (${materialId}, ${name}, ${code}, ${Date.now()})
    RETURNING id, material_id, name, code, created_at`;

  return created;
}

export async function removeColor(
  _operatorId: number,
  materialId: number,
  colorId: number,
): Promise<void> {
  invariant(Number.isSafeInteger(materialId) && materialId > 0, 400, 'Invalid material ID.');
  invariant(Number.isSafeInteger(colorId) && colorId > 0, 400, 'Invalid colour ID.');

  const sql = await db();
  const material = await sql`SELECT id FROM materials WHERE id = ${materialId}`;
  invariant(material.length > 0, 404, 'Material not found.');

  const [{ count }] = await sql`
    SELECT COUNT(*) as count FROM material_colors WHERE material_id = ${materialId}`;
  invariant(Number(count) > 1, 400, 'Each material must have at least one colour.');

  const existing = await sql`
    SELECT id FROM material_colors WHERE id = ${colorId} AND material_id = ${materialId}`;
  invariant(existing.length > 0, 404, 'Colour not found.');

  await sql`DELETE FROM material_colors WHERE id = ${colorId} AND material_id = ${materialId}`;
}
