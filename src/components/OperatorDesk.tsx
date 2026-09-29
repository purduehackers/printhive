import React, { useState } from 'react';
import { Play, CheckCircle2, Download, XCircle, AlertCircle, Send, RefreshCw, Eye, Sparkles } from 'lucide-react';
import { formatSettingDisplay, type QueueResponse, type PrintJob } from '../types';

interface OperatorDeskProps {
  queueData: QueueResponse | null;
  onRefresh: () => void;
}

export const OperatorDesk: React.FC<OperatorDeskProps> = ({ queueData, onRefresh }) => {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'queued' | 'printing' | 'completed'>('all');
  const [notificationToast, setNotificationToast] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<PrintJob | null>(null);

  const allJobs = queueData?.all || [];
  const filteredJobs = allJobs.filter((j) => (filter === 'all' ? true : j.status === filter));

  const handleUpdateStatus = async (jobId: string, newStatus: 'queued' | 'printing' | 'completed' | 'cancelled') => {
    setUpdatingId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      const data = await res.json();
      if (res.ok) {
        onRefresh();
        if (data.notificationSent) {
          setNotificationToast(`✓ Print marked as completed! Notification email dispatched to ${data.job.email}`);
          setTimeout(() => setNotificationToast(null), 6000);
        }
      } else {
        alert(data.error || 'Failed to update job status.');
      }
    } catch (err) {
      alert('Network error updating status.');
    } finally {
      setUpdatingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'printing':
        return (
          <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-mono font-bold flex items-center gap-1.5 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            PRINTING
          </span>
        );
      case 'queued':
        return (
          <span className="px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs font-mono font-bold">
            QUEUED
          </span>
        );
      case 'completed':
        return (
          <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono font-bold flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            COMPLETED
          </span>
        );
      case 'cancelled':
        return (
          <span className="px-2.5 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono font-bold">
            CANCELLED
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-2">
            <span>Operator & Staff Desk</span>
            <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-[#CEB888] border border-amber-500/20">
              Staff Only
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage print jobs, advance the queue, download STL files for slicing, and notify students upon print completion.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Desk</span>
          </button>
        </div>
      </div>

      {/* Notification Toast */}
      {notificationToast && (
        <div className="bg-emerald-950/80 border border-emerald-500/40 text-emerald-200 px-4 py-3 rounded-xl flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Send className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{notificationToast}</span>
          </div>
          <button
            onClick={() => setNotificationToast(null)}
            className="text-emerald-400 hover:text-emerald-200 text-xs font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {(['all', 'queued', 'printing', 'completed'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase font-mono tracking-wider transition-all ${
              filter === tab
                ? 'bg-[#CEB888] text-slate-950 shadow-md'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab} ({tab === 'all' ? allJobs.length : allJobs.filter((j) => j.status === tab).length})
          </button>
        ))}
      </div>

      {/* Jobs Table / List */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden backdrop-blur-sm shadow-xl">
        {filteredJobs.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">
            No print jobs match the selected filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {filteredJobs.map((job) => (
              <div
                key={job.id}
                className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-800/30 transition-colors"
              >
                {/* Job Info */}
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {getStatusBadge(job.status)}
                    <h3 className="text-base font-bold text-slate-100 truncate">{job.title}</h3>
                    <span className="text-[11px] font-mono text-slate-400">ID: {job.id}</span>
                  </div>

                  <p className="text-xs text-slate-400 font-mono">
                    Student: <strong className="text-slate-200">{job.email}</strong> · File: {job.fileName} (
                    {(job.fileSize / 1024).toFixed(1)} KB)
                  </p>

                  {/* Non-Default Settings Diff */}
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className="text-[11px] text-slate-400 font-mono">Overrides:</span>
                    {Object.keys(job.settingsDiff || {}).length > 0 ? (
                      Object.entries(job.settingsDiff).map(([k, v]) => {
                        const item = formatSettingDisplay(k, v);
                        return (
                          <span
                            key={k}
                            className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[#CEB888] font-mono text-[10px] font-bold"
                          >
                            ⚡ {item.label}: {item.value}
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-[10px] text-slate-500 font-mono">Standard Defaults</span>
                    )}
                  </div>

                  {job.notes && (
                    <p className="text-xs text-slate-300 italic bg-slate-950/40 px-2.5 py-1 rounded-md border border-slate-800/80">
                      Note: "{job.notes}"
                    </p>
                  )}
                </div>

                {/* Operator Actions */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* Download STL */}
                  <a
                    href={`/api/jobs/${job.id}/file`}
                    download={job.fileName}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold rounded-lg border border-slate-700 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5 text-[#CEB888]" />
                    <span>Download STL</span>
                  </a>

                  {/* If Queued: Start Printing button */}
                  {job.status === 'queued' && (
                    <button
                      onClick={() => handleUpdateStatus(job.id, 'printing')}
                      disabled={updatingId === job.id}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 text-xs font-bold rounded-lg transition-all shadow-md shadow-amber-500/10"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Start Printing</span>
                    </button>
                  )}

                  {/* If Printing: Mark Completed button (Triggers email notification!) */}
                  {job.status === 'printing' && (
                    <button
                      onClick={() => handleUpdateStatus(job.id, 'completed')}
                      disabled={updatingId === job.id}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-all shadow-md shadow-emerald-500/20"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Mark Done & Notify Student</span>
                    </button>
                  )}

                  {/* If Completed: Re-queue button */}
                  {job.status === 'completed' && (
                    <button
                      onClick={() => handleUpdateStatus(job.id, 'queued')}
                      disabled={updatingId === job.id}
                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs font-medium rounded-lg border border-slate-700 transition-colors"
                    >
                      Re-queue
                    </button>
                  )}

                  {/* Cancel / Reject */}
                  {job.status !== 'cancelled' && job.status !== 'completed' && (
                    <button
                      onClick={() => {
                        if (confirm(`Are you sure you want to cancel ${job.title}?`)) {
                          handleUpdateStatus(job.id, 'cancelled');
                        }
                      }}
                      disabled={updatingId === job.id}
                      className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Cancel print job"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
};
