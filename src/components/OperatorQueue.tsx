import { useState, useEffect, useRef, type SubmitEvent } from 'react';
import SlicerControls from './SlicerControls';
import {
  effectiveGroupName,
  reference,
  resolveColor,
  sortJobs,
  summarizeGroupStatus,
  type Job,
  type SortOption,
  type Status,
} from '../lib/shared';

interface OperatorQueueProps {
  initialJobs: Job[];
  filter?: string;
  page?: number;
  revision?: string;
}

type GroupByOption = 'none' | 'custom' | 'batch' | 'material-color' | 'status' | 'submitter';

const STORAGE_KEY = 'printhive_operator_custom_groups';

export default function OperatorQueue({ initialJobs, filter = 'all', page = 1, revision = '' }: OperatorQueueProps) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  const [sortBy, setSortBy] = useState<SortOption>('queue');
  const [customGroups, setCustomGroups] = useState<Record<string, string[]>>({});
  const [isGroupingModalOpen, setGroupingModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [batchStatus, setBatchStatus] = useState<Status | ''>('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const query = new URLSearchParams({ status: filter, page: String(page) });
        const response = await fetch(`/api/operator/queue?${query}`, { signal: controller.signal });
        if (response.status === 401) { setSessionExpired(true); return; }
        if (!response.ok) return;
        const result = await response.json();
        if (result.revision !== revision || JSON.stringify(result.jobs) !== JSON.stringify(initialJobs)) setUpdateAvailable(true);
      } catch { /* Keep the existing queue usable through temporary connection failures. */ }
      finally { refreshing = false; }
    };
    const onMessage = (event: MessageEvent) => { if (event.data?.type === 'printhive:queue-updated') void refresh(); };
    const interval = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => {
      controller.abort(); clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [filter, page, revision, initialJobs]);

  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  // Load custom groups from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          setCustomGroups(parsed);
        }
      }
    } catch {
      // LocalStorage not available or invalid
    }
  }, []);

  // Save custom groups to localStorage
  const saveCustomGroups = (updated: Record<string, string[]>) => {
    setCustomGroups(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore storage errors
    }
  };

  // Find effective group name for a given job (operator custom group or batch submission group)
  const getJobGroupName = (job: Job): string | null => {
    for (const [name, ids] of Object.entries(customGroups)) {
      if (ids.includes(job.id)) return name;
    }
    return effectiveGroupName(job);
  };

  const getGroupJobIds = (groupName: string): string[] =>
    jobs.filter(j => getJobGroupName(j) === groupName).map(j => j.id);

  // Selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === jobs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(jobs.map(j => j.id)));
    }
  };

  const selectAllInView = () => {
    setSelectedIds(new Set(jobs.map(j => j.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBatchStatus('');
    setFeedback('');
    setGroupingModalOpen(false);
  };

  const selectGroup = (groupJobIds: string[]) => {
    const allSelected = groupJobIds.length > 0 && groupJobIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        groupJobIds.forEach(id => next.delete(id));
      } else {
        groupJobIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const openGroupStatus = (groupJobIds: string[]) => {
    setSelectedIds(new Set(groupJobIds));
  };

  const downloadJobFiles = (jobIds: string[]) => {
    jobIds.forEach((id, idx) => {
      setTimeout(() => {
        const job = jobs.find(j => j.id === id);
        const safeStem = (job?.original_filename ?? 'part.stl')
          .replace(/\.stl$/i, '')
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80) || 'part';
        const link = document.createElement('a');
        link.href = `/api/jobs/${id}/file`;
        link.download = `printhive-${reference(id)}-${safeStem}.stl`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, idx * 150);
    });
  };

  // Update header checkbox indeterminate state
  useEffect(() => {
    if (headerCheckboxRef.current) {
      const count = selectedIds.size;
      const total = jobs.length;
      headerCheckboxRef.current.indeterminate = count > 0 && count < total;
    }
  }, [selectedIds, jobs]);

  const applyGroupAssignment = (name: string, idsToAdd: string[]) => {
    const trimmed = name.trim();
    if (!trimmed || !idsToAdd.length) return;

    const idSet = new Set(idsToAdd);
    setJobs(prev => prev.map(j => idSet.has(j.id) ? { ...j, group_name: trimmed } : j));

    const updated = { ...customGroups };
    for (const key of Object.keys(updated)) {
      updated[key] = updated[key].filter(id => !idSet.has(id));
      if (updated[key].length === 0) delete updated[key];
    }
    updated[trimmed] = Array.from(new Set([...(updated[trimmed] || []), ...idsToAdd]));
    saveCustomGroups(updated);
    setNewGroupName('');
    setGroupingModalOpen(false);
    setGroupBy('custom');
    setNotice({
      type: 'success',
      message: `Group "${trimmed}" created with ${idsToAdd.length} print${idsToAdd.length === 1 ? '' : 's'}.`,
    });

    fetch('/api/jobs/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: idsToAdd, group_name: trimmed }),
    }).catch(() => {});
  };

  // Create custom group from selection
  const handleCreateGroup = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    const idsToAdd = Array.from(selectedIds);
    if (!idsToAdd.length) return;
    applyGroupAssignment(name, idsToAdd);
  };

  const ungroup = (groupName: string) => {
    const targetIds = getGroupJobIds(groupName);
    const idSet = new Set(targetIds);
    setJobs(prev => prev.map(j => idSet.has(j.id) ? { ...j, group_name: null } : j));

    const updated = { ...customGroups };
    delete updated[groupName];
    for (const key of Object.keys(updated)) {
      updated[key] = updated[key].filter(id => !idSet.has(id));
      if (updated[key].length === 0) delete updated[key];
    }
    saveCustomGroups(updated);
    setNotice({
      type: 'success',
      message: `Group "${groupName}" disbanded.`,
    });

    fetch('/api/jobs/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: targetIds, group_name: groupName, ungroup: true }),
    }).catch(() => {});
  };

  // Batch status update submission
  const handleBatchSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!batchStatus || selectedIds.size === 0) return;

    const selectedJobs = jobs.filter(j => selectedIds.has(j.id));
    if (!selectedJobs.length) return;

    const returning = batchStatus === 'rejected';
    if (returning && !feedback.trim()) {
      setNotice({ type: 'error', message: 'Provide feedback before rejecting and returning prints.' });
      return;
    }

    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch('/api/jobs/batch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selectedJobs.map(j => ({ id: j.id, version: j.version })),
          status: batchStatus,
          feedback: returning ? feedback.trim() : '',
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Could not update status for group.');
      }

      // Update local jobs with results
      if (Array.isArray(result.updated) && result.updated.length > 0) {
        const updatedMap = new Map<string, Job>(result.updated.map((j: Job) => [j.id, j]));
        setJobs(prev => prev.map(j => updatedMap.get(j.id) ?? j));
      }

      // Build message
      const updatedCount = result.updated?.length || 0;
      const errorCount = result.errors?.length || 0;
      const warningCount = result.warnings?.length || 0;

      if (errorCount > 0) {
        const errorDetails = result.errors.map((e: { id: string; error: string }) => {
          const job = jobs.find(j => j.id === e.id);
          return `${job?.title || reference(e.id)}: ${e.error}`;
        });
        setNotice({
          type: 'warning',
          message: `Updated ${updatedCount} print(s), but ${errorCount} could not be updated: ${errorDetails.join('; ')}`,
        });
      } else if (warningCount > 0) {
        setNotice({
          type: 'warning',
          message: `Status updated for ${updatedCount} print(s), but some email notifications failed: ${result.warnings.join('; ')}`,
        });
      } else {
        setNotice({
          type: 'success',
          message: `Successfully updated status to "${batchStatus}" for ${updatedCount} print(s).`,
        });
      }

      clearSelection();
    } catch (err: any) {
      setNotice({
        type: 'error',
        message: err.message || 'An error occurred while updating status.',
      });
    } finally {
      setBusy(false);
    }
  };

  const sortedJobs = sortJobs(jobs, sortBy, getJobGroupName);

  // Collect all active group names for quick assignment
  const existingGroupNames = Array.from(
    new Set(
      jobs
        .map(j => getJobGroupName(j))
        .filter((name): name is string => Boolean(name)),
    ),
  );

  // Group definitions
  type GroupBucket = {
    key: string;
    title: string;
    colorSwatch?: string;
    jobs: Job[];
    isCustom?: boolean;
    customGroupName?: string;
    isBatch?: boolean;
  };

  const getGroupedData = (): GroupBucket[] => {
    if (groupBy === 'material-color') {
      const map = new Map<string, Job[]>();
      for (const job of sortedJobs) {
        const key = `${job.material ?? 'PLA'} · ${job.color}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(job);
      }
      return Array.from(map.entries()).map(([key, groupJobs]) => ({
        key,
        title: key,
        colorSwatch: groupJobs[0]?.color,
        jobs: groupJobs,
      }));
    }

    if (groupBy === 'custom') {
      const buckets: GroupBucket[] = [];
      const map = new Map<string, Job[]>();
      const ungroupedJobs: Job[] = [];

      for (const job of sortedJobs) {
        const groupName = getJobGroupName(job);
        if (groupName) {
          if (!map.has(groupName)) map.set(groupName, []);
          map.get(groupName)!.push(job);
        } else {
          ungroupedJobs.push(job);
        }
      }

      for (const [groupName, groupJobs] of map.entries()) {
        const isBatch = groupJobs.every(j => Boolean(j.batch_id) && j.batch_id === groupJobs[0].batch_id);
        buckets.push({
          key: `custom_${groupName}`,
          title: groupName,
          jobs: groupJobs,
          isCustom: true,
          customGroupName: groupName,
          isBatch,
        });
      }

      if (ungroupedJobs.length > 0) {
        buckets.push({
          key: 'custom_ungrouped',
          title: 'Ungrouped',
          jobs: ungroupedJobs,
        });
      }

      return buckets;
    }

    if (groupBy === 'batch') {
      const buckets: GroupBucket[] = [];
      const map = new Map<string, Job[]>();
      const singleJobs: Job[] = [];

      for (const job of sortedJobs) {
        if (job.batch_id) {
          if (!map.has(job.batch_id)) map.set(job.batch_id, []);
          map.get(job.batch_id)!.push(job);
        } else {
          singleJobs.push(job);
        }
      }

      for (const [batchId, batchJobs] of map.entries()) {
        const label = batchJobs[0]?.batch_title || getJobGroupName(batchJobs[0]) || `Batch #${reference(batchId)}`;
        buckets.push({
          key: `batch_${batchId}`,
          title: label,
          jobs: batchJobs,
          isBatch: true,
          isCustom: Boolean(getJobGroupName(batchJobs[0])),
          customGroupName: getJobGroupName(batchJobs[0]) ?? undefined,
        });
      }

      if (singleJobs.length > 0) {
        buckets.push({
          key: 'batch_single',
          title: 'Individual Submissions',
          jobs: singleJobs,
        });
      }

      return buckets;
    }

    if (groupBy === 'status') {
      const map = new Map<string, Job[]>();
      for (const job of sortedJobs) {
        const key = job.status;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(job);
      }
      return Array.from(map.entries()).map(([key, groupJobs]) => ({
        key,
        title: key.toUpperCase(),
        jobs: groupJobs,
      }));
    }

    if (groupBy === 'submitter') {
      const map = new Map<string, Job[]>();
      for (const job of sortedJobs) {
        const key = job.email;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(job);
      }
      return Array.from(map.entries()).map(([key, groupJobs]) => ({
        key: `submitter_${key}`,
        title: key,
        jobs: groupJobs,
      }));
    }

    // Default flat list
    return [{
      key: 'all',
      title: 'All Prints',
      jobs: sortedJobs,
    }];
  };

  const groups = getGroupedData();
  const allSelected = jobs.length > 0 && selectedIds.size === jobs.length;
  const selectedJobsList = jobs.filter(j => selectedIds.has(j.id));
  const recipientCount = new Set(selectedJobsList.map(j => j.email.toLowerCase())).size;

  return (
    <div>
      {sessionExpired ? <div className="queue-update-banner" role="status">Your session expired. <a href="/operator/login">Sign in again</a></div> : updateAvailable && (
        <div className="queue-update-banner" role="status">
          <span>New or updated prints available.</span>
          <button className="button secondary" disabled={busy} onClick={() => window.location.reload()}>Refresh queue</button>
        </div>
      )}
      {/* Notice display */}
      {notice && (
        <div className={`notice ${notice.type === 'error' || notice.type === 'warning' ? 'error' : ''}`} role="status">
          {notice.message}
        </div>
      )}

      {/* Batch / Group Status Update Panel */}
      {selectedIds.size > 0 && (
        <div className="batch-update-panel" role="region" aria-label="Group status actions">
          <div className="batch-update-header">
            <div>
              <h3>
                <strong>{selectedIds.size}</strong> print{selectedIds.size === 1 ? '' : 's'} selected
              </h3>
              <p className="small muted">
                Update status for all selected prints together ({recipientCount} notification email{recipientCount === 1 ? '' : 's'} will be sent).
              </p>
            </div>
            <div className="selection-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => downloadJobFiles(Array.from(selectedIds))}
                disabled={busy}
              >
                Download selected STLs ↓
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setGroupingModalOpen(prev => !prev)}
                disabled={busy}
              >
                {isGroupingModalOpen ? 'Cancel group' : 'Group selected'}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={clearSelection}
                disabled={busy}
              >
                Clear selection
              </button>
            </div>
          </div>

          <SlicerControls jobs={jobs.filter(job => selectedIds.has(job.id))} />

          {/* Group Creation Inline Form */}
          {isGroupingModalOpen && (
            <div className="group-create-card">
              <h4>Create or assign custom group</h4>
              <p className="small muted">Group these {selectedIds.size} print(s) under a shared name (e.g. Bed 1, Batch A).</p>
              <form onSubmit={handleCreateGroup} className="group-create-form">
                <input
                  type="text"
                  placeholder="Group name (e.g. Bed 1)"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  maxLength={200}
                  required
                  autoFocus
                />
                <button type="submit" className="button primary">Save group</button>
                <button type="button" className="button secondary" onClick={() => setGroupingModalOpen(false)}>Cancel</button>
              </form>
              {existingGroupNames.length > 0 && (
                <div className="existing-groups-row">
                  <span className="small muted">Add to existing group:</span>
                  {existingGroupNames.map(name => (
                    <button
                      key={name}
                      type="button"
                      className="group-badge group-badge-button"
                      onClick={() => applyGroupAssignment(name, Array.from(selectedIds))}
                    >
                      + {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Status Update Form */}
          <form onSubmit={handleBatchSubmit} className="batch-update-form">
            <div className="batch-update-row">
              <label htmlFor="batch-status-select" className="sr-only">New status for selected prints</label>
              <select
                id="batch-status-select"
                value={batchStatus}
                onChange={e => setBatchStatus(e.target.value as Status)}
                disabled={busy}
              >
                <option value="">Select new status…</option>
                <option value="printing">Mark as Printing</option>
                <option value="completed">Mark as Completed</option>
                <option value="failed">Mark as Failed</option>
                <option value="canceled">Mark as Canceled</option>
                <option value="rejected">Reject and return with feedback</option>
                <option value="queued">Requeue at the end of the line</option>
              </select>
              <button
                type="submit"
                className="button primary"
                disabled={busy || !batchStatus || (batchStatus === 'rejected' && !feedback.trim())}
              >
                {busy ? 'Updating status…' : `Update status for ${selectedIds.size} print(s)`}
              </button>
            </div>
            {batchStatus === 'rejected' && (
              <div className="batch-feedback-area">
                <label htmlFor="batch-feedback">
                  Feedback for submitters <span className="muted small">(required)</span>
                </label>
                <textarea
                  id="batch-feedback"
                  value={feedback}
                  onChange={e => setFeedback(e.target.value)}
                  required
                  maxLength={5000}
                  rows={3}
                  placeholder="Explain why these prints are being returned (will be emailed to submitters so they can submit a revised STL)..."
                  disabled={busy}
                />
              </div>
            )}
          </form>
        </div>
      )}

      {/* Toolbar above table */}
      <div className="operator-queue-bar">
        <div className="queue-view-controls">
          <div className="group-view-select">
            <label htmlFor="group-by-select">Group by:</label>
            <select
              id="group-by-select"
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as GroupByOption)}
            >
              <option value="none">None (flat list)</option>
              <option value="custom">Custom &amp; Batch Groups</option>
              <option value="batch">Batch Submissions</option>
              <option value="material-color">Material &amp; Colour</option>
              <option value="status">Status</option>
              <option value="submitter">Submitter</option>
            </select>
          </div>
          <div className="group-view-select">
            <label htmlFor="sort-by-select">Sort by:</label>
            <select
              id="sort-by-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value as SortOption)}
            >
              <option value="queue">Queue order</option>
              <option value="group">Group / Batch</option>
              <option value="status">Status</option>
              <option value="material-color">Material &amp; Colour</option>
              <option value="submitter">Submitter</option>
              <option value="title">Title (A–Z)</option>
              <option value="newest">Newest first</option>
            </select>
          </div>
        </div>
        <div className="selection-actions">
          {selectedIds.size > 0 ? (
            <>
              <span className="small muted"><strong>{selectedIds.size}</strong> selected</span>
              <button type="button" className="text-button" onClick={clearSelection}>Clear selection</button>
            </>
          ) : (
            <button type="button" className="text-button" onClick={selectAllInView}>Select all in view</button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="table-wrap">
        <table className="operator-queue-table">
          <thead>
            <tr>
              <th className="selection-cell">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={headerCheckboxRef}
                  onChange={toggleSelectAll}
                  aria-label="Select all prints"
                />
              </th>
              <th>Print</th>
              <th>Submitter</th>
              <th>Settings</th>
              <th>Status</th>
              <th><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          {groups.map(group => {
            const showGroupHeader = groupBy !== 'none';
            const groupJobIds = group.jobs.map(j => j.id);
            const allGroupSelected = groupJobIds.length > 0 && groupJobIds.every(id => selectedIds.has(id));
            const statusSummary = summarizeGroupStatus(group.jobs);

            return (
              <tbody key={group.key}>
                {showGroupHeader && (
                  <tr className="group-header-row">
                    <td colSpan={6}>
                      <div className="group-section-header">
                        <div className="group-title-info">
                          {group.colorSwatch && (
                            <i
                              className={`swatch ${group.colorSwatch.toLowerCase()}`}
                              style={{ backgroundColor: resolveColor(group.colorSwatch) }}
                            />
                          )}
                          <span>{group.title}</span>
                          {group.isBatch && <span className="batch-origin-tag">Batch</span>}
                          <span className="muted small">
                            ({group.jobs.length} {group.jobs.length === 1 ? 'print' : 'prints'})
                          </span>
                          <span className={`status ${statusSummary.status}`} title="Group status summary">
                            {statusSummary.label}
                          </span>
                        </div>
                        <div className="group-actions">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => downloadJobFiles(groupJobIds)}
                          >
                            Download group STLs ↓
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => selectGroup(groupJobIds)}
                          >
                            {allGroupSelected ? 'Deselect group' : 'Select group'}
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => openGroupStatus(groupJobIds)}
                          >
                            Update group status
                          </button>
                          {group.isCustom && group.customGroupName && (
                            <button
                              type="button"
                              className="text-button remove-operator"
                              onClick={() => ungroup(group.customGroupName!)}
                            >
                              Ungroup
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                {group.jobs.map(job => {
                  const isSelected = selectedIds.has(job.id);
                  const jobGroupName = getJobGroupName(job);
                  const groupMemberIds = jobGroupName ? getGroupJobIds(jobGroupName) : [];

                  return (
                    <tr key={job.id} className={isSelected ? 'selected-row' : ''}>
                      <td className="selection-cell">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(job.id)}
                          aria-label={`Select ${job.title}`}
                        />
                      </td>
                      <td>
                        <div className="operator-print-summary">
                          <span className="operator-print-artwork" aria-hidden="true">
                            {Boolean(job.has_thumbnail) && <img className="operator-print-thumbnail" src={`/api/print-thumbnails/${job.id}`} width={36} height={36} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />}
                          </span>
                          <div className="operator-print-details">
                            <a className="job-title" href={`/operator/jobs/${job.id}`}>{job.title}</a>
                            <span className="mono small muted">#{reference(job.id)}</span>
                            {jobGroupName && (
                              <button
                                type="button"
                                className="group-badge group-badge-button"
                                onClick={() => selectGroup(groupMemberIds)}
                                aria-label={`Select group ${jobGroupName}`}
                                title={`Click to select all ${groupMemberIds.length} print(s) in "${jobGroupName}"`}
                              >
                                {jobGroupName}
                                {groupMemberIds.length > 1 ? ` (${groupMemberIds.length})` : ''}
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{job.email}</td>
                      <td>
                        {job.material ?? 'PLA'} · {job.color} · {job.copies}×<br />
                        <span className="muted small">{job.layer_height} mm · {job.infill}%</span>
                      </td>
                      <td><span className={`status ${job.status}`}>{job.status}</span></td>
                      <td><a href={`/operator/jobs/${job.id}`} aria-label={`Manage ${job.title}`}>Manage →</a></td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
        {!jobs.length && <div className="empty-state">No confirmed prints in this view.</div>}
      </div>
    </div>
  );
}
