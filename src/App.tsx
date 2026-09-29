import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { SubmissionForm } from './components/SubmissionForm';
import { LiveQueue } from './components/LiveQueue';
import { OperatorDesk } from './components/OperatorDesk';
import type { QueueResponse } from './types';

export function App() {
  const [activeTab, setActiveTab] = useState<'submit' | 'queue' | 'operator'>('submit');
  const [queueData, setQueueData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchQueue = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/jobs');
      if (res.ok) {
        const data = await res.json();
        setQueueData(data);
      }
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    // Poll queue every 6 seconds
    const interval = setInterval(fetchQueue, 6000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Navbar */}
      <Navbar activeTab={activeTab} setActiveTab={setActiveTab} queueData={queueData} />

      {/* Main Content Area */}
      <main className="flex-1">
        {activeTab === 'submit' && (
          <SubmissionForm
            onJobSubmitted={() => {
              fetchQueue();
              setActiveTab('queue');
            }}
          />
        )}

        {activeTab === 'queue' && (
          <LiveQueue
            queueData={queueData}
            onRefresh={fetchQueue}
            loading={loading}
            onGoToSubmit={() => setActiveTab('submit')}
          />
        )}

        {activeTab === 'operator' && (
          <OperatorDesk
            queueData={queueData}
            onRefresh={fetchQueue}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 py-8 px-4 text-center text-xs text-slate-500 font-mono">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[#CEB888] font-bold">PrintHive Purdue</span>
            <span>·</span>
            <span>Simplified 3D Printing Service</span>
          </div>
          <div className="flex items-center gap-4 text-slate-400">
            <span>Only @purdue.edu Authorized</span>
            <span>·</span>
            <span className="text-[#CEB888]">Boiler Up! 🚂</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
