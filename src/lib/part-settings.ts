import type { Material } from './shared';

export type ModelUnits = 'mm' | 'm' | 'in';
export interface SharedPartSettings {
  material: string;
  color: string;
  infill: number;
  walls: number;
  layerHeight: number;
  supports: string;
  supportAngle: string;
  units: ModelUnits;
  scalePercent: string;
}
export interface PartOptions {
  copies: number;
  mirror: boolean;
  overrides: Partial<SharedPartSettings>;
}
export const UNIT_SCALES = { mm: 1, m: 1000, in: 25.4 } as const;

export function getDefaultMaterial(materials: Material[]): Material {
  return materials.find((item) => item.is_default) ?? materials[0];
}

export function getDefaultColor(material: Material): string {
  return (
    material.colors.find((item) => item.is_default)?.name ??
    material.colors[0]?.name ??
    'black'
  );
}

export function defaultPartSettings(materials: Material[]): SharedPartSettings {
  const material = getDefaultMaterial(materials);
  return {
    material: material.name,
    color: getDefaultColor(material),
    infill: 15,
    walls: 2,
    layerHeight: 0.2,
    supports: 'operator',
    supportAngle: '',
    units: 'mm',
    scalePercent: '100',
  };
}

export function resolvePartSettings(
  global: SharedPartSettings,
  part: PartOptions | undefined,
  materials: Material[],
) {
  const settings = { ...global, ...part?.overrides };
  const material =
    materials.find(
      (item) => item.name.toLowerCase() === settings.material.toLowerCase(),
    ) ?? getDefaultMaterial(materials);
  const materialOverriddenWithoutColor =
    part?.overrides?.material !== undefined &&
    part.overrides.color === undefined &&
    part.overrides.material.toLowerCase() !== global.material.toLowerCase();
  const color = materialOverriddenWithoutColor
    ? undefined
    : material.colors.find(
        (item) => item.name.toLowerCase() === settings.color.toLowerCase(),
      );
  return {
    ...settings,
    material: material.name,
    color: color?.name ?? getDefaultColor(material),
    copies: part?.copies ?? 1,
    mirror: part?.mirror ?? false,
  };
}

/** A material override can make an inherited or explicit color unavailable. */
export function normalizePartOverrides(
  global: SharedPartSettings,
  overrides: Partial<SharedPartSettings>,
  materials: Material[],
) {
  const next = { ...overrides };
  const materialName = next.material ?? global.material;
  const material =
    materials.find(
      (item) => item.name.toLowerCase() === materialName.toLowerCase(),
    ) ?? getDefaultMaterial(materials);
  if (
    next.color &&
    !material.colors.some(
      (item) => item.name.toLowerCase() === next.color!.toLowerCase(),
    )
  )
    delete next.color;
  return next;
}

/** Units and user scaling form one uniform transform, shared by preview and STL export. */
export function partScale(settings: SharedPartSettings): number | null {
  const percent = Number(settings.scalePercent);
  if (
    !settings.scalePercent.trim() ||
    !Number.isFinite(percent) ||
    percent < 0.01 ||
    percent > 10000
  )
    return null;
  return (UNIT_SCALES[settings.units] * percent) / 100;
}

/** Blank inherits the printer profile; Orca's typed default is 30 degrees.
 * Zero intentionally retains Orca's automatic/overlap behavior.
 */
export function partSupportAngle(
  settings: SharedPartSettings,
): number | undefined | null {
  if (!settings.supportAngle?.trim()) return undefined;
  const angle = Number(settings.supportAngle);
  return Number.isInteger(angle) && angle >= 0 && angle <= 90 ? angle : null;
}
