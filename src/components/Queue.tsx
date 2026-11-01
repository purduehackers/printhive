import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import '../styles/queue-cancellation.css';
import { selectListItem, type SelectionModifiers } from '../lib/list-selection';
import {
  effectiveGroupName,
  reference,
  resolveColor,
  summarizeGroupStatus,
  type GroupStatusSummary,
  type PublicJob,
} from '../lib/shared';

function Settings({ job }: { job: PublicJob }) {
  return (
    <div className="job-settings">
      <span>{job.material ?? 'PLA'}</span>
      <span>
        <i className={`swatch ${job.color.toLowerCase()}`} style={{ backgroundColor: resolveColor(job.color) }} />
        {job.color}
      </span>
      <span>{job.layer_height} mm</span>
      <span>{job.infill}% infill</span>
      <span>{job.walls} walls</span>
      <span>{job.copies} {job.copies === 1 ? 'copy' : 'copies'}</span>
    </div>
  );
}

function getBatchKey(job: PublicJob): string | null {
  if (job.batch_id) return `batch:${job.batch_id}`;
  const group = effectiveGroupName(job);
  return group ? `group:${group}` : null;
}

export default function Queue({ initial }: { initial: PublicJob[] }) {
  const [jobs, setJobs] = useState(initial), [error, setError] = useState('');
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [email, setEmail] = useState(''), [sending, setSending] = useState(false);
  const [cancelError, setCancelError] = useState(''), [message, setMessage] = useState('');
  const [emailFormInView, setEmailFormInView] = useState(false);
  const emailForm = useRef<HTMLDivElement>(null), emailInput = useRef<HTMLInputElement>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const selectionAnchor = useRef<string | null>(null);
  const focusEmail = () => {
    emailForm.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    emailInput.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!selecting || !emailForm.current) return;
    const observer = new IntersectionObserver(([entry]) => setEmailFormInView(entry.intersectionRatio >= 0.05), { threshold: 0.05 });
    observer.observe(emailForm.current);
    return () => observer.disconnect();
  }, [selecting]);
  useEffect(() => {
    if (message) receipt.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch('/api/queue', { signal: controller.signal });
        if (!response.ok) throw new Error();
        setJobs(await response.json()); setError('');
      } catch { if (!controller.signal.aborted) setError('Live updates paused. We’ll try again shortly.'); }
    };
    const interval = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(interval); controller.abort(); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  useEffect(() => {
    setSelected(current => {
      const available = current.filter(id => jobs.some(job => job.id === id && job.status === 'queued'));
      return available.length === current.length ? current : available;
    });
  }, [jobs]);

  const selectedJob = jobs.find(job => selected.includes(job.id) && job.status === 'queued');
  const submissionKey = selectedJob ? selectedJob.batch_id ?? selectedJob.id : null;
  const submissionJobs = jobs.filter(job => job.status === 'queued' && (job.batch_id ?? job.id) === submissionKey);
  const togglePrint = (job: PublicJob, modifiers: SelectionModifiers = {}) => {
    if (sending || (submissionKey && (job.batch_id ?? job.id) !== submissionKey)) return;
    setCancelError('');
    const eligible = jobs.filter(item => item.status === 'queued' && (item.batch_id ?? item.id) === (job.batch_id ?? job.id));
    const next = selectListItem(eligible.map(item => item.id), new Set(selected), selectionAnchor.current, job.id, modifiers, true);
    selectionAnchor.current = next.anchor;
    setSelected([...next.selected]);
  };
  const startSelection = () => { setSelecting(true); setMessage(''); };
  const exitSelection = () => {
    setSelecting(false); setSelected([]); selectionAnchor.current = null; setCancelError(''); setEmailFormInView(false);
  };
  const sendCancellation = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true); setCancelError(''); setMessage('');
    try {
      const response = await fetch('/api/cancellations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selected, email }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not request cancellation. Please try again.');
      setMessage(body.message); exitSelection(); setEmail('');
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'Could not send the cancellation link. Please try again.');
    } finally { setSending(false); }
  };

  const groupBuckets = new Map<string, PublicJob[]>();
  for (const job of jobs) {
    const key = getBatchKey(job);
    if (key) {
      if (!groupBuckets.has(key)) groupBuckets.set(key, []);
      groupBuckets.get(key)!.push(job);
    }
  }
  const groupSummaries = new Map<string, GroupStatusSummary>();
  for (const [key, list] of groupBuckets.entries()) {
    groupSummaries.set(key, summarizeGroupStatus(list));
  }

  const printing = jobs.filter(j => j.status === 'printing'), queued = jobs.filter(j => j.status === 'queued');
  return <>
    {error && <p className="notice" role="status">{error}</p>}
    <section className="printing-section" aria-labelledby="printing-heading">
      <div className="section-heading"><h2 id="printing-heading">Printing <span className="count">{printing.length}</span></h2></div>
      {printing.length ? <div className="printing-grid">{printing.map(job => {
        const groupLabel = effectiveGroupName(job);
        const batchKey = getBatchKey(job);
        const summary = batchKey ? groupSummaries.get(batchKey) : undefined;
        return (
          <article className="printing-card" key={job.id}>
            <div className="card-top"><h3>{job.title}</h3><span className="mono">#{reference(job.id)}</span></div>
            {groupLabel && (
              <div className="queue-group-meta">
                <span className="group-badge">{groupLabel}</span>
                {summary && summary.total > 1 && <span className="small muted">{summary.label}</span>}
              </div>
            )}
            <Settings job={job} />
          </article>
        );
      })}</div> : <div className="empty-state">No prints in progress.</div>}
    </section>
    <section aria-labelledby="queue-heading">
      <div className="section-heading queue-section-heading">
        <h2 id="queue-heading">Queued <span className="count">{queued.length}</span></h2>
        {!selecting && <button className="queue-cancel-button" type="button" disabled={!queued.length}
          onClick={startSelection}>Cancel prints</button>}
      </div>
      {selecting && <p id="cancel-selection-help" className="small muted">Select prints to cancel from one submission.</p>}
      {queued.length ? <ol className="queue-list">{queued.map((job, i) => {
        const groupLabel = effectiveGroupName(job);
        const batchKey = getBatchKey(job);
        const prevKey = i > 0 ? getBatchKey(queued[i - 1]) : null;
        const nextKey = i < queued.length - 1 ? getBatchKey(queued[i + 1]) : null;
        const inConnectedBatch = Boolean(batchKey && (batchKey === prevKey || batchKey === nextKey));
        const isBatchStart = Boolean(batchKey && batchKey !== prevKey && batchKey === nextKey);
        const isBatchEnd = Boolean(batchKey && batchKey === prevKey && batchKey !== nextKey);
        const summary = batchKey ? groupSummaries.get(batchKey) : undefined;

        return (
          <li
            key={job.id}
            className={inConnectedBatch ? `queue-batch-member${isBatchStart ? ' queue-batch-start' : ''}${isBatchEnd ? ' queue-batch-end' : ''}` : undefined}
          >
            {selecting && <input
              id={`cancel-${job.id}`}
              className="queue-cancel-checkbox"
              type="checkbox"
              checked={selected.includes(job.id)}
              disabled={sending || Boolean(submissionKey && (job.batch_id ?? job.id) !== submissionKey)}
              onChange={event => togglePrint(job, event.nativeEvent as MouseEvent)}
            />}
            <span className="queue-position">{i + 1}</span>
            <div className="queue-job">
              <div className="queue-job-header">
                <h3>{job.title}</h3>
                {groupLabel && (
                  <span className="group-badge">
                    {groupLabel}
                    {summary && summary.total > 1 ? ` · ${summary.total} prints` : ''}
                  </span>
                )}
              </div>
              <Settings job={job} />
              {selecting && job.batch_title && job.batch_title !== groupLabel && <div className="small muted">Submission: {job.batch_title}</div>}
              <div className="small muted extra-settings">
                Supports: {job.supports === 'operator' ? 'operator decides' : job.supports}
                {summary && summary.total > 1 && summary.mixed ? ` · Batch status: ${summary.label}` : ''}
              </div>
            </div>
            <span className="mono small muted">#{reference(job.id)}</span>
            {selecting && <label className="queue-cancel-target" htmlFor={`cancel-${job.id}`}
              onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}
              onClick={event => { event.preventDefault(); togglePrint(job, event); }}>
              <span className="sr-only">Select {job.title} (#{reference(job.id)}) for cancellation</span>
            </label>}
          </li>
        );
      })}</ol> : <div className="empty-state">No queued prints.</div>}
      {!selecting && <div className="queue-footer-actions">
        <button className="queue-cancel-button" type="button" disabled={!queued.length} onClick={startSelection}>Cancel prints</button>
      </div>}
      {selecting && <div className={`queue-selection-bar${emailFormInView ? ' is-docked' : ''}`} role="region" aria-label="Print cancellation selection">
        <div className="queue-selection-summary">
          <div className="queue-selection-count">
            <span role="status">{emailFormInView ? `Cancel ${selected.length} ${selected.length === 1 ? 'print' : 'prints'}` : `${selected.length} selected`}</span>
            {selected.length > 0 && <button className="text-button" type="button" disabled={sending}
              onClick={() => { setSelected([]); selectionAnchor.current = null; setCancelError(''); }} aria-label="Clear selection">Clear</button>}
          </div>
          {selectedJob?.batch_id && <button className="text-button" type="button" disabled={sending}
            onClick={() => { setSelected(submissionJobs.map(job => job.id)); setCancelError(''); }}>Select whole group</button>}
        </div>
        <div className="queue-continue-action" inert={emailFormInView} aria-hidden={emailFormInView}>
          <button className="button primary" type="button" disabled={sending || !selected.length} onClick={focusEmail}>Continue to email</button>
        </div>
        <button className="queue-selection-exit" type="button" disabled={sending} onClick={exitSelection} aria-label="Exit selection" title="Exit selection">×</button>
      </div>}
      {selecting && <div className="queue-cancellation" ref={emailForm}>
        <form onSubmit={sendCancellation} aria-label="Cancel selected prints">
          <fieldset disabled={sending}>
            <div className="queue-cancel-submit">
              <div className="queue-cancel-email">
                <label htmlFor="cancellation-email">Submission email</label>
                <input id="cancellation-email" ref={emailInput} type="email" autoComplete="email" required maxLength={254}
                  placeholder="you@purdue.edu" value={email} onChange={event => { setEmail(event.target.value); setCancelError(''); }} />
              </div>
              <button className="button primary" type="submit" disabled={!selected.length}>{sending ? 'Sending…' : 'Email cancellation link'}</button>
            </div>
            <p className="small muted queue-cancel-note">Prints stay queued until you confirm by email.</p>
          </fieldset>
          {cancelError && <p className="notice error" role="alert">{cancelError}</p>}
        </form>
      </div>}
      {message && <p className="notice" role="status" ref={receipt}>{message}</p>}
    </section>
    <p className="small muted queue-refresh">Updates every 15 seconds.</p>
  </>;
}
