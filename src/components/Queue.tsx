import { useEffect, useState } from 'react';
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
      <div className="section-heading"><h2 id="queue-heading">Queued <span className="count">{queued.length}</span></h2><span className="small muted">Ordered by confirmation time</span></div>
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
              <div className="small muted extra-settings">
                Supports: {job.supports === 'operator' ? 'operator decides' : job.supports}
                {summary && summary.total > 1 && summary.mixed ? ` · Batch status: ${summary.label}` : ''}
              </div>
            </div>
            <span className="mono small muted">#{reference(job.id)}</span>
          </li>
        );
      })}</ol> : <div className="empty-state">No queued prints.</div>}
    </section>
    <p className="small muted queue-refresh">Updates every 15 seconds.</p>
  </>;
}
