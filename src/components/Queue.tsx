import { useEffect, useState } from 'react';
import { reference, type PublicJob } from '../lib/shared';

function Settings({ job }: { job: PublicJob }) {
  return <div className="job-settings"><span><i className={`swatch ${job.color}`} />{job.color}</span><span>{job.layer_height} mm</span><span>{job.infill}% infill</span><span>{job.copies} {job.copies === 1 ? 'copy' : 'copies'}</span></div>;
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
  const printing = jobs.filter(j => j.status === 'printing'), queued = jobs.filter(j => j.status === 'queued');
  return <>
    <div className="queue-summary"><div><strong>{printing.length.toString().padStart(2, '0')}</strong><span>printing now</span></div><div><strong>{queued.length.toString().padStart(2, '0')}</strong><span>in the queue</span></div><p><span className="live-dot" />{error || 'Queue refreshes every 15 seconds'}</p></div>
    <section className="printing-section" aria-labelledby="printing-heading"><div className="section-heading"><h2 id="printing-heading">On the print bed</h2><span className="eyebrow">Happening now</span></div>
      {printing.length ? <div className="printing-grid">{printing.map(job => <article className="printing-card" key={job.id}><div className="card-top"><span className="status printing"><span className="live-dot" /> Printing</span><span className="mono">#{reference(job.id)}</span></div><h3>{job.title}</h3><Settings job={job} /><div className="layer-lines" aria-hidden="true" /><p className="muted small">The operator will email you when the status changes.</p></article>)}</div> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">◇</span><div><h3>The print beds are taking a breather.</h3><p>No jobs are printing right now. Confirmed prints appear below.</p></div></div>}
    </section>
    <section aria-labelledby="queue-heading"><div className="section-heading"><h2 id="queue-heading">Up next <span className="count">{queued.length}</span></h2><span className="eyebrow">First confirmed, first in line</span></div>
      {queued.length ? <ol className="queue-list">{queued.map((job, i) => <li key={job.id}><span className="queue-position">{String(i + 1).padStart(2, '0')}</span><div className="queue-job"><h3>{job.title}</h3><Settings job={job} /><div className="small muted extra-settings">Supports: {job.supports === 'operator' ? 'operator decides' : job.supports} · Mirror: {job.mirror ? 'yes' : 'no'}</div></div><div className="queue-meta"><span className="status queued">Queued</span><span className="mono small">#{reference(job.id)}</span></div></li>)}</ol> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">↗</span><div><h3>A little room for your next idea.</h3><p>The queue is empty. <a href="/submit">Submit a print</a> to get something started.</p></div></div>}
    </section>
  </>;
}
