import { lazy, Suspense, useRef, useState, type SubmitEvent } from 'react';
import { INFILLS, LAYERS, MAX_FILE_BYTES, SUPPORTS, supportLabel, resolveColor, type Material } from '../lib/shared';
const Preview = lazy(() => import('./Preview'));

const DEFAULT_MATERIALS: Material[] = [
  {
    id: 1,
    name: 'PLA',
    colors: [
      { id: 1, material_id: 1, name: 'black', code: '#353832' },
      { id: 2, material_id: 1, name: 'white', code: '#ffffff' },
      { id: 3, material_id: 1, name: 'yellow', code: '#edc54d' },
      { id: 4, material_id: 1, name: 'red', code: '#c9493b' },
    ],
  },
];

export default function SubmissionForm({ initialMaterials }: { initialMaterials?: Material[] }) {
  const materials = initialMaterials && initialMaterials.length > 0 ? initialMaterials : DEFAULT_MATERIALS;
  const [file, setFile] = useState<File | null>(null);
  const [material, setMaterial] = useState(materials[0].name);
  const [color, setColor] = useState(materials[0].colors[0]?.name ?? 'black');
  const [mirror, setMirror] = useState(false);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [message, setMessage] = useState(''), [success, setSuccess] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null), controllerRef = useRef<AbortController | null>(null);
  const [email, setEmail] = useState('');

  const currentMat = materials.find(m => m.name.toLowerCase() === material.toLowerCase()) ?? materials[0];
  const availableColors = currentMat?.colors ?? [];

  function handleMaterialChange(nextName: string) {
    setMaterial(nextName);
    const nextMat = materials.find(m => m.name.toLowerCase() === nextName.toLowerCase());
    if (nextMat && !nextMat.colors.some(c => c.name.toLowerCase() === color.toLowerCase())) {
      setColor(nextMat.colors[0]?.name ?? 'black');
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || file.size > MAX_FILE_BYTES || file.size === 0) { setMessage('Choose an STL between 1 byte and 500 MiB.'); return; }
    const fields = new FormData(event.currentTarget);
    setBusy(true); setMessage(''); setProgress(0);
    const controller = new AbortController(); controllerRef.current = controller;
    try {
      const response = await fetch('/api/submissions', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: fields.get('title'), email: fields.get('email'), notes: fields.get('notes'), original_filename: file.name, file_size: file.size,
        infill: Number(fields.get('infill')), material, color, layer_height: Number(fields.get('layer_height')), supports: fields.get('supports'), copies: Number(fields.get('copies')), mirror: Number(mirror),
      }) });
      const reservation = await response.json();
      if (!response.ok) throw new Error(reservation.error);
      if (controller.signal.aborted) throw new Error('Upload canceled.');
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhrRef.current = xhr;
        xhr.open('PUT', `/api/submissions/${reservation.id}/file`);
        xhr.setRequestHeader('Authorization', `Bearer ${reservation.capability}`); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => {
          let result; try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('The server could not process the upload. Please try again.')); return; }
          if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error(result.error ?? 'Upload failed.'));
        };
        xhr.onerror = () => reject(new Error('Connection lost. Please try again.'));
        xhr.onabort = () => reject(new Error('Upload canceled.'));
        xhr.send(file);
      });
      setSuccess(true);
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Submission failed. Please try again.'); }
    finally { setBusy(false); xhrRef.current = null; controllerRef.current = null; }
  }
  if (success) return <section className="receipt"><h2>Check your email</h2><p>We sent a confirmation link to <strong>{email}</strong>.</p><p>Open it and press <strong>Confirm print</strong> within 24 hours. Your print will join the queue after you confirm.</p><p className="small muted">If it hasn’t arrived, check your spam folder. Email delivery can take a few minutes.</p><a href="/" className="button primary">Back to queue</a><a href="/submit" className="text-button">Submit another print</a></section>;
  return <form onSubmit={submit} className="submission-grid"><div><fieldset disabled={busy} className="form-section"><legend>Part details</legend><label>Project / part title<input name="title" required maxLength={200} autoComplete="off" /></label><label className="file-drop"><strong>{file ? file.name : 'Choose your STL file'}</strong><span className="small muted">{file ? `${(file.size / 1024 ** 2).toFixed(2)} MiB · Click to replace` : 'ASCII or binary STL · Up to 500 MiB'}</span><input type="file" accept=".stl" required aria-label="STL file" onChange={e => { const next = e.target.files?.[0] ?? null; if (next && (next.size > MAX_FILE_BYTES || !/\.stl$/i.test(next.name))) { setMessage('Choose an STL file up to 500 MiB.'); e.target.value = ''; setFile(null); } else { setFile(next); setMessage(''); } }} /></label><label>Notes for the operator <span className="optional">Optional</span><textarea name="notes" maxLength={5000} rows={3} placeholder="Orientation, fit, or other requirements" /></label></fieldset>
    <fieldset disabled={busy} className="form-section"><legend>Print settings</legend><div className="field-grid"><label>Material<select name="material" value={material} onChange={e => handleMaterialChange(e.target.value)}>{materials.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}</select></label><label>Infill<select name="infill" defaultValue="15">{INFILLS.map(v => <option key={v} value={v}>{v}%</option>)}</select></label><label>Layer height<select name="layer_height" defaultValue="0.2">{LAYERS.map(v => <option key={v} value={v}>{v} mm</option>)}</select></label><label>Supports<select name="supports" defaultValue="operator">{SUPPORTS.map(v => <option key={v} value={v}>{supportLabel(v)}</option>)}</select></label><label>Number of copies<select name="copies" defaultValue="1">{[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v} {v === 1 ? 'copy' : 'copies'}</option>)}</select></label></div><fieldset className="color-options"><legend>Filament color</legend>{availableColors.map(c => { const isSelected = color.toLowerCase() === c.name.toLowerCase(); const hex = resolveColor(c.name, c.code); return <label className={isSelected ? 'selected' : ''} key={c.name}><input type="radio" name="color" value={c.name} checked={isSelected} onChange={() => setColor(c.name)} /><i className={`swatch ${c.name.toLowerCase()}`} style={{ backgroundColor: hex }} /><span>{c.name}</span></label>; })}</fieldset><label className="checkbox-label"><input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} /><span>Mirror the part along the X axis</span></label></fieldset>
    <fieldset disabled={busy} className="form-section"><legend>Contact</legend><label>Purdue email<input name="email" type="email" required maxLength={254} pattern="[^@\s]+@purdue\.edu" autoComplete="email" placeholder="you@purdue.edu" value={email} onChange={e => setEmail(e.target.value.toLowerCase())} /></label><p className="small muted">We’ll send a confirmation link and print updates here. Your email and operator notes are private. Your title and print settings are public after confirmation.</p></fieldset>
    {message && <p className="notice error" role="alert">{message}</p>}{busy && <div className="upload-progress" role="status"><progress value={progress} max={100} /><p>{progress < 100 ? `Uploading your STL… ${progress}%` : 'Validating your STL and sending your confirmation email…'}</p></div>}<div className="form-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? 'Sending your print…' : 'Send confirmation email'}</button>{busy && <button type="button" className="text-button" onClick={() => { controllerRef.current?.abort(); xhrRef.current?.abort(); }}>Cancel</button>}</div><p className="small muted">Confirm the email link within 24 hours to join the queue.</p></div><aside className="preview-column"><Suspense fallback={<div className="preview-panel">Loading preview…</div>}><Preview file={file} color={color} mirror={mirror} /></Suspense></aside></form>;
}
