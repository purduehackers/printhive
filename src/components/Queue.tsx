import { useEffect, useState } from 'react';
import { reference, resolveColor, type PublicJob } from '../lib/shared';

function Settings({ job }: { job: PublicJob }) {
  return <div className="job-settings"><span>{job.material ?? 'PLA'}</span><span><i className={`swatch ${job.color.toLowerCase()}`} style={{ backgroundColor: resolveColor(job.color) }} />{job.color}</span><span>{job.layer_height} mm</span><span>{job.infill}% infill</span><span>{job.copies} {job.copies === 1 ? 'copy' : 'copies'}</span></div>;
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
    {error && <p className="notice" role="status">{error}</p>}
    <section className="printing-section" aria-labelledby="printing-heading">
      <div className="section-heading"><h2 id="printing-heading">Printing <span className="count">{printing.length}</span></h2></div>
      {printing.length ? <div className="printing-grid">{printing.map(job => <article className="printing-card" key={job.id}>
        <div className="card-top"><h3>{job.title}</h3><span className="mono">#{reference(job.id)}</span></div>
        <Settings job={job} />
      </article>)}</div> : <div className="empty-state">No prints in progress.</div>}
    </section>
    <section aria-labelledby="queue-heading">
      <div className="section-heading"><h2 id="queue-heading">Queued <span className="count">{queued.length}</span></h2><span className="small muted">Ordered by confirmation time</span></div>
      {queued.length ? <ol className="queue-list">{queued.map((job, i) => <li key={job.id}>
        <span className="queue-position">{i + 1}</span>
        <div className="queue-job"><h3>{job.title}</h3><Settings job={job} /><div className="small muted extra-settings">Supports: {job.supports === 'operator' ? 'operator decides' : job.supports}</div></div>
        <span className="mono small muted">#{reference(job.id)}</span>
      </li>)}</ol> : <div className="empty-state">No queued prints.</div>}
    </section>
    <p className="small muted queue-refresh">Updates every 15 seconds.</p>
  </>;
}
