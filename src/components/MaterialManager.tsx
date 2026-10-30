import { useState, type SubmitEvent } from 'react';
import { resolveColor, type Material, type MaterialColor } from '../lib/shared';

export default function MaterialManager({ initial }: { initial: Material[] }) {
  const [materials, setMaterials] = useState<Material[]>(initial);
  const [newMaterialName, setNewMaterialName] = useState('');
  const [initialColorName, setInitialColorName] = useState('black');
  const [initialColorCode, setInitialColorCode] = useState('#353832');
  const [colorInputs, setColorInputs] = useState<Record<number, { name: string; code: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  async function request(path: string, method: string, body?: unknown) {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      location.assign('/operator/login');
      throw new Error('Please sign in again.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Request failed.');
    return result;
  }

  async function handleAddMaterial(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const trimmedName = newMaterialName.trim();
      const trimmedColor = initialColorName.trim() || 'black';
      const result = await request('/api/materials', 'POST', {
        name: trimmedName,
        colors: [{ name: trimmedColor, code: initialColorCode }],
      });
      setMaterials(curr => [...curr, result.material].sort((a, b) => a.id - b.id));
      setNewMaterialName('');
      setInitialColorName('black');
      setInitialColorCode('#353832');
      setError(false);
      setMessage(`Material “${result.material.name}” added.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not add material.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMaterial(mat: Material) {
    if (!window.confirm(`Remove material “${mat.name}” and all its colours?`)) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/api/materials/${mat.id}`, 'DELETE');
      setMaterials(curr => result.materials ?? curr.filter(m => m.id !== mat.id));
      setError(false);
      setMessage(`Material “${mat.name}” removed.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not remove material.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefaultMaterial(mat: Material) {
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/api/materials/${mat.id}/default`, 'POST');
      setMaterials(result.materials);
      setError(false);
      setMessage(`“${mat.name}” set as the default material.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not set default material.');
    } finally {
      setBusy(false);
    }
  }

  function handleColorInputChange(materialId: number, field: 'name' | 'code', val: string) {
    setColorInputs(curr => {
      const prev = curr[materialId] ?? { name: '', code: '#2563eb' };
      const next = { ...prev, [field]: val };
      if (field === 'name' && !curr[materialId]?.code) {
        next.code = resolveColor(val);
      }
      return { ...curr, [materialId]: next };
    });
  }

  async function handleAddColor(materialId: number) {
    const input = colorInputs[materialId];
    if (!input || !input.name.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/api/materials/${materialId}/colors`, 'POST', {
        name: input.name.trim(),
        code: input.code,
      });
      setMaterials(curr =>
        curr.map(m => (m.id === materialId ? { ...m, colors: [...m.colors, result.color] } : m)),
      );
      setColorInputs(curr => ({ ...curr, [materialId]: { name: '', code: '#2563eb' } }));
      setError(false);
      setMessage(`Colour “${result.color.name}” added.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not add colour.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveColor(materialId: number, color: MaterialColor) {
    if (!window.confirm(`Remove colour “${color.name}”?`)) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/api/materials/${materialId}/colors/${color.id}`, 'DELETE');
      setMaterials(curr =>
        result.materials ??
        curr.map(m =>
          m.id === materialId ? { ...m, colors: m.colors.filter(c => c.id !== color.id) } : m,
        ),
      );
      setError(false);
      setMessage(`Colour “${color.name}” removed.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not remove colour.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefaultColor(mat: Material, color: MaterialColor) {
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/api/materials/${mat.id}/colors/${color.id}/default`, 'POST');
      setMaterials(result.materials);
      setError(false);
      setMessage(`“${color.name}” set as the default colour for ${mat.name}.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Could not set default colour.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message && (
        <p className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      <div className="operator-management">
        <section aria-label="Available materials and colours">
          {materials.map(mat => {
            const input = colorInputs[mat.id] ?? { name: '', code: '#2563eb' };
            return (
              <article key={mat.id} className="material-card">
                <div className="material-card-top">
                  <div className="material-card-title">
                    <h3>{mat.name}</h3>
                    {mat.is_default && (
                      <span className="default-filament-badge">Default material</span>
                    )}
                  </div>
                  <div className="material-card-actions">
                    {!mat.is_default && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        aria-label={`Set ${mat.name} as default material`}
                        onClick={() => handleSetDefaultMaterial(mat)}
                      >
                        Set as default
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button remove-operator"
                      disabled={busy || materials.length === 1}
                      title={
                        materials.length === 1
                          ? 'At least one material must remain.'
                          : `Remove material ${mat.name}`
                      }
                      onClick={() => handleRemoveMaterial(mat)}
                    >
                      Remove material
                    </button>
                  </div>
                </div>

                <div className="color-badge-list" aria-label={`Colours for ${mat.name}`}>
                  {mat.colors.map(col => (
                    <span
                      key={col.id ?? col.name}
                      className={`color-badge ${col.is_default ? 'is-default' : ''}`}
                    >
                      <i
                        className={`swatch ${col.name.toLowerCase()}`}
                        style={{ backgroundColor: resolveColor(col.name, col.code) }}
                      />
                      <span>{col.name}</span>
                      {col.is_default ? (
                        <span
                          className="color-default-tag"
                          aria-label={`Default colour for ${mat.name}`}
                        >
                          Default
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="set-default-color"
                          disabled={busy}
                          title={`Set ${col.name} as default colour for ${mat.name}`}
                          aria-label={`Set ${col.name} as default colour for ${mat.name}`}
                          onClick={() => handleSetDefaultColor(mat, col)}
                        >
                          Set default
                        </button>
                      )}
                      <button
                        type="button"
                        className="remove-color"
                        disabled={busy || mat.colors.length === 1}
                        title={
                          mat.colors.length === 1
                            ? 'Each material must have at least one colour.'
                            : `Remove colour ${col.name}`
                        }
                        aria-label={`Remove colour ${col.name} from ${mat.name}`}
                        onClick={() => handleRemoveColor(mat.id, col)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>

                <form
                  className="add-color-form"
                  onSubmit={e => {
                    e.preventDefault();
                    handleAddColor(mat.id);
                  }}
                >
                  <label htmlFor={`color-name-${mat.id}`} className="sr-only">
                    Colour name for {mat.name}
                  </label>
                  <input
                    id={`color-name-${mat.id}`}
                    type="text"
                    placeholder="New colour (e.g. Blue)"
                    maxLength={50}
                    value={input.name}
                    onChange={e => handleColorInputChange(mat.id, 'name', e.target.value)}
                    disabled={busy}
                    required
                  />
                  <label htmlFor={`color-picker-${mat.id}`} className="sr-only">
                    Colour swatch for {mat.name}
                  </label>
                  <input
                    id={`color-picker-${mat.id}`}
                    type="color"
                    value={input.code}
                    onChange={e => handleColorInputChange(mat.id, 'code', e.target.value)}
                    disabled={busy}
                    title="Select colour shade"
                  />
                  <button type="submit" className="button secondary" disabled={busy || !input.name.trim()}>
                    Add colour
                  </button>
                </form>
              </article>
            );
          })}
        </section>

        <section className="detail-card operator-editor" aria-label="Add new material">
          <h2>Add material type</h2>
          <form onSubmit={handleAddMaterial}>
            <fieldset disabled={busy}>
              <label>
                Material name
                <input
                  name="material_name"
                  value={newMaterialName}
                  onChange={e => setNewMaterialName(e.target.value)}
                  required
                  maxLength={50}
                  placeholder="e.g. PETG, ABS, TPU"
                  autoComplete="off"
                />
              </label>
              <label>
                Initial colour name
                <input
                  name="color_name"
                  value={initialColorName}
                  onChange={e => {
                    const val = e.target.value;
                    setInitialColorName(val);
                    setInitialColorCode(resolveColor(val));
                  }}
                  required
                  maxLength={50}
                  placeholder="e.g. Black, White, Orange"
                  autoComplete="off"
                />
              </label>
              <label>
                Initial colour shade
                <div className="color-picker-row">
                  <input
                    type="color"
                    value={initialColorCode}
                    onChange={e => setInitialColorCode(e.target.value)}
                  />
                  <span className="mono small">{initialColorCode}</span>
                </div>
              </label>
              <p className="small muted">
                Additional colours can be specified after creating the material.
              </p>
              <div className="operator-actions">
                <button type="submit" className="button primary">
                  {busy ? 'Saving…' : 'Add material'}
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      </div>
    </>
  );
}
