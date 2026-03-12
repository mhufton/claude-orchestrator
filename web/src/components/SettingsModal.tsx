import { useState, useEffect } from 'react';
import { X, Bot, Users, Layers, ListOrdered, Workflow } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useTicketsStore } from '../stores/tickets';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { send } = useWebSocket();
  const settings = useTicketsStore(state => state.settings);

  const [maxAgentSlots, setMaxAgentSlots] = useState(settings?.maxAgentSlots ?? 3);
  const [maxParallelReviews, setMaxParallelReviews] = useState(settings?.maxParallelReviews ?? 3);
  const [batchingEnabled, setBatchingEnabled] = useState(settings?.batchingEnabled ?? true);
  const [serialPRQueue, setSerialPRQueue] = useState(settings?.serialPRQueue ?? false);
  const [agentMode, setAgentMode] = useState<'parallel-slots' | 'pm-single'>(settings?.agentMode ?? 'parallel-slots');
  const [isSaving, setIsSaving] = useState(false);

  // Sync local state when settings change
  useEffect(() => {
    if (settings) {
      setMaxAgentSlots(settings.maxAgentSlots);
      setMaxParallelReviews(settings.maxParallelReviews);
      setBatchingEnabled(settings.batchingEnabled ?? true);
      setSerialPRQueue(settings.serialPRQueue ?? false);
      setAgentMode(settings.agentMode ?? 'parallel-slots');
    }
  }, [settings]);

  if (!isOpen) return null;

  const handleSave = () => {
    setIsSaving(true);
    send({
      type: 'update_settings',
      settings: {
        maxAgentSlots,
        maxParallelReviews,
        batchingEnabled,
        serialPRQueue,
        agentMode,
      }
    });
    // Close after a short delay to show feedback
    setTimeout(() => {
      setIsSaving(false);
      onClose();
    }, 300);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-6">
          {/* Agent Slots */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Bot size={16} className="text-blue-400" />
              <label className="text-sm font-medium">Max Agent Slots</label>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Number of parallel worktrees for running agents. Each slot can work on one issue at a time.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="10"
                value={maxAgentSlots}
                onChange={(e) => setMaxAgentSlots(parseInt(e.target.value))}
                className="flex-1 accent-blue-500"
              />
              <span className="text-lg font-bold text-blue-400 w-8 text-center">
                {maxAgentSlots}
              </span>
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>1</span>
              <span>10</span>
            </div>
          </div>

          {/* Parallel Reviews */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-purple-400" />
              <label className="text-sm font-medium">Max Parallel Reviews</label>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Number of issues to review simultaneously during batch review. Higher values use more API calls but finish faster.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="10"
                value={maxParallelReviews}
                onChange={(e) => setMaxParallelReviews(parseInt(e.target.value))}
                className="flex-1 accent-purple-500"
              />
              <span className="text-lg font-bold text-purple-400 w-8 text-center">
                {maxParallelReviews}
              </span>
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>1</span>
              <span>10</span>
            </div>
          </div>

          {/* Batching */}
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={16} className="text-indigo-400" />
                <label className="text-sm font-medium">Auto-Batch Related Tickets</label>
              </div>
              <button
                onClick={() => setBatchingEnabled(!batchingEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  batchingEnabled ? 'bg-indigo-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    batchingEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Automatically group related tickets by area into single PRs. When disabled, each ticket is processed individually.
            </p>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-700 pt-4">
            <h3 className="text-sm font-semibold text-yellow-400 mb-3">Experimental Features</h3>
          </div>

          {/* Serial PR Queue */}
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListOrdered size={16} className="text-yellow-400" />
                <label className="text-sm font-medium">Serial PR Queue</label>
              </div>
              <button
                onClick={() => setSerialPRQueue(!serialPRQueue)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  serialPRQueue ? 'bg-yellow-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    serialPRQueue ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Only allow one PR in review at a time. Prevents CI overload and merge conflicts. Recommended for stability.
            </p>
          </div>

          {/* Agent Mode */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Workflow size={16} className="text-yellow-400" />
              <label className="text-sm font-medium">Agent Mode</label>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Choose between parallel independent agents or a single PM agent that orchestrates work.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setAgentMode('parallel-slots')}
                className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${
                  agentMode === 'parallel-slots'
                    ? 'bg-yellow-600/20 border-yellow-500 text-yellow-400'
                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                <div className="font-medium">Parallel Slots</div>
                <div className="text-[10px] opacity-70 mt-1">Multiple independent agents</div>
              </button>
              <button
                onClick={() => setAgentMode('pm-single')}
                className={`flex-1 px-3 py-2 text-xs rounded-lg border transition-colors ${
                  agentMode === 'pm-single'
                    ? 'bg-yellow-600/20 border-yellow-500 text-yellow-400'
                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                <div className="font-medium">PM Single</div>
                <div className="text-[10px] opacity-70 mt-1">One agent orchestrates all (WIP)</div>
              </button>
            </div>
          </div>

          {/* Note */}
          <div className="text-xs text-gray-500 bg-gray-900/50 rounded p-3">
            <strong>Note:</strong> Changes take effect immediately. Reducing slots won't stop running agents, but will prevent new ones from starting until slots are freed.
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex-1 px-4 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
