import { lazy, Suspense, useRef, useState, type SubmitEvent } from 'react';
import {
  INFILLS,
  LAYERS,
  MAX_BATCH_SIZE,
  MAX_FILE_BYTES,
  SUPPORTS,
  supportLabel,
  resolveColor,
  type Material,
} from '../lib/shared';
import { IDENTITY_ROTATION } from '@time-estimator/browser-preview/pose';
import { prepareOrientedFile } from '../lib/oriented-file';
const DEFAULT_ROTATION = [...IDENTITY_ROTATION];
interface FileOptions {
  copies: number;
  mirror: boolean;
}
const DEFAULT_FILE_OPTIONS: FileOptions = { copies: 1, mirror: false };
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

export default function SubmissionForm({
  initialMaterials,
}: {
  initialMaterials?: Material[];
}) {
  const materials =
    initialMaterials && initialMaterials.length > 0
      ? initialMaterials
      : DEFAULT_MATERIALS;
  const [files, setFiles] = useState<File[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [orientations, setOrientations] = useState<Map<File, number[]>>(
    () => new Map(),
  );
  const [preparing, setPreparing] = useState(false);
  const [material, setMaterial] = useState(materials[0].name);
  const [color, setColor] = useState(materials[0].colors[0]?.name ?? 'black');
  const [fileOptions, setFileOptions] = useState<Map<File, FileOptions>>(
    () => new Map(),
  );
  const [infill, setInfill] = useState(15),
    [layerHeight, setLayerHeight] = useState(0.2),
    [supports, setSupports] = useState('operator');
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [message, setMessage] = useState(''),
    [success, setSuccess] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null),
    controllerRef = useRef<AbortController | null>(null);
  const [email, setEmail] = useState('');

  const currentMat =
    materials.find((m) => m.name.toLowerCase() === material.toLowerCase()) ??
    materials[0];
  const availableColors = currentMat?.colors ?? [];
  const activeFile = files[activeIndex] ?? files[0] ?? null;
  const activeRotation = activeFile
    ? (orientations.get(activeFile) ?? DEFAULT_ROTATION)
    : DEFAULT_ROTATION;
  const activeOptions = activeFile
    ? (fileOptions.get(activeFile) ?? DEFAULT_FILE_OPTIONS)
    : DEFAULT_FILE_OPTIONS;
  const { copies, mirror } = activeOptions;
  function updateFileOptions(change: Partial<FileOptions>) {
    if (activeFile)
      setFileOptions((current) =>
        new Map(current).set(activeFile, {
          ...(current.get(activeFile) ?? DEFAULT_FILE_OPTIONS),
          ...change,
        }),
      );
  }

  function handleMaterialChange(nextName: string) {
    setMaterial(nextName);
    const nextMat = materials.find(
      (m) => m.name.toLowerCase() === nextName.toLowerCase(),
    );
    if (
      nextMat &&
      !nextMat.colors.some((c) => c.name.toLowerCase() === color.toLowerCase())
    ) {
      setColor(nextMat.colors[0]?.name ?? 'black');
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length === 0) return;
    if (
      selected.some(
        (f) =>
          f.size > MAX_FILE_BYTES || f.size === 0 || !/\.stl$/i.test(f.name),
      )
    ) {
      setMessage('Choose STL files between 1 byte and 500 MiB.');
      e.target.value = '';
      if (files.length === 0) setFiles([]);
      return;
    }
    const merged = [...files];
    for (const f of selected) {
      const existingIdx = merged.findIndex(
        (m) => m.name === f.name && m.size === f.size,
      );
      if (existingIdx >= 0) merged[existingIdx] = f;
      else merged.push(f);
    }
    if (merged.length > MAX_BATCH_SIZE) {
      setMessage(
        `You can submit up to ${MAX_BATCH_SIZE} STL files in a single batch.`,
      );
      e.target.value = '';
      return;
    }
    setOrientations(
      (current) =>
        new Map([...current].filter(([file]) => merged.includes(file))),
    );
    setFileOptions(
      (current) =>
        new Map([...current].filter(([file]) => merged.includes(file))),
    );
    setFiles(merged);
    if (files.length === 0) setActiveIndex(0);
    setMessage('');
    e.target.value = '';
  }

  function removeFileAt(index: number) {
    const next = files.filter((_, i) => i !== index);
    setOrientations(
      (current) =>
        new Map([...current].filter(([file]) => next.includes(file))),
    );
    setFileOptions(
      (current) =>
        new Map([...current].filter(([file]) => next.includes(file))),
    );
    setFiles(next);
    if (index < activeIndex) setActiveIndex(activeIndex - 1);
    else if (activeIndex >= next.length) {
      setActiveIndex(Math.max(0, next.length - 1));
    }
  }

  function uploadFile(
    id: string,
    capability: string,
    targetFile: File,
    isBatch: boolean,
    onBytes: (loaded: number) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open(
        'PUT',
        `/api/submissions/${id}/file${isBatch ? '?batch=1' : ''}`,
      );
      xhr.setRequestHeader('Authorization', `Bearer ${capability}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onBytes(event.loaded);
      };
      xhr.onload = () => {
        let result;
        try {
          result = JSON.parse(xhr.responseText);
        } catch {
          reject(
            new Error(
              'The server could not process the upload. Please try again.',
            ),
          );
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(result.error ?? 'Upload failed.'));
      };
      xhr.onerror = () =>
        reject(new Error('Connection lost. Please try again.'));
      xhr.onabort = () => reject(new Error('Upload canceled.'));
      xhr.send(targetFile);
    });
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      files.length === 0 ||
      files.some((f) => f.size > MAX_FILE_BYTES || f.size === 0)
    ) {
      setMessage('Choose at least one STL between 1 byte and 500 MiB.');
      return;
    }
    if (files.length > MAX_BATCH_SIZE) {
      setMessage(`Choose up to ${MAX_BATCH_SIZE} STL files per batch.`);
      return;
    }
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    setProgress(0);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setPreparing(true);
      const uploadFiles: File[] = [];
      for (const file of files)
        uploadFiles.push(
          await prepareOrientedFile(
            file,
            orientations.get(file),
            fileOptions.get(file)?.mirror ?? false,
            controller.signal,
          ),
        );
      if (uploadFiles.some((file) => file.size > MAX_FILE_BYTES))
        throw new Error('The oriented STL exceeds 500 MiB.');
      const totalBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
      setPreparing(false);
      if (files.length === 1) {
        const singleFile = uploadFiles[0];
        const response = await fetch('/api/submissions', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: fields.get('title'),
            email: fields.get('email'),
            notes: fields.get('notes'),
            original_filename: singleFile.name,
            file_size: singleFile.size,
            infill: Number(fields.get('infill')),
            material,
            color,
            layer_height: Number(fields.get('layer_height')),
            supports: fields.get('supports'),
            copies: fileOptions.get(files[0])?.copies ?? 1,
            mirror: 0,
          }),
        });
        const reservation = await response.json();
        if (!response.ok) throw new Error(reservation.error);
        if (controller.signal.aborted) throw new Error('Upload canceled.');
        await uploadFile(
          reservation.id,
          reservation.capability,
          singleFile,
          false,
          (loaded) => {
            setProgress(Math.round((loaded / totalBytes) * 100));
          },
        );
      } else {
        const response = await fetch('/api/submissions/batch', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: fields.get('title'),
            email: fields.get('email'),
            notes: fields.get('notes'),
            infill: Number(fields.get('infill')),
            material,
            color,
            layer_height: Number(fields.get('layer_height')),
            supports: fields.get('supports'),
            mirror: 0,
            items: uploadFiles.map((f, index) => ({
              original_filename: f.name,
              file_size: f.size,
              copies: fileOptions.get(files[index])?.copies ?? 1,
            })),
          }),
        });
        const reservation = await response.json();
        if (!response.ok) throw new Error(reservation.error);
        if (controller.signal.aborted) throw new Error('Upload canceled.');
        let completedBytes = 0;
        for (let i = 0; i < files.length; i++) {
          if (controller.signal.aborted) throw new Error('Upload canceled.');
          const itemRes = reservation.items[i];
          const targetFile = uploadFiles[i];
          await uploadFile(
            itemRes.id,
            itemRes.capability,
            targetFile,
            true,
            (loaded) => {
              setProgress(
                Math.round(((completedBytes + loaded) / totalBytes) * 100),
              );
            },
          );
          completedBytes += targetFile.size;
          setProgress(Math.round((completedBytes / totalBytes) * 100));
        }
        const finalizeRes = await fetch('/api/submissions/batch/finalize', {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${reservation.batchToken}` },
        });
        const finalizeBody = await finalizeRes.json();
        if (!finalizeRes.ok)
          throw new Error(finalizeBody.error ?? 'Failed to finalize batch.');
      }
      setSuccess(true);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Submission failed. Please try again.',
      );
    } finally {
      setPreparing(false);
      setBusy(false);
      xhrRef.current = null;
      controllerRef.current = null;
    }
  }
  if (success)
    return (
      <section className="receipt">
        <h2>Check your email</h2>
        <p>
          We sent a confirmation link to <strong>{email}</strong>.
        </p>
        <p>
          Open it and press{' '}
          <strong>
            {files.length > 1
              ? `Confirm ${files.length} prints`
              : 'Confirm print'}
          </strong>{' '}
          within 24 hours.{' '}
          {files.length > 1
            ? `Your ${files.length} prints will join the queue after you confirm.`
            : 'Your print will join the queue after you confirm.'}
        </p>
        <p className="small muted">
          If it hasn’t arrived, check your spam folder. Email delivery can take
          a few minutes.
        </p>
        <a href="/" className="button primary">
          Back to queue
        </a>
        <a href="/submit" className="text-button">
          Submit another print
        </a>
      </section>
    );
  return (
    <form onSubmit={submit} className="submission-grid">
      <div>
        <fieldset disabled={busy} className="form-section">
          <legend>Part details</legend>
          <label>
            Project / part title
            <input name="title" required maxLength={200} autoComplete="off" />
          </label>
          <label className="file-drop">
            <strong>
              {files.length === 0
                ? 'Choose your STL file(s)'
                : files.length === 1
                  ? files[0].name
                  : `${files.length} STL files selected`}
            </strong>
            <span className="small muted">
              {files.length === 0
                ? `ASCII or binary STL · Up to 500 MiB each (up to ${MAX_BATCH_SIZE} files)`
                : files.length === 1
                  ? `${(files[0].size / 1024 ** 2).toFixed(2)} MiB · Click to add more or replace`
                  : `${(files.reduce((s, f) => s + f.size, 0) / 1024 ** 2).toFixed(2)} MiB total · Click to add more files`}
            </span>
            <input
              type="file"
              accept=".stl"
              multiple
              required={files.length === 0}
              aria-label="STL file"
              onChange={handleFileChange}
            />
          </label>
          {files.length > 0 && (
            <div className="batch-file-list" aria-label="Selected STL files">
              <div className="batch-file-list-header">
                <span className="small muted">
                  {files.length === 1
                    ? '1 file ready for submission'
                    : `${files.length} files in batch (click a file to preview)`}
                </span>
                {files.length > 1 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setFiles([]);
                      setOrientations(new Map());
                      setFileOptions(new Map());
                      setActiveIndex(0);
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>
              <ul>
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className={i === activeIndex ? 'active' : ''}
                  >
                    <button
                      type="button"
                      className="batch-file-select"
                      onClick={() => setActiveIndex(i)}
                      aria-pressed={i === activeIndex}
                    >
                      <span className="batch-file-details">
                        <span className="batch-file-name">{f.name}</span>
                        <span className="batch-file-options-summary">
                          {fileOptions.get(f)?.copies ?? 1}{' '}
                          {(fileOptions.get(f)?.copies ?? 1) === 1
                            ? 'copy'
                            : 'copies'}
                          {fileOptions.get(f)?.mirror && ' · Mirrored'}
                          {i === activeIndex && ' · Previewing'}
                        </span>
                      </span>
                      <span className="batch-file-size mono">
                        {(f.size / 1024 ** 2).toFixed(2)} MiB
                      </span>
                    </button>
                    <button
                      type="button"
                      className="batch-file-remove"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => removeFileAt(i)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activeFile && (
            <fieldset
              className="file-options"
              aria-label="Selected file options"
            >
              <legend>
                Options for <strong>{activeFile.name}</strong>
              </legend>
              <div className="file-options-controls">
                <label>
                  Number of copies
                  <select
                    name="copies"
                    value={copies}
                    onChange={(event) =>
                      updateFileOptions({ copies: Number(event.target.value) })
                    }
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value} {value === 1 ? 'copy' : 'copies'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={mirror}
                    onChange={(event) =>
                      updateFileOptions({ mirror: event.target.checked })
                    }
                  />
                  <span>Mirror along the X axis</span>
                </label>
              </div>
            </fieldset>
          )}
          <label>
            Notes for the operator <span className="optional">Optional</span>
            <textarea
              name="notes"
              maxLength={5000}
              rows={3}
              placeholder="Orientation, fit, or other requirements"
            />
          </label>
        </fieldset>
        <fieldset disabled={busy} className="form-section">
          <legend>Print settings</legend>
          {files.length > 1 && (
            <p className="small muted">These settings apply to all files.</p>
          )}
          <div className="field-grid">
            <label>
              Material
              <select
                name="material"
                value={material}
                onChange={(e) => handleMaterialChange(e.target.value)}
              >
                {materials.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Infill
              <select
                name="infill"
                value={infill}
                onChange={(e) => setInfill(Number(e.target.value))}
              >
                {INFILLS.map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
              </select>
            </label>
            <label>
              Layer height
              <select
                name="layer_height"
                value={layerHeight}
                onChange={(e) => setLayerHeight(Number(e.target.value))}
              >
                {LAYERS.map((v) => (
                  <option key={v} value={v}>
                    {v} mm
                  </option>
                ))}
              </select>
            </label>
            <label>
              Supports
              <select
                name="supports"
                value={supports}
                onChange={(e) => setSupports(e.target.value)}
              >
                {SUPPORTS.map((v) => (
                  <option key={v} value={v}>
                    {supportLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="color-options">
            <legend>Filament color</legend>
            {availableColors.map((c) => {
              const isSelected = color.toLowerCase() === c.name.toLowerCase();
              const hex = resolveColor(c.name, c.code);
              return (
                <label className={isSelected ? 'selected' : ''} key={c.name}>
                  <input
                    type="radio"
                    name="color"
                    value={c.name}
                    checked={isSelected}
                    onChange={() => setColor(c.name)}
                  />
                  <i
                    className={`swatch ${c.name.toLowerCase()}`}
                    style={{ backgroundColor: hex }}
                  />
                  <span>{c.name}</span>
                </label>
              );
            })}
          </fieldset>
        </fieldset>
        <fieldset disabled={busy} className="form-section">
          <legend>Contact</legend>
          <label>
            Purdue email
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              pattern="[^@\s]+@purdue\.edu"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="you@purdue.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value.toLowerCase())}
            />
          </label>
          <p className="small muted">
            We’ll send a confirmation link and print updates here. Your email
            and operator notes are private. Your title and print settings are
            public after confirmation.
          </p>
        </fieldset>
        {message && (
          <p className="notice error" role="alert">
            {message}
          </p>
        )}
        {busy && (
          <div className="upload-progress" role="status">
            <progress value={progress} max={100} />
            <p>
              {preparing
                ? 'Saving orientation…'
                : progress < 100
                  ? `Uploading your STL${files.length > 1 ? 's' : ''}… ${progress}%`
                  : `Validating your STL${files.length > 1 ? 's' : ''} and sending your confirmation email…`}
            </p>
          </div>
        )}
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={busy}>
            {busy
              ? files.length > 1
                ? 'Sending your prints…'
                : 'Sending your print…'
              : 'Send confirmation email'}
          </button>
          {busy && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                controllerRef.current?.abort();
                xhrRef.current?.abort();
              }}
            >
              Cancel
            </button>
          )}
        </div>
        <p className="small muted">
          Confirm the email link within 24 hours to join the queue.
        </p>
      </div>
      <aside className="preview-column">
        <Suspense
          fallback={<div className="preview-panel">Loading preview…</div>}
        >
          <Preview
            file={activeFile}
            color={resolveColor(
              color,
              availableColors.find(
                (c) => c.name.toLowerCase() === color.toLowerCase(),
              )?.code,
            )}
            mirror={mirror}
            copies={copies}
            infill={infill}
            layerHeight={layerHeight}
            supports={supports}
            rotation={activeRotation}
            disabled={busy}
            onRotationChange={(rotation) => {
              if (activeFile)
                setOrientations((current) =>
                  new Map(current).set(activeFile, rotation),
                );
            }}
          />
        </Suspense>
      </aside>
    </form>
  );
}
