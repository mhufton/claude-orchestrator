import { useState, useEffect } from 'react';
import { useTicketsStore } from '../stores/tickets';

function formatCountdown(nextRun: number | null): string {
  if (!nextRun) return '--';
  const remaining = Math.max(0, nextRun - Date.now());
  const seconds = Math.floor(remaining / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function StatusBar() {
  const pollStatus = useTicketsStore(state => state.pollStatus);
  const activityLog = useTicketsStore(state => state.activityLog);
  const connected = useTicketsStore(state => state.connected);
  const [, setTick] = useState(0);

  // Update countdown every second
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const latestActivity = activityLog[0];

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs">
      {/* Connection status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-gray-400">{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      {/* Poll countdowns */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">PR Check:</span>
          <span className="text-blue-400 font-mono">
            {formatCountdown(pollStatus.prWatch.nextRun)}
          </span>
          {pollStatus.prWatch.ticketsChecked > 0 && (
            <span className="text-gray-600">
              ({pollStatus.prWatch.ticketsChecked} checked)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-gray-500">Issue Sync:</span>
          <span className="text-purple-400 font-mono">
            {formatCountdown(pollStatus.issueSync.nextRun)}
          </span>
        </div>
      </div>

      {/* Latest activity */}
      <div className="flex items-center gap-2 max-w-md">
        {latestActivity ? (
          <>
            <ActivityIcon type={latestActivity.type} />
            <span className="text-gray-400 truncate">{latestActivity.message}</span>
            <span className="text-gray-600 flex-shrink-0">
              {formatTimeAgo(latestActivity.timestamp)}
            </span>
          </>
        ) : (
          <span className="text-gray-600">No recent activity</span>
        )}
      </div>
    </div>
  );
}

function ActivityIcon({ type }: { type: string }) {
  switch (type) {
    case 'pr_merged':
      return <span className="text-green-500">✓</span>;
    case 'respawn':
      return <span className="text-yellow-500">↻</span>;
    case 'issue_sync':
      return <span className="text-purple-500">↓</span>;
    case 'pr_check':
      return <span className="text-blue-500">○</span>;
    case 'agent_spawn':
      return <span className="text-cyan-500">▶</span>;
    default:
      return <span className="text-gray-500">•</span>;
  }
}
