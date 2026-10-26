import { lazy, Suspense, useRef, useState, type SubmitEvent } from 'react';
import {
  MAX_BATCH_SIZE,
  MAX_FILE_BYTES,
  resolveColor,
  type Material,
} from '../lib/shared';
import { IDENTITY_ROTATION } from '@time-estimator/browser-preview/pose';
import { prepareOrientedFile } from '../lib/oriented-file';
const DEFAULT_ROTATION = [...IDENTITY_ROTATION];
import PartSettingsFields from './PartSettingsFields';
import {
  defaultPartSettings,
  normalizePartOverrides,
  resolvePartSettings,
  partScale,
  type SharedPartSettings,
  type PartOptions,
} from '../lib/part-settings';
import '../styles/part-settings.css';
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
  const [fileOptionsOpen, setFileOptionsOpen] = useState(true);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
  const [orientations, setOrientations] = useState<Map<File, number[]>>(
    () => new Map(),
  );
  const [preparing, setPreparing] = useState(false);
  const [globalSettings, setGlobalSettings] = useState<SharedPartSettings>(() =>
    defaultPartSettings(materials),
  );
  const [fileOptions, setFileOptions] = useState<Map<File, PartOptions>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [message, setMessage] = useState(''),
    [success, setSuccess] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null),
    controllerRef = useRef<AbortController | null>(null);
  const [email, setEmail] = useState('');

  const activeFile = files[activeIndex] ?? files[0] ?? null;
  const activeRotation = activeFile
    ? (orientations.get(activeFile) ?? DEFAULT_ROTATION)
    : DEFAULT_ROTATION;
  const activePart = activeFile ? fileOptions.get(activeFile) : undefined;
  const activeOptions = resolvePartSettings(
    globalSettings,
    activePart,
    materials,
  );
  const {
    copies,
    mirror,
    material,
    color,
    infill,
    layerHeight,
    supports,
    units,
  } = activeOptions;
  const activeScale = partScale(activeOptions);
  const currentMat = materials.find((item) => item.name === material)!;
  const availableColors = currentMat.colors;

  function updateFileOptions(
    change: Partial<Pick<PartOptions, 'copies' | 'mirror'>>,
  ) {
    if (!activeFile) return;
    setFileOptions((current) =>
      new Map(current).set(activeFile, {
        copies: 1,
        mirror: false,
        overrides: {},
        ...current.get(activeFile),
        ...change,
      }),
    );
  }

  function updatePartSettings(change: Partial<SharedPartSettings>) {
    if (!activeFile) return;
    setFileOptions((current) => {
      const part = current.get(activeFile) ?? {
        copies: 1,
        mirror: false,
        overrides: {},
      };
      const overrides = { ...part.overrides, ...change };
      for (const key of Object.keys(overrides) as Array<
        keyof SharedPartSettings
      >)
        if (overrides[key] === undefined) delete overrides[key];
      return new Map(current).set(activeFile, {
        ...part,
        overrides: normalizePartOverrides(globalSettings, overrides, materials),
      });
    });
  }

  function updateGlobalSettings(change: Partial<SharedPartSettings>) {
    const next = { ...globalSettings, ...change };
    const resolved = resolvePartSettings(next, undefined, materials);
    next.material = resolved.material;
    next.color = resolved.color;
    setGlobalSettings(next);
    setFileOptions(
      (current) =>
        new Map(
          [...current].map(([file, part]) => [
            file,
            {
              ...part,
              overrides: normalizePartOverrides(
                next,
                part.overrides,
                materials,
              ),
            },
          ]),
        ),
    );
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
    if (files.length === 0) {
      setActiveIndex(0);
      setFileOptionsOpen(true);
    }
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
    const settings = files.map((file) =>
      resolvePartSettings(globalSettings, fileOptions.get(file), materials),
    );
    const invalid = settings.findIndex((value) => partScale(value) === null);
    if (invalid !== -1) {
      setActiveIndex(invalid);
      setFileOptionsOpen(true);
      setMoreSettingsOpen(true);
      setMessage(
        `Enter a scale between 0.01% and 10000% for ${files[invalid].name}.`,
      );
      return;
    }
    // Check all parts first so an invalid field can be revealed before native
    // title/email/default-setting validation tries to focus a hidden control.
    if (!event.currentTarget.reportValidity()) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    setProgress(0);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setPreparing(true);
      const uploadFiles: File[] = [];
      for (const [index, file] of files.entries())
        uploadFiles.push(
          await prepareOrientedFile(
            file,
            orientations.get(file),
            settings[index].mirror,
            controller.signal,
            partScale(settings[index])!,
          ),
        );
      if (uploadFiles.some((file) => file.size > MAX_FILE_BYTES))
        throw new Error('The oriented STL exceeds 500 MiB.');
      const totalBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
      setPreparing(false);
      if (files.length === 1) {
        const singleFile = uploadFiles[0];
        const selected = settings[0];
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
            infill: selected.infill,
            material: selected.material,
            color: selected.color,
            layer_height: selected.layerHeight,
            supports: selected.supports,
            copies: selected.copies,
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
            infill: globalSettings.infill,
            material: globalSettings.material,
            color: globalSettings.color,
            layer_height: globalSettings.layerHeight,
            supports: globalSettings.supports,
            mirror: 0,
            items: uploadFiles.map((f, index) => ({
              original_filename: f.name,
              file_size: f.size,
              copies: settings[index].copies,
              material: settings[index].material,
              color: settings[index].color,
              infill: settings[index].infill,
              layer_height: settings[index].layerHeight,
              supports: settings[index].supports,
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
  const fileOptionsPanel = activeFile && (
    <fieldset className="file-options" aria-label="Selected file options">
      <legend>
        Options for <strong>{activeFile.name}</strong>
      </legend>
      <div className="part-quick-controls">
        <label className="part-quick-control">
          <span>Copies</span>
          <select
            aria-label="Number of copies"
            value={copies}
            onChange={(event) =>
              updateFileOptions({ copies: Number(event.target.value) })
            }
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="part-quick-control">
          <span>
            Mirror <small>X axis</small>
          </span>
          <input
            className="mirror-switch"
            type="checkbox"
            role="switch"
            aria-label="Mirror along the X axis"
            checked={mirror}
            onChange={(event) =>
              updateFileOptions({ mirror: event.target.checked })
            }
          />
        </label>
      </div>
      <details
        className="file-settings"
        open={moreSettingsOpen}
        onToggle={(event) => setMoreSettingsOpen(event.currentTarget.open)}
      >
        <summary>More settings</summary>
        <div className="file-settings-body">
          <div className="part-override-heading">
            <span className="small muted">Only changes for this part.</span>
            <button
              type="button"
              className="text-button"
              disabled={!Object.keys(activePart?.overrides ?? {}).length}
              onClick={() =>
                activeFile &&
                setFileOptions((current) =>
                  new Map(current).set(activeFile, {
                    copies,
                    mirror,
                    overrides: {},
                  }),
                )
              }
            >
              Reset to defaults
            </button>
          </div>
          <PartSettingsFields
            global={globalSettings}
            overrides={activePart?.overrides ?? {}}
            materials={materials}
            onChange={updatePartSettings}
          />
        </div>
      </details>
    </fieldset>
  );
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
    <form noValidate onSubmit={submit} className="submission-grid">
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
                    <div className="batch-file-row">
                      <button
                        type="button"
                        className="batch-file-select"
                        onClick={() => {
                          setFileOptionsOpen(
                            i === activeIndex ? !fileOptionsOpen : true,
                          );
                          setActiveIndex(i);
                        }}
                        aria-expanded={i === activeIndex && fileOptionsOpen}
                        aria-controls={`file-options-${i}`}
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
                            {Object.keys(fileOptions.get(f)?.overrides ?? {})
                              .length > 0 && ' · Custom settings'}
                            {i === activeIndex && ' · Previewing'}
                          </span>
                        </span>
                        <span className="batch-file-size mono">
                          {(f.size / 1024 ** 2).toFixed(2)} MiB
                        </span>
                        <span
                          className="file-options-chevron"
                          aria-hidden="true"
                        >
                          ›
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
                    </div>
                    <div
                      id={`file-options-${i}`}
                      className="batch-file-options"
                      hidden={i !== activeIndex || !fileOptionsOpen}
                    >
                      {i === activeIndex && fileOptionsPanel}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <fieldset className="default-settings" aria-label="Default settings">
            <legend>Default settings</legend>
            <p className="small muted">
              Used for all files unless a file has its own settings.
            </p>
            <PartSettingsFields
              global={globalSettings}
              materials={materials}
              onChange={updateGlobalSettings}
            />
          </fieldset>
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
            scale={activeScale ?? 1}
            settingsValid={activeScale !== null}
            modelUnits={units}
            retainedFiles={files}
            onUseMeters={() => updatePartSettings({ units: 'm' })}
            infill={infill}
            layerHeight={layerHeight}
            supports={supports}
            rotation={activeRotation}
            disabled={busy || activeScale === null}
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
