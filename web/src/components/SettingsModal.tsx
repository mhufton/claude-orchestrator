import { useState, useEffect } from 'react';
import { X, Bot, Users } from 'lucide-react';
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
  const [isSaving, setIsSaving] = useState(false);

  // Sync local state when settings change
  useEffect(() => {
    if (settings) {
      setMaxAgentSlots(settings.maxAgentSlots);
      setMaxParallelReviews(settings.maxParallelReviews);
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
                max="5"
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
              <span>5</span>
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
