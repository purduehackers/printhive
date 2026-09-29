import React from 'react';
import { Layers, ListOrdered, ShieldCheck, Database, HardDriveDownload, Lock } from 'lucide-react';
import type { QueueResponse } from '../types';

interface NavbarProps {
  activeTab: 'submit' | 'queue' | 'operator';
  setActiveTab: (tab: 'submit' | 'queue' | 'operator') => void;
  queueData: QueueResponse | null;
  operatorUser: { id: string; email: string; name?: string } | null;
}

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab, queueData, operatorUser }) => {
  const printingCount = queueData?.currentlyPrinting.length || 0;
  const queuedCount = queueData?.nextInQueue.length || 0;
  const isPocketBase = queueData?.source === 'pocketbase';

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Brand */}
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab('submit')}>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-600 via-amber-500 to-yellow-400 p-[1px] shadow-lg shadow-amber-500/10 flex items-center justify-center">
            <div className="w-full h-full bg-slate-950 rounded-[11px] flex items-center justify-center">
              <span className="text-xl">🚂</span>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-extrabold tracking-tight text-white">
                Print<span className="text-[#CEB888]">Hive</span>
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-[#CEB888] border border-amber-500/20 font-semibold">
                v2 Simple
              </span>
            </div>
            <p className="text-xs text-slate-400">Purdue Makerspace 3D Print Queue</p>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={() => setActiveTab('submit')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'submit'
                ? 'bg-[#CEB888] text-slate-950 shadow-md font-semibold'
                : 'text-slate-300 hover:text-white hover:bg-slate-900'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Submit Print</span>
          </button>

          <button
            onClick={() => setActiveTab('queue')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all relative ${
              activeTab === 'queue'
                ? 'bg-[#CEB888] text-slate-950 shadow-md font-semibold'
                : 'text-slate-300 hover:text-white hover:bg-slate-900'
            }`}
          >
            <ListOrdered className="w-4 h-4" />
            <span>Live Queue</span>
            {(printingCount > 0 || queuedCount > 0) && (
              <span className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                activeTab === 'queue' ? 'bg-slate-950 text-amber-300' : 'bg-amber-500/20 text-[#CEB888]'
              }`}>
                {printingCount > 0 ? `1 running` : `${queuedCount} waiting`}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('operator')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'operator'
                ? 'bg-[#CEB888] text-slate-950 shadow-md font-semibold'
                : 'text-slate-400 hover:text-white hover:bg-slate-900'
            }`}
          >
            {operatorUser ? (
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            ) : (
              <Lock className="w-3.5 h-3.5 opacity-70" />
            )}
            <span className="hidden sm:inline">Operator Desk</span>
            <span className="sm:hidden">Staff</span>
            {operatorUser && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            )}
          </button>
        </nav>

        {/* Database Status indicator */}
        <div className="hidden md:flex items-center gap-2 text-xs font-mono text-slate-400">
          <Database className="w-3.5 h-3.5 text-[#CEB888]" />
          <span>
            {isPocketBase ? 'PocketBase' : 'Local Queue'}
          </span>
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        </div>

      </div>
    </header>
  );
};
