import { lazy, Suspense, useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  MAX_BATCH_SIZE,
  MAX_FILE_BYTES,
  resolveColor,
  supportLabel,
  type Material,
} from '../lib/shared';
import { IDENTITY_ROTATION } from '@time-estimator/browser-preview/pose';
import { prepareOrientedFile } from '../lib/oriented-file';
import { preparePrintThumbnails, uploadPrintThumbnail } from '../lib/print-thumbnails';
const DEFAULT_ROTATION = [...IDENTITY_ROTATION];
import PartSettingsFields from './PartSettingsFields';
import {
  defaultPartSettings,
  getDefaultColor,
  getDefaultMaterial,
  normalizePartOverrides,
  resolvePartSettings,
  partScale,
  partSupportAngle,
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

const VERIFIED_EMAIL_STORAGE_KEY = 'printhive_verified_email';

export default function SubmissionForm({
  initialMaterials,
  initialVerifiedEmail = null,
  initialVerifiedToken = null,
  initialVerifiedExpires = null,
}: {
  initialMaterials?: Material[];
  initialVerifiedEmail?: string | null;
  initialVerifiedToken?: string | null;
  initialVerifiedExpires?: number | null;
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
    [success, setSuccess] = useState(false),
    [autoConfirmed, setAutoConfirmed] = useState(false),
    [reviewing, setReviewing] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null),
    controllerRef = useRef<AbortController | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(
    initialVerifiedEmail ? initialVerifiedEmail.toLowerCase() : null,
  );
  const [verifiedToken, setVerifiedToken] = useState<string | null>(
    initialVerifiedToken,
  );
  const [email, setEmail] = useState(
    initialVerifiedEmail ? initialVerifiedEmail.toLowerCase() : '',
  );

  useEffect(() => {
    try {
      if (initialVerifiedEmail && initialVerifiedToken) {
        localStorage.setItem(
          VERIFIED_EMAIL_STORAGE_KEY,
          JSON.stringify({
            email: initialVerifiedEmail.toLowerCase(),
            token: initialVerifiedToken,
            expires:
              initialVerifiedExpires ??
              Date.now() + 30 * 24 * 60 * 60 * 1000,
          }),
        );
        return;
      }
      const raw = localStorage.getItem(VERIFIED_EMAIL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.email === 'string' &&
        typeof parsed.token === 'string' &&
        (!parsed.expires || parsed.expires > Date.now())
      ) {
        const normalized = parsed.email.toLowerCase();
        setVerifiedEmail(normalized);
        setVerifiedToken(parsed.token);
        setEmail((current) => current || normalized);
      } else {
        localStorage.removeItem(VERIFIED_EMAIL_STORAGE_KEY);
      }
    } catch {
      /* Ignore storage errors */
    }
  }, [initialVerifiedEmail, initialVerifiedToken, initialVerifiedExpires]);

  const isEmailVerified = Boolean(
    verifiedEmail &&
      email.trim().toLowerCase() === verifiedEmail.toLowerCase(),
  );

  async function forgetVerifiedEmail() {
    setVerifiedEmail(null);
    setVerifiedToken(null);
    setEmail('');
    try {
      localStorage.removeItem(VERIFIED_EMAIL_STORAGE_KEY);
    } catch {}
    try {
      await fetch('/api/verified-email', { method: 'DELETE' });
    } catch {}
  }

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
  const activeSupportAngle = partSupportAngle(activeOptions);
  const activeSettingsValid =
    activeScale !== null && activeSupportAngle !== null;
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
    if (
      change.material !== undefined &&
      change.color === undefined &&
      change.material.toLowerCase() !== globalSettings.material.toLowerCase()
    ) {
      const targetMat =
        materials.find(
          (item) => item.name.toLowerCase() === change.material!.toLowerCase(),
        ) ?? getDefaultMaterial(materials);
      next.color = getDefaultColor(targetMat);
    }
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
    tokenForVerifiedEmail?: string | null,
  ) {
    return new Promise<{ confirmed?: boolean }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open(
        'PUT',
        `/api/submissions/${id}/file${isBatch ? '?batch=1' : ''}`,
      );
      xhr.setRequestHeader('Authorization', `Bearer ${capability}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (tokenForVerifiedEmail) {
        xhr.setRequestHeader('X-Verified-Email-Token', tokenForVerifiedEmail);
      }
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
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
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
      setReviewing(false);
      setMessage('Choose at least one STL between 1 byte and 500 MiB.');
      return;
    }
    if (files.length > MAX_BATCH_SIZE) {
      setReviewing(false);
      setMessage(`Choose up to ${MAX_BATCH_SIZE} STL files per batch.`);
      return;
    }
    const settings = files.map((file) =>
      resolvePartSettings(globalSettings, fileOptions.get(file), materials),
    );
    const invalid = settings.findIndex((value) => partScale(value) === null);
    if (invalid !== -1) {
      setReviewing(false);
      setActiveIndex(invalid);
      setFileOptionsOpen(true);
      setMoreSettingsOpen(true);
      setMessage(
        `Enter a scale between 0.01% and 10000% for ${files[invalid].name}.`,
      );
      return;
    }
    const invalidAngle = settings.findIndex(
      (value) => partSupportAngle(value) === null,
    );
    if (invalidAngle !== -1) {
      setReviewing(false);
      setActiveIndex(invalidAngle);
      setFileOptionsOpen(true);
      setMoreSettingsOpen(true);
      setMessage(
        `Enter a whole-number support angle from 0° to 90° for ${files[invalidAngle].name}.`,
      );
      return;
    }
    if (!reviewing) {
      // Check all parts first so an invalid field can be revealed before native
      // title/email/default-setting validation tries to focus a hidden control.
      if (!event.currentTarget.reportValidity()) return;
      setMessage('');
      setReviewing(true);
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
      return;
    }
    const trimmedTitle = title.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedNotes = notes.trim();
    setBusy(true);
    setMessage('');
    setProgress(0);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const thumbnails = preparePrintThumbnails(files.map((file, index) => ({
        file, rotation: orientations.get(file) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1],
        mirror: settings[index].mirror, scale: partScale(settings[index])!, color: settings[index].color,
      })), controller.signal);
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
      const activeVerifiedToken = isEmailVerified ? verifiedToken : null;
      const verifiedHeaders: Record<string, string> = activeVerifiedToken
        ? { 'X-Verified-Email-Token': activeVerifiedToken }
        : {};
      if (files.length === 1) {
        const singleFile = uploadFiles[0];
        const selected = settings[0];
        const response = await fetch('/api/submissions', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...verifiedHeaders },
          body: JSON.stringify({
            title: trimmedTitle,
            email: trimmedEmail,
            notes: trimmedNotes,
            original_filename: singleFile.name,
            file_size: singleFile.size,
            infill: selected.infill,
            material: selected.material,
            color: selected.color,
            layer_height: selected.layerHeight,
            supports: selected.supports,
            support_angle: partSupportAngle(selected) ?? null,
            copies: selected.copies,
            mirror: 0,
          }),
        });
        const reservation = await response.json();
        if (!response.ok) throw new Error(reservation.error);
        if (controller.signal.aborted) throw new Error('Upload canceled.');
        await uploadPrintThumbnail(reservation.id, reservation.capability, thumbnails[0], controller.signal);
        const uploadRes = await uploadFile(
          reservation.id,
          reservation.capability,
          singleFile,
          false,
          (loaded) => {
            setProgress(Math.round((loaded / totalBytes) * 100));
          },
          activeVerifiedToken,
        );
        setAutoConfirmed(Boolean(uploadRes?.confirmed));
      } else {
        const response = await fetch('/api/submissions/batch', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...verifiedHeaders },
          body: JSON.stringify({
            title: trimmedTitle,
            email: trimmedEmail,
            notes: trimmedNotes,
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
              support_angle: partSupportAngle(settings[index]) ?? null,
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
          await uploadPrintThumbnail(itemRes.id, itemRes.capability, thumbnails[i], controller.signal);
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
            activeVerifiedToken,
          );
          completedBytes += targetFile.size;
          setProgress(Math.round((completedBytes / totalBytes) * 100));
        }
        const finalizeRes = await fetch('/api/submissions/batch/finalize', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${reservation.batchToken}`,
            ...verifiedHeaders,
          },
        });
        const finalizeBody = await finalizeRes.json();
        if (!finalizeRes.ok)
          throw new Error(finalizeBody.error ?? 'Failed to finalize batch.');
        setAutoConfirmed(Boolean(finalizeBody?.confirmed));
      }
      setSuccess(true);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Submission failed. Please try again.',
      );
    } finally {
      controller.abort();
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
    return autoConfirmed ? (
      <section className="receipt">
        <h2>{files.length > 1 ? 'Prints queued' : 'Print queued'}</h2>
        <p>
          {files.length > 1
            ? `Your ${files.length} prints are grouped and queued. We’ll email `
            : 'Your print is queued. We’ll email '}
          <strong>{email}</strong>{' '}
          {files.length > 1
            ? 'when an operator changes their status.'
            : 'when the operator changes its status.'}
        </p>
        <a href="/" className="button primary">
          Back to queue
        </a>
        <a href="/submit" className="text-button">
          Submit another print
        </a>
      </section>
    ) : (
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
  const reviewSettings = files.map((file) =>
    resolvePartSettings(globalSettings, fileOptions.get(file), materials),
  );
  return (
    <form noValidate onSubmit={submit} className="submission-grid">
      <div>
        {reviewing ? (
          <section className="review-panel" aria-label="Review submission">
            <div className="review-header">
              <div>
                <p className="eyebrow">Step 2 of 2 · Review before submitting</p>
                <h2>
                  {files.length > 1
                    ? `Review your ${files.length} prints`
                    : 'Review your print'}
                </h2>
              </div>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setReviewing(false);
                  setMessage('');
                }}
              >
                Edit settings
              </button>
            </div>
            <p className="small muted review-intro">
              Verify that your part settings, 3D orientation, and contact
              details are correct before{' '}
              {isEmailVerified
                ? 'committing to the print queue.'
                : 'sending your confirmation email.'}
            </p>

            <div className="detail-card review-card">
              <h3>Submission details</h3>
              <dl className="settings-grid review-overview-grid">
                <div>
                  <dt>
                    {files.length > 1 ? 'Batch / project title' : 'Part title'}
                  </dt>
                  <dd className="review-value-text">{title.trim()}</dd>
                </div>
                <div>
                  <dt>Purdue email</dt>
                  <dd className="review-value-text">
                    <span>{email.trim()}</span>
                    {isEmailVerified && (
                      <span className="verified-email-badge">✓ Verified</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Total parts</dt>
                  <dd className="review-value-text">
                    {files.length} {files.length === 1 ? 'file' : 'files'} (
                    {reviewSettings.reduce((sum, s) => sum + s.copies, 0)}{' '}
                    {reviewSettings.reduce((sum, s) => sum + s.copies, 0) === 1
                      ? 'copy'
                      : 'copies'}
                    )
                  </dd>
                </div>
              </dl>
              <div className="review-notes-block">
                <span className="review-notes-label">Operator notes</span>
                <p className="operator-notes">
                  {notes.trim() || 'No notes provided.'}
                </p>
              </div>
            </div>

            <div className="review-parts-list" aria-label="Parts to submit">
              {files.map((f, i) => {
                const part = reviewSettings[i];
                const matObj =
                  materials.find(
                    (m) => m.name.toLowerCase() === part.material.toLowerCase(),
                  ) ?? materials[0];
                const colorCode = matObj?.colors.find(
                  (c) => c.name.toLowerCase() === part.color.toLowerCase(),
                )?.code;
                const swatchHex = resolveColor(part.color, colorCode);
                const stem =
                  f.name.replace(/\.stl$/i, '').trim() || `Part ${i + 1}`;
                const partTitle =
                  files.length > 1
                    ? `${title.trim()} · ${stem}`
                    : title.trim();
                const rot = orientations.get(f) ?? DEFAULT_ROTATION;
                const isRotated = rot.some(
                  (val, idx) => Math.abs(val - DEFAULT_ROTATION[idx]) > 1e-5,
                );
                const angle = partSupportAngle(part);
                return (
                  <div
                    key={`${f.name}-${i}`}
                    className={`detail-card review-part-card${i === activeIndex ? ' active' : ''}`}
                  >
                    <div className="review-part-header">
                      <div className="review-part-heading">
                        <h3>{partTitle}</h3>
                        <span className="small muted">
                          {f.name} · {(f.size / 1024 ** 2).toFixed(2)} MiB
                        </span>
                      </div>
                      {files.length > 1 && (
                        <button
                          type="button"
                          className={`button secondary review-preview-btn${i === activeIndex ? ' is-active' : ''}`}
                          onClick={() => setActiveIndex(i)}
                          aria-pressed={i === activeIndex}
                        >
                          {i === activeIndex
                            ? 'Previewing in 3D'
                            : 'Preview in 3D'}
                        </button>
                      )}
                    </div>
                    <dl className="settings-grid review-settings-grid">
                      <div>
                        <dt>Material</dt>
                        <dd>{part.material}</dd>
                      </div>
                      <div>
                        <dt>Filament</dt>
                        <dd>
                          <i
                            className={`swatch ${part.color.toLowerCase()}`}
                            style={{ backgroundColor: swatchHex }}
                          />
                          {part.color}
                        </dd>
                      </div>
                      <div>
                        <dt>Infill</dt>
                        <dd>{part.infill}%</dd>
                      </div>
                      <div>
                        <dt>Layer height</dt>
                        <dd className="review-value-text">
                          {part.layerHeight} mm
                        </dd>
                      </div>
                      <div>
                        <dt>Supports</dt>
                        <dd>{supportLabel(part.supports)}</dd>
                      </div>
                      <div>
                        <dt>Support angle</dt>
                        <dd>
                          {angle === null ? 'Printer default' : `${angle}°`}
                        </dd>
                      </div>
                      <div>
                        <dt>Copies</dt>
                        <dd>{part.copies}</dd>
                      </div>
                      <div>
                        <dt>Mirror X</dt>
                        <dd>{part.mirror ? 'Mirrored' : 'Normal'}</dd>
                      </div>
                      <div>
                        <dt>Scale &amp; units</dt>
                        <dd className="review-value-text">
                          {part.scalePercent}% ({part.units})
                        </dd>
                      </div>
                      <div>
                        <dt>Orientation</dt>
                        <dd>{isRotated ? 'Custom oriented' : 'Original'}</dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <>
            <fieldset disabled={busy} className="form-section">
              <legend>Part details</legend>
              <label>
                Project / part title
                <input
                  name="title"
                  required
                  maxLength={200}
                  autoComplete="off"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
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
                <div
                  className="batch-file-list"
                  aria-label="Selected STL files"
                >
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
              <fieldset
                className="default-settings"
                aria-label="Default settings"
              >
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
                Notes for the operator{' '}
                <span className="optional">Optional</span>
                <textarea
                  name="notes"
                  maxLength={5000}
                  rows={3}
                  placeholder="Orientation, fit, or other requirements"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </fieldset>
            <fieldset disabled={busy} className="form-section">
              <legend>Contact</legend>
              <label>
                <span className="contact-label-row">
                  <span>Purdue email</span>
                  {isEmailVerified && (
                    <span className="verified-email-badge" role="status">
                      ✓ Verified
                    </span>
                  )}
                </span>
                <input
                  name="email"
                  type="email"
                  aria-label="Purdue email"
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
              {isEmailVerified ? (
                <p className="small muted contact-verified-note">
                  <span>
                    Your email is verified on this browser — prints join the
                    queue immediately without a confirmation email. We’ll email
                    you when an operator changes their status.
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={forgetVerifiedEmail}
                  >
                    Forget saved email
                  </button>
                </p>
              ) : (
                <p className="small muted">
                  We’ll send a confirmation link and print updates here. Your
                  email and operator notes are private. Your title and print
                  settings are public after confirmation.
                </p>
              )}
            </fieldset>
          </>
        )}
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
                  : isEmailVerified
                    ? `Validating and queueing your STL${files.length > 1 ? 's' : ''}…`
                    : `Validating your STL${files.length > 1 ? 's' : ''} and sending your confirmation email…`}
            </p>
          </div>
        )}
        <div className="form-actions">
          {reviewing ? (
            <>
              <button className="button primary" type="submit" disabled={busy}>
                {busy
                  ? files.length > 1
                    ? 'Sending your prints…'
                    : 'Sending your print…'
                  : isEmailVerified
                    ? files.length > 1
                      ? `Confirm & queue ${files.length} prints`
                      : 'Confirm & queue'
                    : 'Send confirmation email'}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setReviewing(false);
                  setMessage('');
                }}
              >
                Back to edit
              </button>
            </>
          ) : (
            <button className="button primary" type="submit" disabled={busy}>
              {files.length > 1 ? `Review ${files.length} prints` : 'Review print'}
            </button>
          )}
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
          {reviewing
            ? isEmailVerified
              ? 'Your email is verified on this browser — confirming places your print directly in the queue.'
              : 'Confirm the email link within 24 hours to join the queue.'
            : `Review your settings and 3D preview on the next screen before ${
                isEmailVerified
                  ? 'adding to the queue.'
                  : 'sending a confirmation email.'
              }`}
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
            settingsValid={activeSettingsValid}
            modelUnits={units}
            retainedFiles={files}
            onUseMeters={() => updatePartSettings({ units: 'm' })}
            infill={infill}
            layerHeight={layerHeight}
            supports={supports}
            supportAngle={activeSupportAngle ?? undefined}
            rotation={activeRotation}
            disabled={busy || !activeSettingsValid}
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
