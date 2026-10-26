import {
  INFILLS,
  LAYERS,
  SUPPORTS,
  supportLabel,
  resolveColor,
  type Material,
} from '../lib/shared';
import {
  resolvePartSettings,
  type SharedPartSettings,
} from '../lib/part-settings';

interface Props {
  global: SharedPartSettings;
  overrides?: Partial<SharedPartSettings>;
  materials: Material[];
  onChange: (change: Partial<SharedPartSettings>) => void;
}

export default function PartSettingsFields({
  global,
  overrides,
  materials,
  onChange,
}: Props) {
  const local = overrides !== undefined;
  const values = resolvePartSettings(
    global,
    local ? { copies: 1, mirror: false, overrides } : undefined,
    materials,
  );
  const inherited = resolvePartSettings(
    global,
    local
      ? {
          copies: 1,
          mirror: false,
          overrides: { ...overrides, color: global.color },
        }
      : undefined,
    materials,
  );
  const material = materials.find((item) => item.name === values.material)!;
  const accessible = (label: string) =>
    local ? label : `Default ${label.toLowerCase()}`;
  const change = <K extends keyof SharedPartSettings>(
    key: K,
    value: SharedPartSettings[K] | undefined,
  ) => onChange({ [key]: value } as Partial<SharedPartSettings>);

  function select(
    key: Exclude<keyof SharedPartSettings, 'scalePercent' | 'supportAngle'>,
    label: string,
    options: Array<[string | number, string]>,
    inheritedLabel?: string,
  ) {
    const inheritedValue =
      inheritedLabel ??
      options.find(([value]) => String(value) === String(global[key]))?.[1] ??
      String(global[key]);
    return (
      <label>
        {label}
        <select
          aria-label={accessible(label)}
          value={local ? (overrides[key] ?? '') : values[key]}
          onChange={(event) =>
            change(
              key,
              event.target.value === ''
                ? undefined
                : typeof global[key] === 'number'
                  ? Number(event.target.value)
                  : (event.target.value as SharedPartSettings[typeof key]),
            )
          }
        >
          {local && <option value="">Use default ({inheritedValue})</option>}
          {options.map(([value, title]) => (
            <option key={value} value={value}>
              {title}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="field-grid part-settings-grid">
      {select(
        'material',
        'Material',
        materials.map((item) => [item.name, item.name]),
      )}
      <div className="part-color-field">
        {select(
          'color',
          'Filament color',
          material.colors.map((item) => [item.name, item.name]),
          inherited.color,
        )}
        <i
          className="swatch"
          aria-hidden="true"
          style={{
            backgroundColor: resolveColor(
              values.color,
              material.colors.find((item) => item.name === values.color)?.code,
            ),
          }}
        />
      </div>
      {select(
        'infill',
        'Infill',
        INFILLS.map((value) => [value, `${value}%`]),
      )}
      {select(
        'layerHeight',
        'Layer height',
        LAYERS.map((value) => [value, `${value} mm`]),
      )}
      {select(
        'supports',
        'Supports',
        SUPPORTS.map((value) => [value, supportLabel(value)]),
      )}
      {local && (
        <label>
          Support overhang angle
          <span className="percent-input">
            <input
              aria-label="Support overhang angle (°)"
              type="number"
              min="0"
              max="90"
              step="1"
              placeholder="Default"
              value={overrides.supportAngle ?? ''}
              onChange={(event) =>
                change('supportAngle', event.target.value || undefined)
              }
            />
            <span aria-hidden="true">°</span>
          </span>
          <span className="setting-inheritance">
            Higher angles add more support. Blank uses printer default.
          </span>
        </label>
      )}
      {select('units', 'Model units', [
        ['mm', 'Millimeters (mm)'],
        ['m', 'Meters (m)'],
        ['in', 'Inches (in)'],
      ])}
      <label>
        Scale
        <span className="percent-input">
          <input
            aria-label={accessible('Scale (%)')}
            type="number"
            min="0.01"
            max="10000"
            step="any"
            required={!local}
            placeholder={global.scalePercent}
            value={local ? (overrides.scalePercent ?? '') : global.scalePercent}
            onChange={(event) =>
              change(
                'scalePercent',
                local && !event.target.value ? undefined : event.target.value,
              )
            }
          />
          <span aria-hidden="true">%</span>
        </span>
        {local && (
          <span className="setting-inheritance">
            Blank uses default ({global.scalePercent}%)
          </span>
        )}
      </label>
    </div>
  );
}
