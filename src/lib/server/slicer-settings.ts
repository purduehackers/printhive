import type { PrintSettings } from '../shared';
import type { Slicer, SupportChoice } from '../slicer';

// Classifying every stored field makes additions to PrintSettings require an export decision.
export const EXPORT_SETTING_SCOPE = {
  infill: 'object', walls: 'object', layer_height: 'object', supports: 'object', support_angle: 'object',
  material: 'local-preset', color: 'local-preset', copies: 'instances', mirror: 'geometry',
} satisfies Record<keyof PrintSettings, 'object' | 'local-preset' | 'instances' | 'geometry'>;

export function objectSettings(settings: PrintSettings, supports: SupportChoice, slicer: Slicer): Record<string, string> {
  const prusa = slicer === 'prusa';
  return {
    [prusa ? 'fill_density' : 'sparse_infill_density']: `${settings.infill}%`,
    [prusa ? 'perimeters' : 'wall_loops']: String(settings.walls),
    layer_height: String(settings.layer_height),
    [prusa ? 'support_material' : 'enable_support']: supports === 'none' ? '0' : '1',
    ...(prusa ? {
      support_material_auto: '1',
      support_material_style: supports === 'tree' ? 'organic' : 'grid',
    } : {
      support_type: supports === 'tree' ? 'tree(auto)' : 'normal(auto)',
      // A printer's regular style (e.g. snug) is not a tree style.
      ...(supports === 'tree' ? { support_style: 'default' } : {}),
    }),
    ...(settings.support_angle == null ? {} : {
      [prusa ? 'support_material_threshold' : 'support_threshold_angle']: String(settings.support_angle),
    }),
  };
}
