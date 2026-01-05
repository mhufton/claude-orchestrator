import { useState, useEffect, useRef } from 'react';
import { X, AlertTriangle, CheckCircle, RotateCcw, Archive, FileText, Trash2, Send } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ConfirmDialog } from './ConfirmDialog';
import type { Ticket } from '../lib/types';

interface AttentionDialogProps {
  ticket: Ticket;
  onClose: () => void;
  onViewLogs: () => void;
}

type ConfirmAction = 'done' | 'backlog' | 'force_reset' | null;

export function AttentionDialog({ ticket, onClose, onViewLogs }: AttentionDialogProps) {
  const { send } = useWebSocket();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [command, setCommand] = useState('');
  const [showCommandInput, setShowCommandInput] = useState(false);
  const commandInputRef = useRef<HTMLTextAreaElement>(null);

  // ESC key to close dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmAction !== null) {
          setConfirmAction(null);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [confirmAction, onClose]);

  const handleMarkDone = () => {
    setConfirmAction('done');
  };

  const handleMoveToBacklog = () => {
    setConfirmAction('backlog');
  };

  const handleForceReset = () => {
    setConfirmAction('force_reset');
  };

  // Focus command input when shown
  useEffect(() => {
    if (showCommandInput && commandInputRef.current) {
      commandInputRef.current.focus();
    }
  }, [showCommandInput]);

  const handleRetryClick = () => {
    setShowCommandInput(true);
  };

  const handleRetryWithCommand = () => {
    send({
      type: 'retry_ticket',
      ticketId: ticket.id,
      command: command.trim() || undefined
    });
    onClose();
  };

  const handleCommandKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleRetryWithCommand();
    }
  };

  const handleDismissFlag = () => {
    send({ type: 'resolve_attention', ticketId: ticket.id, action: 'dismiss' });
    onClose();
  };

  const handleConfirm = () => {
    switch (confirmAction) {
      case 'done':
        send({ type: 'resolve_attention', ticketId: ticket.id, action: 'done' });
        break;
      case 'backlog':
        send({ type: 'resolve_attention', ticketId: ticket.id, action: 'backlog' });
        break;
      case 'force_reset':
        send({ type: 'force_reset_ticket', ticketId: ticket.id });
        break;
    }
    setConfirmAction(null);
    onClose();
  };

  const getConfirmDialogProps = () => {
    switch (confirmAction) {
      case 'done':
        return {
          title: 'Mark as Done',
          message: 'Are you sure you want to mark this ticket as done? This will close it without merging any PR.',
          confirmLabel: 'Mark Done',
          confirmVariant: 'primary' as const
        };
      case 'backlog':
        return {
          title: 'Move to Backlog',
          message: 'Are you sure you want to move this ticket back to the backlog? Any work in progress will be lost.',
          confirmLabel: 'Move to Backlog',
          confirmVariant: 'warning' as const
        };
      case 'force_reset':
        return {
          title: 'Force Reset',
          message: 'Are you sure you want to force reset this ticket? This will delete all logs, chat history, and reset all progress. The ticket will return to the backlog.',
          confirmLabel: 'Force Reset',
          confirmVariant: 'danger' as const
        };
      default:
        return { title: '', message: '', confirmLabel: '', confirmVariant: 'primary' as const };
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-lg w-full max-w-md border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-red-400" size={20} />
            <div>
              <h2 className="font-semibold">Needs Attention</h2>
              <p className="text-sm text-gray-400">
                #{ticket.github_issue_number} - {ticket.title}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded">
            <X size={20} />
          </button>
        </div>

        {/* Reason */}
        <div className="p-4 border-b border-gray-700">
          <p className="text-sm text-gray-300">
            {ticket.attention_reason || 'This ticket requires your attention.'}
          </p>
        </div>

        {/* Actions */}
        <div className="p-4 space-y-2">
          <button
            onClick={handleMarkDone}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-green-900/30 hover:bg-green-900/50 text-green-300 transition-colors"
          >
            <CheckCircle size={20} />
            <div className="text-left">
              <div className="font-medium">Mark as Done</div>
              <div className="text-xs text-green-400/70">Issue was resolved without a PR</div>
            </div>
          </button>

          <button
            onClick={handleMoveToBacklog}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <Archive size={20} />
            <div className="text-left">
              <div className="font-medium">Move to Backlog</div>
              <div className="text-xs text-gray-400">Return to backlog for later</div>
            </div>
          </button>

          {!showCommandInput ? (
            <button
              onClick={handleRetryClick}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-orange-900/30 hover:bg-orange-900/50 text-orange-300 transition-colors"
            >
              <RotateCcw size={20} />
              <div className="text-left">
                <div className="font-medium">Retry with Instructions</div>
                <div className="text-xs text-orange-400/70">Run the agent again with optional guidance</div>
              </div>
            </button>
          ) : (
            <div className="w-full p-3 rounded-lg bg-orange-900/30 border border-orange-700/50">
              <div className="flex items-center gap-2 mb-2 text-orange-300">
                <RotateCcw size={16} />
                <span className="text-sm font-medium">Retry with Instructions</span>
              </div>
              <textarea
                ref={commandInputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={handleCommandKeyDown}
                placeholder="Optional: Tell the agent what to do differently (e.g., 'fix the linting errors' or 'target dev branch instead of main')..."
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-orange-500"
                rows={3}
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-gray-500">⌘+Enter to send</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowCommandInput(false)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRetryWithCommand}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded transition-colors"
                  >
                    <Send size={12} />
                    {command.trim() ? 'Send & Retry' : 'Retry Now'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <button
            onClick={onViewLogs}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <FileText size={20} />
            <div className="text-left">
              <div className="font-medium">View Logs</div>
              <div className="text-xs text-gray-400">See what the agent did</div>
            </div>
          </button>

          <button
            onClick={handleForceReset}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-300 transition-colors"
          >
            <Trash2 size={20} />
            <div className="text-left">
              <div className="font-medium">Force Reset</div>
              <div className="text-xs text-red-400/70">Clear all progress and start fresh</div>
            </div>
          </button>

          <button
            onClick={handleDismissFlag}
            className="w-full flex items-center gap-3 px-4 py-2 rounded-lg text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={16} />
            <span className="text-sm">Dismiss flag (keep in current state)</span>
          </button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        isOpen={confirmAction !== null}
        {...getConfirmDialogProps()}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
