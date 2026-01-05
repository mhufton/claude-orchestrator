import { useState, useEffect } from 'react';
import { AlertTriangle, Pause, Play, X, RefreshCw, Loader2, Zap, ZapOff } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { useWebSocket } from '../hooks/useWebSocket';

// Separate pause button component that can be positioned elsewhere
function PauseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 rounded text-sm transition-colors shrink-0"
      title="Pause pipeline"
    >
      <Pause size={14} />
      <span className="hidden sm:inline">Pause Pipeline</span>
    </button>
  );
}

// Sync button component
function SyncButton({ onClick, isSyncing }: { onClick: () => void; isSyncing: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={isSyncing}
      className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 rounded text-sm transition-colors shrink-0 disabled:opacity-50"
      title="Sync issues from GitHub"
    >
      {isSyncing ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <RefreshCw size={14} />
      )}
      <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
    </button>
  );
}

// Auto-play toggle button
function AutoPlayButton({ enabled, active, onClick }: { enabled: boolean; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors shrink-0 ${
        enabled
          ? 'bg-green-600 hover:bg-green-500 text-white border border-green-500'
          : 'bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300'
      }`}
      title={enabled ? 'Disable auto-play' : 'Enable auto-play (automatically reviews and starts tickets)'}
    >
      {enabled ? (
        <>
          <Zap size={14} className={active ? 'animate-pulse' : ''} />
          <span className="hidden sm:inline">Auto-Play On</span>
        </>
      ) : (
        <>
          <ZapOff size={14} />
          <span className="hidden sm:inline">Auto-Play</span>
        </>
      )}
    </button>
  );
}

export function PipelinePauseBanner() {
  const { send } = useWebSocket();
  const pipelineStatus = useTicketsStore(state => state.pipelineStatus);
  const autoplayStatus = useTicketsStore(state => state.autoplayStatus);
  const [showPauseDialog, setShowPauseDialog] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  const handleToggleAutoPlay = () => {
    if (autoplayStatus.enabled) {
      send({ type: 'disable_autoplay' });
    } else {
      send({ type: 'enable_autoplay' });
    }
  };

  const handlePause = () => {
    if (!pauseReason.trim()) return;
    send({ type: 'pause_pipeline', reason: pauseReason.trim() });
    setShowPauseDialog(false);
    setPauseReason('');
  };

  const handleResume = () => {
    send({ type: 'resume_pipeline' });
  };

  const handleSync = () => {
    setIsSyncing(true);
    send({ type: 'sync_issues' });
    // Reset after a timeout in case we don't get a response
    setTimeout(() => setIsSyncing(false), 10000);
  };

  // Listen for sync_result to clear syncing state
  useEffect(() => {
    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sync_result' || data.type === 'error') {
          setIsSyncing(false);
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, []);

  // ESC key to close pause dialog
  useEffect(() => {
    if (!showPauseDialog) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowPauseDialog(false);
        setPauseReason('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showPauseDialog]);

  // Format time since paused
  const getTimeSincePaused = () => {
    if (!pipelineStatus.pausedAt) return '';
    const pausedAt = new Date(pipelineStatus.pausedAt);
    const now = new Date();
    const diffMs = now.getTime() - pausedAt.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffHours > 0) return `${diffHours}h ${diffMins % 60}m ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return 'just now';
  };

  if (pipelineStatus.paused) {
    return (
      <div className="bg-red-900/80 border-b border-red-700 px-4 py-3">
        <div className="flex items-center justify-between max-w-screen-xl mx-auto">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-red-400 shrink-0" size={20} />
            <div>
              <span className="font-semibold text-red-200">Pipeline Paused</span>
              <span className="text-red-300 ml-2">— {pipelineStatus.reason}</span>
              <span className="text-red-400 text-sm ml-3">({getTimeSincePaused()})</span>
            </div>
          </div>
          <button
            onClick={handleResume}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded font-medium transition-colors"
          >
            <Play size={16} />
            Resume Pipeline
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header bar with sync, autoplay, and pause buttons on the right */}
      <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-gray-800/50 shrink-0">
        <SyncButton onClick={handleSync} isSyncing={isSyncing} />
        <AutoPlayButton
          enabled={autoplayStatus.enabled}
          active={autoplayStatus.active}
          onClick={handleToggleAutoPlay}
        />
        <PauseButton onClick={() => setShowPauseDialog(true)} />
      </div>

      {/* Pause dialog */}
      {showPauseDialog && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => {
            setShowPauseDialog(false);
            setPauseReason('');
          }}
        >
          <div
            className="bg-gray-900 rounded-lg w-full max-w-md border border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <AlertTriangle className="text-yellow-500" size={20} />
                <h2 className="font-semibold">Pause Pipeline</h2>
              </div>
              <button
                onClick={() => setShowPauseDialog(false)}
                className="p-1 hover:bg-gray-800 rounded"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <p className="text-gray-400 text-sm">
                This will stop all running agents and prevent new work from starting.
                Use this when there's a blocking issue in the pipeline.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Reason for pausing
                </label>
                <input
                  type="text"
                  value={pauseReason}
                  onChange={(e) => setPauseReason(e.target.value)}
                  placeholder="e.g., CI failing on auth config issue"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && pauseReason.trim()) {
                      handlePause();
                    }
                  }}
                />
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowPauseDialog(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePause}
                  disabled={!pauseReason.trim()}
                  className={`flex items-center gap-2 px-4 py-2 rounded font-medium transition-colors ${
                    pauseReason.trim()
                      ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                      : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  <Pause size={16} />
                  Pause All Agents
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
