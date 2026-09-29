import React, { useEffect, useState } from 'react';
import { Clock, PlayCircle, CheckCircle2, RefreshCw, FileCode, Layers, Inbox, AlertCircle, ArrowUpRight } from 'lucide-react';
import { formatSettingDisplay, type QueueResponse, type PrintJob } from '../types';

interface LiveQueueProps {
  queueData: QueueResponse | null;
  onRefresh: () => void;
  loading: boolean;
  onGoToSubmit: () => void;
}

export const LiveQueue: React.FC<LiveQueueProps> = ({ queueData, onRefresh, loading, onGoToSubmit }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Timer for active print elapsed time
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const currentlyPrinting = queueData?.currentlyPrinting || [];
  const nextInQueue = queueData?.nextInQueue || [];
  const completed = queueData?.completed || [];

  const formatElapsed = (startIsoString: string) => {
    const start = new Date(startIsoString).getTime();
    if (isNaN(start)) return '0m';
    const diff = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const mins = Math.floor(diff / 60);
    const secs = diff % 60;
    return `${mins}m ${secs}s`;
  };

  const formatDate = (isoString: string) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  };

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 sm:px-6 space-y-10">
      
      {/* Top Header & Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-3">
            <span>Makerspace Print Queue</span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-time status of current prints, waiting jobs, and recently completed prints.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={onGoToSubmit}
            className="px-4 py-1.5 bg-[#CEB888] hover:bg-[#d6c499] text-slate-950 text-xs font-bold rounded-lg transition-all shadow-md shadow-amber-500/10"
          >
            + Add Print
          </button>
        </div>
      </div>

      {/* 1. Currently Printing Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-amber-400 animate-pulse"></span>
            <h2 className="text-lg font-bold text-white tracking-tight">Currently Printing</h2>
          </div>
          <span className="text-xs font-mono text-slate-400">
            {currentlyPrinting.length} active print{currentlyPrinting.length === 1 ? '' : 's'}
          </span>
        </div>

        {currentlyPrinting.length === 0 ? (
          <div className="bg-slate-900/30 border border-slate-800/80 rounded-2xl p-8 text-center backdrop-blur-sm">
            <div className="w-12 h-12 rounded-xl bg-slate-800/60 text-slate-400 flex items-center justify-center mx-auto mb-3">
              <PlayCircle className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-200">No Prints Currently Running</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              Printers are ready. The next queued job will be started by makerspace staff shortly.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {currentlyPrinting.map((job) => (
              <div
                key={job.id}
                className="bg-gradient-to-r from-amber-950/20 via-slate-900/50 to-slate-900/50 border-2 border-amber-500/40 rounded-2xl p-6 shadow-xl relative overflow-hidden backdrop-blur-md"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 animate-pulse">
                        <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                        Printing Now
                      </span>
                      <span className="text-xs font-mono text-slate-400">ID: {job.id}</span>
                    </div>

                    <div>
                      <h3 className="text-xl font-extrabold text-white tracking-tight">{job.title}</h3>
                      <p className="text-xs text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                        <span>Submitted by <strong className="text-slate-200">{job.email}</strong></span>
                        <span>·</span>
                        <span>{job.fileName}</span>
                      </p>
                    </div>

                    {/* Stored Non-Default Settings */}
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <span className="text-xs font-semibold text-slate-300">Settings:</span>
                      {Object.keys(job.settingsDiff || {}).length > 0 ? (
                        Object.entries(job.settingsDiff).map(([k, v]) => {
                          const item = formatSettingDisplay(k, v);
                          return (
                            <span
                              key={k}
                              className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[#CEB888] font-mono text-[11px] font-bold"
                            >
                              ⚡ {item.label}: {item.value}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-xs text-slate-500 font-mono">Standard Defaults</span>
                      )}
                    </div>

                    {job.notes && (
                      <p className="text-xs text-slate-300 bg-slate-950/60 p-2 rounded-lg border border-slate-800 italic">
                        "{job.notes}"
                      </p>
                    )}
                  </div>

                  <div className="flex flex-row md:flex-col items-start md:items-end justify-between border-t md:border-t-0 border-slate-800 pt-4 md:pt-0">
                    <div className="text-left md:text-right">
                      <span className="text-[11px] uppercase tracking-wider text-slate-400 font-mono block">Elapsed Time</span>
                      <span className="text-2xl font-mono font-extrabold text-amber-300">
                        {formatElapsed(job.updated || job.created)}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 mt-2 font-mono">
                      Started: {formatDate(job.updated || job.created)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Next in Queue Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-[#CEB888]" />
            <h2 className="text-lg font-bold text-white tracking-tight">Next in Queue</h2>
          </div>
          <span className="text-xs font-mono text-slate-400">
            {nextInQueue.length} job{nextInQueue.length === 1 ? '' : 's'} waiting
          </span>
        </div>

        {nextInQueue.length === 0 ? (
          <div className="bg-slate-900/30 border border-slate-800/80 rounded-2xl p-8 text-center backdrop-blur-sm">
            <div className="w-12 h-12 rounded-xl bg-slate-800/60 text-slate-400 flex items-center justify-center mx-auto mb-3">
              <Inbox className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-200">The Queue is Clear</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              No prints are waiting in line right now. Submit your model to be printed next!
            </p>
            <button
              onClick={onGoToSubmit}
              className="mt-4 px-4 py-2 rounded-lg bg-[#CEB888] text-slate-950 font-bold text-xs hover:bg-[#d6c499] transition-all"
            >
              Submit Your STL
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {nextInQueue.map((job, idx) => (
              <div
                key={job.id}
                className="bg-slate-900/50 border border-slate-800 hover:border-slate-700 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all"
              >
                <div className="flex items-start sm:items-center gap-4">
                  {/* Queue Position Pill */}
                  <div
                    className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center font-bold text-xs shrink-0 ${
                      idx === 0
                        ? 'bg-[#CEB888] text-slate-950 shadow-md shadow-amber-500/20'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    <span className="text-[9px] uppercase font-mono leading-none">pos</span>
                    <span className="text-sm font-extrabold font-mono">#{idx + 1}</span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-bold text-slate-100">{job.title}</h4>
                      {idx === 0 && (
                        <span className="px-2 py-0.2 rounded-full bg-amber-500/10 border border-amber-500/20 text-[#CEB888] text-[10px] font-bold font-mono">
                          NEXT UP
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-slate-400 font-mono">
                      {job.email} · {job.fileName} · {(job.fileSize / 1024).toFixed(1)} KB
                    </p>

                    {/* Non-Default Settings Pills */}
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                      {Object.keys(job.settingsDiff || {}).length > 0 ? (
                        Object.entries(job.settingsDiff).map(([k, v]) => {
                          const item = formatSettingDisplay(k, v);
                          return (
                            <span
                              key={k}
                              className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/80 text-amber-300 font-mono text-[10px]"
                            >
                              {item.label}: {item.value}
                            </span>
                          );
                        })
                      ) : (
                        <span className="text-[10px] text-slate-500 font-mono">Default settings</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-left sm:text-right shrink-0">
                  <span className="text-[11px] text-slate-400 font-mono block">Submitted</span>
                  <span className="text-xs font-mono text-slate-300 font-medium">
                    {formatDate(job.created)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Recently Completed Prints */}
      {completed.length > 0 && (
        <section className="space-y-4 pt-4 border-t border-slate-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <h2 className="text-lg font-bold text-white tracking-tight">Recently Completed Prints</h2>
            </div>
            <span className="text-xs font-mono text-slate-400">{completed.length} finished</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {completed.slice(0, 6).map((job) => (
              <div
                key={job.id}
                className="bg-slate-900/30 border border-slate-800/60 rounded-xl p-4 space-y-2 backdrop-blur-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 truncate max-w-[180px]">{job.title}</span>
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px] font-mono font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Done
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 font-mono truncate">{job.email}</p>
                <p className="text-[10px] text-slate-500 font-mono">
                  Finished {formatDate(job.updated || job.created)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
};
