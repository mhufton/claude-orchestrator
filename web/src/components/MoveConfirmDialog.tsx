import { useEffect } from 'react';
import { X, Play, Square, CheckCircle, ArrowRight } from 'lucide-react';
import type { TicketState } from '../lib/types';

interface MoveConfirmDialogProps {
  isOpen: boolean;
  ticketNumber: number;
  ticketTitle: string;
  fromState: TicketState;
  toState: TicketState;
  onConfirm: () => void;
  onCancel: () => void;
}

const stateLabels: Record<TicketState, string> = {
  needs_review: 'Needs Review',
  backlog: 'Ready',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

const stateColors: Record<TicketState, string> = {
  needs_review: 'text-purple-400',
  backlog: 'text-gray-400',
  in_progress: 'text-blue-400',
  in_review: 'text-yellow-400',
  done: 'text-green-400',
};

function getMoveDescription(from: TicketState, to: TicketState): { title: string; description: string; icon: React.ReactNode; variant: 'primary' | 'warning' | 'danger' } {
  // Approve for work
  if (from === 'needs_review' && to === 'backlog') {
    return {
      title: 'Approve for Work',
      description: 'This issue will be added to the work queue.',
      icon: <CheckCircle size={20} />,
      variant: 'primary',
    };
  }

  // Start work
  if (from === 'backlog' && to === 'in_progress') {
    return {
      title: 'Start Work',
      description: 'This will spawn a Claude agent to work on the issue. A worktree slot will be allocated.',
      icon: <Play size={20} />,
      variant: 'primary',
    };
  }

  // Stop work
  if (from === 'in_progress' && to === 'backlog') {
    return {
      title: 'Stop Work',
      description: 'The agent will be stopped and the worktree slot released. The ticket returns to the queue.',
      icon: <Square size={20} />,
      variant: 'warning',
    };
  }

  // Archive/Done
  if (to === 'done') {
    return {
      title: 'Mark as Done',
      description: 'This ticket will be archived. Any running agent will be stopped.',
      icon: <CheckCircle size={20} />,
      variant: 'primary',
    };
  }

  // Generic move
  return {
    title: 'Move Ticket',
    description: `Move this ticket from ${stateLabels[from]} to ${stateLabels[to]}.`,
    icon: <ArrowRight size={20} />,
    variant: 'primary',
  };
}

export function MoveConfirmDialog({
  isOpen,
  ticketNumber,
  ticketTitle,
  fromState,
  toState,
  onConfirm,
  onCancel,
}: MoveConfirmDialogProps) {
  // ESC key to close dialog
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const { title, description, icon, variant } = getMoveDescription(fromState, toState);

  const buttonColors = {
    primary: 'bg-purple-600 hover:bg-purple-500',
    warning: 'bg-orange-600 hover:bg-orange-500',
    danger: 'bg-red-600 hover:bg-red-500',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${variant === 'warning' ? 'bg-orange-900/50 text-orange-400' : variant === 'danger' ? 'bg-red-900/50 text-red-400' : 'bg-purple-900/50 text-purple-400'}`}>
              {icon}
            </div>
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-gray-400 hover:text-white rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="mb-4">
            <div className="text-sm text-gray-400 mb-1">Issue #{ticketNumber}</div>
            <div className="font-medium truncate">{ticketTitle}</div>
          </div>

          <div className="flex items-center gap-2 mb-4 text-sm">
            <span className={stateColors[fromState]}>{stateLabels[fromState]}</span>
            <ArrowRight size={14} className="text-gray-500" />
            <span className={stateColors[toState]}>{stateLabels[toState]}</span>
          </div>

          <p className="text-sm text-gray-400">{description}</p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-700">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 px-4 py-2 rounded text-sm font-medium text-white transition-colors ${buttonColors[variant]}`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
