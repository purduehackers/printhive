import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { Job } from '../lib/shared';
import { MAX_EXPORT_JOBS, SLICERS, type Slicer, type SlicerExportResult } from '../lib/slicer';
import '../styles/slicer-controls.css';

type ExportJob = Pick<Job, 'id' | 'version'>;
export default function SlicerControls({ jobs }: { jobs: ExportJob[] }) {
  const id = useId();
  const [slicer, setSlicer] = useState<Slicer>('orca');
  const printer = slicer === 'bambu' ? 'h2d' : 'core-one';
  const [result, setResult] = useState<SlicerExportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const signature = jobs.map(job => `${job.id}:${job.version}`).join(',');
  useEffect(() => {
    setResult(null); setError(''); setExpired(false);
    return () => controller.current?.abort();
  }, [signature, slicer]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, result.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);
  const tooMany = jobs.length > MAX_EXPORT_JOBS;
  const ready = !busy && !tooMany && jobs.length > 0;
  const selected = SLICERS.find(item => item.id === slicer)!;

  async function prepare(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setResult(null); setExpired(false);
    try {
      const response = await fetch('/api/slicer-projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: current.signal,
        body: JSON.stringify({ ids: jobs.map(job => job.id), slicer, printer }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not prepare this project.');
      if (!current.signal.aborted) setResult(data);
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not prepare this project.');
    } finally { if (controller.current === current) setBusy(false); }
  }

  return <section className="slicer-controls" aria-label="Open in slicer">
    <div className="slicer-heading"><h3>Open in slicer</h3><span className="small muted">{jobs.length === 1 ? '1 print' : `${jobs.length} prints`}</span></div>
    <form onSubmit={prepare}>
      <div className="slicer-options">
        <label htmlFor={`${id}-slicer`}>Open with
          <select id={`${id}-slicer`} value={slicer} onChange={event => setSlicer(event.target.value as Slicer)}>
            {SLICERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button type="submit" className="button secondary" disabled={!ready}>
          {busy ? 'Preparing project…' : result && !expired ? 'Prepare again' : 'Prepare project'}
        </button>
      </div>
      <p className="small muted slicer-help">Uses your locally selected printer, filament and process presets. Includes model infill, layer height, supports and copies; “Operator decides” uses no supports. Choose Open as project if asked to retain model settings.</p>
      <p className="small muted slicer-help">Choose your printer and filament in your slicer, then review the plate before printing.</p>
      {slicer === 'prusa' && <p className="small muted">Download the prepared project, then open it in PrusaSlicer. Direct opening from this website is restricted by PrusaSlicer.</p>}
      {tooMany && <p className="notice error" role="alert">Select at most {MAX_EXPORT_JOBS} prints for one project.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </form>
    {result && <div className="slicer-result" role="status">
      {expired ? <p>This project link has expired. Prepare it again.</p> : <>
        <span className="small">Project ready · link expires in 15 minutes.</span>
        {result.launchUrl && <a className="button primary" href={result.launchUrl}>Open in {selected.name} ↗</a>}
        <a className={`button ${result.launchUrl ? 'secondary' : 'primary'}`} href={result.downloadUrl}>Download project ↓</a>
        {result.launchUrl && <span className="small muted">If the app does not open, enable website downloads in your slicer or use Download project.</span>}
      </>}
    </div>}
  </section>;
}
