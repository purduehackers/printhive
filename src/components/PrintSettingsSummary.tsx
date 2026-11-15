import { resolveColor, supportLabel, type PrintSettings } from '../lib/shared';

export default function PrintSettingsSummary({ job, colorCode }: { job: PrintSettings; colorCode?: string }) {
  return <>
    <div className="job-settings">
      <span>{job.material ?? 'PLA'}</span>
      <span>
        <i className="swatch" style={{ backgroundColor: resolveColor(job.color, colorCode) }} aria-hidden="true" />
        {job.color}
      </span>
      <span>{job.layer_height} mm</span>
      <span>{job.infill}% infill</span>
      <span>{job.walls} walls</span>
      <span>{job.copies} {job.copies === 1 ? 'copy' : 'copies'}</span>
    </div>
    <div className="small muted extra-settings">Supports: {supportLabel(job.supports)}</div>
  </>;
}
