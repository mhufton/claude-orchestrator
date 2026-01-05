import { useState } from 'react';
import { Wifi, WifiOff, GitBranch, Bot, Settings, Sparkles } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { OrchestratorChat } from './OrchestratorChat';
import { SettingsModal } from './SettingsModal';

export function Sidebar() {
  const [showSettings, setShowSettings] = useState(false);
  const connected = useTicketsStore(state => state.connected);
  const config = useTicketsStore(state => state.config);
  const slots = useTicketsStore(state => state.slots);
  const tickets = useTicketsStore(state => state.tickets);

  const needsReviewCount = tickets.filter(t => t.state === 'needs_review').length;
  const backlogCount = tickets.filter(t => t.state === 'backlog').length;
  const inFlightCount = tickets.filter(t => t.state === 'in_progress' || t.state === 'in_review').length;
  const doneToday = tickets.filter(t => {
    if (t.state !== 'done') return false;
    const updated = new Date(t.updated_at);
    const today = new Date();
    return updated.toDateString() === today.toDateString();
  }).length;

  return (
    <aside className="w-full h-full bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Sparkles className="text-purple-400" size={24} />
          <span className="font-semibold text-lg">Orchestrator</span>
        </div>
      </div>

      {/* Connection status */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <Wifi className="text-green-400" size={16} />
              <span className="text-sm text-green-400">Connected</span>
            </>
          ) : (
            <>
              <WifiOff className="text-red-400" size={16} />
              <span className="text-sm text-red-400">Disconnected</span>
            </>
          )}
        </div>

        {config && (
          <div className="mt-2 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <GitBranch size={12} />
              {config.repoOwner}/{config.repoName}
            </div>
          </div>
        )}
      </div>

      {/* Agent slots */}
      <div className="p-4 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">Agent Slots</h3>
        <div className="space-y-2">
          {slots.map(slot => (
            <div
              key={slot.slot}
              className={`
                flex items-center gap-2 p-2 rounded
                ${slot.available ? 'bg-gray-800' : 'bg-blue-900/30 border border-blue-700'}
              `}
            >
              <div className={`
                w-8 h-8 rounded-full flex items-center justify-center
                ${slot.available ? 'bg-gray-700' : 'bg-blue-600'}
              `}>
                <Bot size={16} className={slot.available ? 'text-gray-500' : 'text-white'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  Slot {slot.slot}
                </div>
                <div className="text-xs text-gray-400 truncate">
                  {slot.available ? 'Available' : `Working on #${slot.ticketId}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="p-4 border-b border-gray-800">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">Stats</h3>
        <div className="grid grid-cols-2 gap-2 text-center">
          {needsReviewCount > 0 && (
            <div className="bg-gray-800 rounded p-2">
              <div className="text-lg font-bold text-purple-400">{needsReviewCount}</div>
              <div className="text-xs text-gray-500">To Review</div>
            </div>
          )}
          <div className="bg-gray-800 rounded p-2">
            <div className="text-lg font-bold text-gray-200">{backlogCount}</div>
            <div className="text-xs text-gray-500">Backlog</div>
          </div>
          <div className="bg-gray-800 rounded p-2">
            <div className="text-lg font-bold text-blue-400">{inFlightCount}</div>
            <div className="text-xs text-gray-500">In Flight</div>
          </div>
          <div className="bg-gray-800 rounded p-2">
            <div className="text-lg font-bold text-green-400">{doneToday}</div>
            <div className="text-xs text-gray-500">Done Today</div>
          </div>
        </div>
      </div>

      {/* Orchestrator Chat - takes remaining space */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <OrchestratorChat />
      </div>

      {/* Settings */}
      <div className="p-4 border-t border-gray-800 shrink-0">
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-sm"
        >
          <Settings size={16} />
          Settings
        </button>
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </aside>
  );
}
