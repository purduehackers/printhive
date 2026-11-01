import { effectiveGroupName, reference, sortJobs, type Job } from './shared';

export type OperatorGroupBy = 'none' | 'custom' | 'batch' | 'material-color' | 'submitter';
export type OperatorSortBy = 'queue' | 'newest' | 'title' | 'copies';
export interface OperatorGroup {
  key: string;
  title: string;
  jobs: Job[];
  colorSwatch?: string;
  isCustom?: boolean;
  customGroupName?: string;
  isBatch?: boolean;
}

export function operatorGroups(
  jobs: readonly Job[], groupBy: OperatorGroupBy, sortBy: OperatorSortBy, reverse = false,
  groupName: (job: Job) => string | null = effectiveGroupName,
): OperatorGroup[] {
  const queue = sortJobs(jobs, 'queue'), queueRank = new Map(queue.map((job, index) => [job.id, index]));
  const ordered = sortBy === 'queue' ? queue : [...jobs].sort((a, b) => {
    const difference = sortBy === 'title' ? a.title.localeCompare(b.title, undefined, { numeric: true })
      : sortBy === 'copies' ? b.copies - a.copies : b.created_at - a.created_at;
    return (reverse ? -difference : difference) || queueRank.get(a.id)! - queueRank.get(b.id)!;
  });
  if (groupBy === 'none') return [{ key: 'all', title: 'All prints', jobs: ordered }];
  const groups = new Map<string, OperatorGroup>();
  for (const job of ordered) {
    const name = groupName(job);
    const key = groupBy === 'batch' ? job.batch_id ?? `single:${job.id}`
      : groupBy === 'custom' ? name === null ? 'ungrouped' : `named:${name}`
        : groupBy === 'submitter' ? job.email.toLowerCase() : `${job.material ?? 'PLA'} · ${job.color}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key: `${groupBy}:${key}`,
        title: groupBy === 'batch' ? job.batch_title || job.title
          : groupBy === 'custom' ? name ?? 'Ungrouped' : key,
        jobs: [],
        ...(groupBy === 'batch' && job.batch_id ? { isBatch: true } : {}),
        ...(groupBy === 'custom' && name ? { isCustom: true, customGroupName: name } : {}),
        ...(groupBy === 'material-color' ? { colorSwatch: job.color } : {}),
      });
    }
    groups.get(key)!.jobs.push(job);
  }
  const result = [...groups.values()];
  if (groupBy === 'custom' || groupBy === 'material-color' || groupBy === 'submitter') {
    result.sort((a, b) => (a.key === 'custom:ungrouped' ? 1 : b.key === 'custom:ungrouped' ? -1 : a.title.localeCompare(b.title)));
  }
  // Submission identity comes from its ID, even when two submissions have the same title.
  if (groupBy === 'batch') {
    const counts = new Map<string, number>();
    for (const group of result) counts.set(group.title, (counts.get(group.title) ?? 0) + 1);
    for (const group of result) {
      if (counts.get(group.title)! > 1) group.title += ` · #${reference(group.jobs[0].batch_id ?? group.jobs[0].id)}`;
    }
  }
  return result;
}
