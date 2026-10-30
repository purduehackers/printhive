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
  const materials: { id: number; name: string; is_default: number; created_at: number }[] = await sql`
    SELECT id, name, is_default, created_at FROM materials ORDER BY id ASC`;
  const colors: { id: number; material_id: number; name: string; code: string; is_default: number; created_at: number }[] = await sql`
    SELECT id, material_id, name, code, is_default, created_at FROM material_colors ORDER BY id ASC`;

  const colorMap = new Map<number, MaterialColor[]>();
  for (const c of colors) {
    const list = colorMap.get(c.material_id) ?? [];
    list.push({ ...c, is_default: Boolean(c.is_default) });
    colorMap.set(c.material_id, list);
  }

  const hasDefaultMaterial = materials.some(m => Boolean(m.is_default));
  return materials.map((m, idx) => {
    const matColors = colorMap.get(m.id) ?? [];
    const hasDefaultColor = matColors.some(c => c.is_default);
    const normalizedColors = !hasDefaultColor && matColors.length > 0
      ? matColors.map((c, cIdx) => ({ ...c, is_default: cIdx === 0 }))
      : matColors;
    return {
      ...m,
      is_default: hasDefaultMaterial ? Boolean(m.is_default) : idx === 0,
      colors: normalizedColors,
    };
  });
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

  const [{ count: defaultCount }] = await sql`SELECT COUNT(*) as count FROM materials WHERE is_default = 1`;
  const isDefault = body.is_default === true || Number(defaultCount) === 0 ? 1 : 0;
  if (isDefault) {
    await sql`UPDATE materials SET is_default = 0 WHERE is_default = 1`;
  }

  const now = Date.now();
  const [created]: { id: number; name: string; is_default: number; created_at: number }[] = await sql`
    INSERT INTO materials (name, is_default, created_at) VALUES (${name}, ${isDefault}, ${now}) RETURNING id, name, is_default, created_at`;

  // If initial colors are provided
  const initialColors: MaterialColor[] = [];
  if (Array.isArray(body.colors) && body.colors.length > 0) {
    const explicitDefaultIdx = body.colors.findIndex(
      (item: unknown) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).is_default === true,
    );
    const defaultIdx = explicitDefaultIdx >= 0 ? explicitDefaultIdx : 0;
    for (const [idx, item] of body.colors.entries()) {
      const colorName = typeof item === 'string' ? sanitizeName(item, 'Colour name') : sanitizeName(item?.name, 'Colour name');
      const colorCode = typeof item === 'object' && item !== null ? sanitizeCode(item.code, colorName) : resolveColor(colorName);
      const colorDefault = idx === defaultIdx ? 1 : 0;
      const [col]: { id: number; material_id: number; name: string; code: string; is_default: number; created_at: number }[] = await sql`
        INSERT INTO material_colors (material_id, name, code, is_default, created_at)
        VALUES (${created.id}, ${colorName}, ${colorCode}, ${colorDefault}, ${Date.now()})
        RETURNING id, material_id, name, code, is_default, created_at`;
      initialColors.push({ ...col, is_default: Boolean(col.is_default) });
    }
  } else {
    // Default to at least one colour: black
    const defaultName = 'black';
    const defaultCode = resolveColor(defaultName);
    const [col]: { id: number; material_id: number; name: string; code: string; is_default: number; created_at: number }[] = await sql`
      INSERT INTO material_colors (material_id, name, code, is_default, created_at)
      VALUES (${created.id}, ${defaultName}, ${defaultCode}, 1, ${now})
      RETURNING id, material_id, name, code, is_default, created_at`;
    initialColors.push({ ...col, is_default: Boolean(col.is_default) });
  }

  return { ...created, is_default: Boolean(created.is_default), colors: initialColors };
}

export async function removeMaterial(_operatorId: number, id: number): Promise<void> {
  invariant(Number.isSafeInteger(id) && id > 0, 400, 'Invalid material ID.');
  const sql = await db();
  const [{ count }] = await sql`SELECT COUNT(*) as count FROM materials`;
  invariant(Number(count) > 1, 400, 'At least one material must remain.');

  const existing: { id: number; is_default: number }[] = await sql`SELECT id, is_default FROM materials WHERE id = ${id}`;
  invariant(existing.length > 0, 404, 'Material not found.');

  await sql.begin(async tx => {
    await tx`DELETE FROM materials WHERE id = ${id}`;
    if (existing[0].is_default) {
      await tx`UPDATE materials SET is_default = 1 WHERE id = (SELECT id FROM materials ORDER BY id ASC LIMIT 1)`;
    }
  });
}

export async function setDefaultMaterial(_operatorId: number, id: number): Promise<Material[]> {
  invariant(Number.isSafeInteger(id) && id > 0, 400, 'Invalid material ID.');
  const sql = await db();
  const existing = await sql`SELECT id FROM materials WHERE id = ${id}`;
  invariant(existing.length > 0, 404, 'Material not found.');

  await sql.begin(async tx => {
    await tx`UPDATE materials SET is_default = 0 WHERE is_default = 1`;
    await tx`UPDATE materials SET is_default = 1 WHERE id = ${id}`;
  });

  return listMaterialsWithColors();
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

  const [{ count: defaultCount }] = await sql`
    SELECT COUNT(*) as count FROM material_colors WHERE material_id = ${materialId} AND is_default = 1`;
  const isDefault = body.is_default === true || Number(defaultCount) === 0 ? 1 : 0;
  if (isDefault) {
    await sql`UPDATE material_colors SET is_default = 0 WHERE material_id = ${materialId} AND is_default = 1`;
  }

  const [created]: { id: number; material_id: number; name: string; code: string; is_default: number; created_at: number }[] = await sql`
    INSERT INTO material_colors (material_id, name, code, is_default, created_at)
    VALUES (${materialId}, ${name}, ${code}, ${isDefault}, ${Date.now()})
    RETURNING id, material_id, name, code, is_default, created_at`;

  return { ...created, is_default: Boolean(created.is_default) };
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

  const existing: { id: number; is_default: number }[] = await sql`
    SELECT id, is_default FROM material_colors WHERE id = ${colorId} AND material_id = ${materialId}`;
  invariant(existing.length > 0, 404, 'Colour not found.');

  await sql.begin(async tx => {
    await tx`DELETE FROM material_colors WHERE id = ${colorId} AND material_id = ${materialId}`;
    if (existing[0].is_default) {
      await tx`
        UPDATE material_colors SET is_default = 1
        WHERE id = (SELECT id FROM material_colors WHERE material_id = ${materialId} ORDER BY id ASC LIMIT 1)`;
    }
  });
}

export async function setDefaultColor(
  _operatorId: number,
  materialId: number,
  colorId: number,
): Promise<Material[]> {
  invariant(Number.isSafeInteger(materialId) && materialId > 0, 400, 'Invalid material ID.');
  invariant(Number.isSafeInteger(colorId) && colorId > 0, 400, 'Invalid colour ID.');

  const sql = await db();
  const material = await sql`SELECT id FROM materials WHERE id = ${materialId}`;
  invariant(material.length > 0, 404, 'Material not found.');

  const existing = await sql`
    SELECT id FROM material_colors WHERE id = ${colorId} AND material_id = ${materialId}`;
  invariant(existing.length > 0, 404, 'Colour not found.');

  await sql.begin(async tx => {
    await tx`UPDATE material_colors SET is_default = 0 WHERE material_id = ${materialId} AND is_default = 1`;
    await tx`UPDATE material_colors SET is_default = 1 WHERE id = ${colorId} AND material_id = ${materialId}`;
  });

  return listMaterialsWithColors();
}
