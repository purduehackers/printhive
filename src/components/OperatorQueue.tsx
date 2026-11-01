import { useState, useEffect, useRef, type SubmitEvent } from 'react';
import SlicerControls from './SlicerControls';
import PrintStatusSelect from './PrintStatusSelect';
import '../styles/operator-selection.css';
import {
  effectiveGroupName,
  reference,
  resolveColor,
  summarizeGroupStatus,
  STATUSES,
  transitions,
  type Job,
  type Status,
} from '../lib/shared';
import { operatorGroups, type OperatorGroupBy, type OperatorSortBy } from '../lib/operator-queue-view';
import { selectListItem, type SelectionModifiers } from '../lib/list-selection';

interface OperatorQueueProps {
  initialJobs: Job[];
  filter?: string;
  page?: number;
  revision?: string;
}

const STORAGE_KEY = 'printhive_operator_custom_groups';

export default function OperatorQueue({ initialJobs, filter = 'all', page = 1, revision = '' }: OperatorQueueProps) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<OperatorGroupBy>('none');
  const [sortBy, setSortBy] = useState<OperatorSortBy>('queue'), [reverseSort, setReverseSort] = useState(false);
  const [customGroups, setCustomGroups] = useState<Record<string, string[]>>({});
  const [activeAction, setActiveAction] = useState<'slicer' | 'group' | 'status' | null>(null);
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
  const selectionAnchor = useRef<string | null>(null);

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
  const toggleSelect = (id: string, modifiers: SelectionModifiers = {}, toggle = true) => {
    if (busy) return;
    setSelectedIds(prev => {
      const next = selectListItem(visibleIds, prev, selectionAnchor.current, id, modifiers, toggle);
      selectionAnchor.current = next.anchor;
      return next.selected;
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
    selectionAnchor.current = null;
    setSelectedIds(new Set());
    setBatchStatus('');
    setFeedback('');
    setActiveAction(null);
  };

  const selectGroup = (groupJobIds: string[]) => {
    if (busy) return;
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
    setActiveAction(null);
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

  const updateJobStatuses = async (targetJobs: Job[], next: Status, returnFeedback = '', clearAfter = false) => {
    if (busy || !targetJobs.length) return false;
    const returning = next === 'rejected';
    if (returning && !returnFeedback.trim()) {
      setNotice({ type: 'error', message: 'Provide feedback before rejecting and returning prints.' });
      return false;
    }

    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch('/api/jobs/batch-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: targetJobs.map(j => ({ id: j.id, version: j.version })),
          status: next,
          feedback: returning ? returnFeedback.trim() : '',
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
          message: `Updated ${updatedCount} ${updatedCount === 1 ? 'print' : 'prints'} to ${next}.`,
        });
      }

      if (clearAfter) clearSelection();
      return errorCount === 0;
    } catch (err: any) {
      setNotice({
        type: 'error',
        message: err.message || 'An error occurred while updating status.',
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleBatchSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!batchStatus || !availableStatuses.includes(batchStatus)) return;
    await updateJobStatuses(selectedJobs, batchStatus, feedback, true);
  };

  const statusTargets = (job: Job) => selectedIds.has(job.id) && selectedJobs.every(item => item.status === job.status)
    ? selectedJobs : [job];

  const existingGroupNames = [...new Set(jobs.map(getJobGroupName).filter((name): name is string => Boolean(name)))];
  const groups = operatorGroups(jobs, groupBy, sortBy, reverseSort, getJobGroupName);
  const visibleIds = groups.flatMap(group => group.jobs.map(job => job.id));
  const allSelected = jobs.length > 0 && selectedIds.size === jobs.length;
  const selectedJobs = jobs.filter(job => selectedIds.has(job.id));
  const availableStatuses = STATUSES.filter(status => selectedJobs.every(job =>
    job.status === status || transitions[job.status as Status]?.includes(status)));

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

      {/* Toolbar above table */}
      <div className="operator-queue-bar">
        <div className="queue-view-controls">
          <div className="group-view-select">
            <label htmlFor="group-by-select">Group by:</label>
            <select
              id="group-by-select"
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as OperatorGroupBy)}
            >
              <option value="none">None</option>
              <option value="custom">Named groups</option>
              <option value="batch">Submission</option>
              <option value="material-color">Filament</option>
              <option value="submitter">Submitter</option>
            </select>
          </div>
          <div className="group-view-select">
            <label htmlFor="sort-by-select">Sort by:</label>
            <select
              id="sort-by-select"
              value={sortBy}
              onChange={e => { setSortBy(e.target.value as OperatorSortBy); setReverseSort(false); }}
            >
              <option value="queue">Queue order</option>
              <option value="newest">Submission date</option>
              <option value="title">Print name</option>
              <option value="copies">Copies</option>
            </select>
          </div>
          {sortBy !== 'queue' && <button type="button" className="button secondary sort-direction"
            aria-label="Reverse sort order" onClick={() => setReverseSort(value => !value)}>
            <span aria-hidden="true">{reverseSort ? '↑' : '↓'}</span>
            {sortBy === 'title' ? reverseSort ? 'Z–A' : 'A–Z'
              : sortBy === 'newest' ? reverseSort ? 'Oldest first' : 'Newest first'
                : reverseSort ? 'Fewest first' : 'Most first'}
          </button>}
          {selectedIds.size === 0 && <div className="selection-actions">
            <button type="button" className="text-button" onClick={selectAllInView}>Select all in view</button>
          </div>}
        </div>
      </div>

      {/* Actions for selected prints */}
      {selectedIds.size > 0 && (
        <div className="batch-update-panel operator-selection-panel" role="region" aria-label="Selected print actions">
          <div className="operator-selection-toolbar">
            <h3>
              <strong>{selectedIds.size}</strong> print{selectedIds.size === 1 ? '' : 's'} selected
            </h3>
            <div className="operator-selection-operations" role="group" aria-label="File operations">
              <button
                type="button"
                className="button secondary"
                onClick={() => downloadJobFiles(Array.from(selectedIds))}
                disabled={busy}
              >
                Download STLs
              </button>
              <button type="button" className="button secondary" disabled={busy}
                aria-expanded={activeAction === 'slicer'} aria-controls="selection-slicer-panel"
                onClick={() => setActiveAction(current => current === 'slicer' ? null : 'slicer')}>Open in slicer</button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setActiveAction(current => current === 'group' ? null : 'group')}
                disabled={busy}
                aria-expanded={activeAction === 'group'}
                aria-controls="selection-group-panel"
              >
                Group selected
              </button>
              <button type="button" className="button secondary" disabled={busy}
                aria-expanded={activeAction === 'status'} aria-controls="selection-status-panel"
                onClick={() => setActiveAction(current => current === 'status' ? null : 'status')}>Change status</button>
            </div>
            <button type="button" className="button secondary operator-selection-clear" onClick={clearSelection} disabled={busy}>Clear selection</button>
          </div>

          <div id="selection-slicer-panel" className="operator-selection-details" hidden={activeAction !== 'slicer'}>
            <SlicerControls jobs={jobs.filter(job => selectedIds.has(job.id))} />
          </div>

          {/* Group Creation Inline Form */}
          {activeAction === 'group' && (
            <div id="selection-group-panel" className="group-create-card operator-selection-details">
              <form onSubmit={handleCreateGroup} className="group-create-form">
                <label className="operator-operation-field">
                  Group name
                  <input
                    type="text"
                    placeholder="Group name"
                    aria-label="Group name"
                    value={newGroupName}
                    onChange={e => setNewGroupName(e.target.value)}
                    maxLength={200}
                    required
                    autoFocus
                  />
                </label>
                <div className="operator-operation-submit">
                  <button type="submit" className="button primary">Save group</button>
                  <button type="button" className="button secondary" onClick={() => setActiveAction(null)}>Cancel</button>
                </div>
              </form>
              {existingGroupNames.length > 0 && (
                <div className="existing-groups-row">
                  <span className="small muted">Existing groups:</span>
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
          {activeAction === 'status' && <form id="selection-status-panel" onSubmit={handleBatchSubmit} className="batch-update-form operator-selection-details">
            <div className="batch-update-row">
              <label className="operator-operation-field" htmlFor="batch-status-select">Status
              <select
                id="batch-status-select"
                aria-label="New status for selected prints"
                value={batchStatus && availableStatuses.includes(batchStatus) ? batchStatus : ''}
                onChange={e => setBatchStatus(e.target.value as Status)}
                disabled={busy}
              >
                <option value="">{availableStatuses.length ? 'Select new status…' : 'No common status change'}</option>
                {availableStatuses.map(status => <option key={status} value={status}>
                  {status === 'rejected' ? 'Reject and return with feedback' : status === 'queued' ? 'Requeue at the end of the line'
                    : `Mark as ${status[0].toUpperCase() + status.slice(1)}`}
                </option>)}
              </select>
              </label>
              <button
                type="submit"
                className="button primary"
                disabled={busy || !batchStatus || !availableStatuses.includes(batchStatus) || (batchStatus === 'rejected' && !feedback.trim())}
              >
                {busy ? 'Updating…' : 'Update status'}
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
                  placeholder="Reason for return"
                  disabled={busy}
                />
              </div>
            )}
          </form>}
        </div>
      )}

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
                  disabled={busy}
                  onChange={toggleSelectAll}
                  aria-label="Select all prints"
                />
              </th>
              <th className="print-column-heading">Print</th>
              <th>Submitter</th>
              <th>Settings</th>
              <th>Status</th>
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
                    <td colSpan={5}>
                      <div className="group-section-header">
                        <div className="group-title-info">
                          <label className="operator-group-selection">
                            <input type="checkbox" checked={allGroupSelected} disabled={busy}
                              ref={input => { if (input) input.indeterminate = !allGroupSelected && groupJobIds.some(id => selectedIds.has(id)); }}
                              onChange={() => selectGroup(groupJobIds)} aria-label={`Select group ${group.title}`} />
                          {group.colorSwatch && (
                            <i
                              className={`swatch ${group.colorSwatch.toLowerCase()}`}
                              style={{ backgroundColor: resolveColor(group.colorSwatch) }}
                            />
                          )}
                          <span>{group.title}</span>
                          </label>
                          {group.isBatch && <span className="batch-origin-tag">Batch</span>}
                          <span className="muted small">
                            ({group.jobs.length} {group.jobs.length === 1 ? 'print' : 'prints'})
                          </span>
                          <span className={`status ${statusSummary.status}`} title="Group status summary">
                            {statusSummary.label}
                          </span>
                        </div>
                        <div className="group-actions">
                          {group.isCustom && group.customGroupName && (
                            <button
                              type="button"
                              className="text-button remove-operator"
                              disabled={busy}
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

                  return (
                    <tr key={job.id} className={`operator-print-row${isSelected ? ' selected-row' : ''}`}
                      onMouseDown={event => { if (event.shiftKey) event.preventDefault(); }}
                      onClick={event => {
                        if (!(event.target as HTMLElement).closest('a, button, input, select, textarea, label')) toggleSelect(job.id, event, false);
                      }}>
                      <td className="selection-cell">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={busy}
                          onClick={event => event.stopPropagation()}
                          onChange={event => toggleSelect(job.id, event.nativeEvent as MouseEvent)}
                          aria-label={`Select ${job.title}`}
                        />
                      </td>
                      <td>
                        <div className="operator-print-summary">
                          <span className="operator-print-artwork" aria-hidden="true">
                            {Boolean(job.has_thumbnail) && <img className="operator-print-thumbnail" src={`/api/print-thumbnails/${job.id}`} width={36} height={36} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />}
                          </span>
                          <div className="operator-print-details">
                            <a className="job-title" href={`/operator/jobs/${job.id}`} onClick={event => {
                              if (event.shiftKey || event.ctrlKey || event.metaKey) { event.preventDefault(); toggleSelect(job.id, event, false); }
                            }}>{job.title}</a>
                            <span className="mono small muted">#{reference(job.id)}</span>
                            {jobGroupName && (
                              <span className="group-badge">{jobGroupName}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{job.email}</td>
                      <td>
                        {job.material ?? 'PLA'} · {job.color} · {job.copies}×<br />
                        <span className="muted small">{job.layer_height} mm · {job.infill}% · {job.walls} walls</span>
                      </td>
                      <td><PrintStatusSelect title={job.title} status={job.status as Status} count={statusTargets(job).length} busy={busy}
                        onChange={(next, returnFeedback) => updateJobStatuses(statusTargets(job), next, returnFeedback)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
        {!jobs.length && <div className="empty-state">No prints in this view.</div>}
      </div>
    </div>
  );
}
