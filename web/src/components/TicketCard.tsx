import { useMemo, useState, useEffect } from 'react';
import { ExternalLink, Play, RotateCcw, GitBranch, CheckCircle2, XCircle, Clock, Loader2, MessageSquare, TrendingUp, Wrench, Square, CheckSquare, Lock, Link2, Pause, PlayCircle, Layers } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Ticket, RetryReason, Priority } from '../lib/types';

function getPriorityInfo(priority: Priority): { icon: string; color: string; label: string } {
  switch (priority) {
    case 'urgent':
      return {
        icon: '!!!',
        color: 'bg-red-700 text-white animate-pulse',
        label: 'URGENT - Displaces other tickets'
      };
    case 'high':
      return {
        icon: '▲',
        color: 'bg-red-600 text-white',
        label: 'High priority'
      };
    case 'low':
      return {
        icon: '▼',
        color: 'bg-gray-600 text-gray-300',
        label: 'Low priority'
      };
    default:
      return {
        icon: '—',
        color: 'bg-gray-700 text-gray-400',
        label: 'Medium priority'
      };
  }
}

function getRetryReasonInfo(reason: RetryReason): { label: string; icon: React.ReactNode; color: string } | null {
  switch (reason) {
    case 'addressing_pr_comments':
      return {
        label: 'Addressing PR Comments',
        icon: <MessageSquare size={12} />,
        color: 'text-purple-400 bg-purple-900/50'
      };
    case 'improving_score':
      return {
        label: 'Improving Score',
        icon: <TrendingUp size={12} />,
        color: 'text-yellow-400 bg-yellow-900/50'
      };
    case 'fixing_ci':
      return {
        label: 'Fixing CI',
        icon: <Wrench size={12} />,
        color: 'text-red-400 bg-red-900/50'
      };
    case 'resolving_merge_conflict':
      return {
        label: 'Resolving Merge Conflicts',
        icon: <GitBranch size={12} />,
        color: 'text-orange-400 bg-orange-900/50'
      };
    default:
      return null;
  }
}

interface TicketCardProps {
  ticket: Ticket;
  onStart?: (force?: boolean) => void;
  onRetry?: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
  slotsAvailable?: boolean;
  showReviewCheckbox?: boolean;
  isInReviewQueue?: boolean;
  onToggleReviewQueue?: () => void;
  isPipelinePaused?: boolean;
  isBeingReviewed?: boolean;
  reviewResult?: { verdict: string; error?: string };
}

function formatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.text === 'string') return obj.text;
    return '';
  }
  return '';
}

function estimateProgress(logs: Array<{ type: string; content: unknown }>): { phase: string; percent: number } {
  const logContents = logs.map(l => formatContent(l.content).toLowerCase());
  const allContent = logContents.join(' ');

  if (allContent.includes('pr created') || allContent.includes('pull request')) {
    return { phase: 'Creating PR', percent: 95 };
  }
  if (allContent.includes('git push') || allContent.includes('pushing')) {
    return { phase: 'Pushing', percent: 85 };
  }
  if (allContent.includes('git commit') || allContent.includes('committing')) {
    return { phase: 'Committing', percent: 75 };
  }
  if (allContent.includes('test') && (allContent.includes('pass') || allContent.includes('success'))) {
    return { phase: 'Tests passed', percent: 70 };
  }
  if (allContent.includes('running test') || allContent.includes('npm test') || allContent.includes('bun test')) {
    return { phase: 'Testing', percent: 60 };
  }
  if (allContent.includes('lint') || allContent.includes('eslint')) {
    return { phase: 'Linting', percent: 50 };
  }
  if (allContent.includes('build') || allContent.includes('compil')) {
    return { phase: 'Building', percent: 45 };
  }
  if (allContent.includes('edit') || allContent.includes('write') || allContent.includes('modif')) {
    return { phase: 'Writing code', percent: 35 };
  }
  if (allContent.includes('read') || allContent.includes('grep') || allContent.includes('glob')) {
    return { phase: 'Analyzing', percent: 20 };
  }

  const toolUseCount = logs.filter(l => l.type === 'tool_use').length;
  if (toolUseCount > 20) return { phase: 'Working', percent: 40 };
  if (toolUseCount > 10) return { phase: 'Working', percent: 25 };
  if (toolUseCount > 5) return { phase: 'Exploring', percent: 15 };
  if (logs.length > 0) return { phase: 'Starting', percent: 5 };

  return { phase: 'Initializing', percent: 0 };
}

function getTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

function getScoreColor(score: number | null): string {
  if (score === null) return 'text-gray-400';
  if (score >= 90) return 'text-green-400';
  if (score >= 70) return 'text-yellow-400';
  return 'text-red-400';
}

export function TicketCard({
  ticket,
  onStart,
  onRetry,
  onSelect,
  isSelected,
  slotsAvailable = true,
  showReviewCheckbox = false,
  isInReviewQueue = false,
  onToggleReviewQueue,
  isPipelinePaused = false,
  isBeingReviewed = false,
  reviewResult
}: TicketCardProps) {
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  const [pendingAction, setPendingAction] = useState<'starting' | 'restarting' | 'emergency_starting' | null>(null);
  const { send } = useWebSocket();

  /// Cycle priority: urgent -> high, high -> medium -> low -> high
  // Note: Cannot cycle INTO urgent via click - only de-escalate from urgent
  const cyclePriority = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextPriority: Priority =
      ticket.priority === 'urgent' ? 'high' :  // De-escalate from urgent
      ticket.priority === 'high' ? 'medium' :
      ticket.priority === 'medium' ? 'low' : 'high';
    send({ type: 'set_priority', ticketId: ticket.id, priority: nextPriority });
  };

  // Emergency start - sets priority to urgent and starts immediately with displacement
  const handleEmergencyStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Start ticket #${ticket.github_issue_number} as URGENT?\n\nThis will:\n- Set priority to urgent\n- Displace a running ticket if needed\n- Start work immediately`)) {
      setPendingAction('emergency_starting');
      send({ type: 'emergency_start', ticketId: ticket.id });
    }
  };

  // Clear pending state when ticket state changes
  useEffect(() => {
    setPendingAction(null);
  }, [ticket.state]);

  // Timeout to clear stuck pending state (e.g., if start fails without state change)
  useEffect(() => {
    if (pendingAction) {
      const timeout = setTimeout(() => setPendingAction(null), 10000);
      return () => clearTimeout(timeout);
    }
  }, [pendingAction]);

  // Subscribe directly to this ticket's logs and todos for real-time progress updates
  const logs = useTicketsStore(state => state.agentLogs.get(ticket.id) || []);
  const todos = useTicketsStore(state => state.agentTodos.get(ticket.id) || []);
  const progress = useMemo(() => {
    if (ticket.state !== 'in_progress') return null;
    return estimateProgress(logs);
  }, [ticket.state, logs]);

  // Get current active task from todos
  const activeTask = useMemo(() => {
    return todos.find(t => t.status === 'in_progress');
  }, [todos]);

  const todoProgress = useMemo(() => {
    if (todos.length === 0) return null;
    const completed = todos.filter(t => t.status === 'completed').length;
    return { completed, total: todos.length };
  }, [todos]);

  const needsAttention = Boolean(ticket.needs_attention);

  return (
    <div
      onClick={onSelect}
      className={`
        bg-gray-800 rounded-lg p-3 cursor-pointer transition-all
        border-2
        ${needsAttention
          ? 'border-red-500 animate-pulse shadow-lg shadow-red-500/20'
          : isSelected
            ? 'border-blue-500'
            : 'border-transparent hover:border-gray-600'}
      `}
    >
      {/* Attention banner */}
      {needsAttention && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1 bg-red-900/50 rounded text-red-300 text-xs">
          <span className="font-medium">Needs attention</span>
          {ticket.attention_reason && (
            <span className="text-red-400 truncate">- {ticket.attention_reason}</span>
          )}
        </div>
      )}

      {/* Urgent priority banner */}
      {ticket.priority === 'urgent' && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1 bg-red-800/70 rounded text-red-200 text-xs animate-pulse">
          <span className="text-sm font-bold">!!!</span>
          <span className="font-bold">URGENT</span>
          <span className="text-red-300">- Priority escalated, may displace other work</span>
        </div>
      )}

      {/* Paused banner */}
      {Boolean(ticket.paused) && !needsAttention && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1 bg-yellow-900/50 rounded text-yellow-300 text-xs">
          <Pause size={12} />
          <span className="font-medium">Paused</span>
          {ticket.pause_reason && (
            <span className="text-yellow-400 truncate">- {ticket.pause_reason}</span>
          )}
        </div>
      )}

      {/* Retry reason banner */}
      {ticket.state === 'in_progress' && !needsAttention && ticket.retry_reason && (() => {
        const retryInfo = getRetryReasonInfo(ticket.retry_reason);
        if (!retryInfo) return null;
        return (
          <div className={`flex items-center gap-2 mb-2 px-2 py-1 rounded text-xs ${retryInfo.color}`}>
            {retryInfo.icon}
            <span className="font-medium">{retryInfo.label}</span>
          </div>
        );
      })()}

      {/* Being reviewed banner */}
      {isBeingReviewed && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1 bg-purple-900/50 rounded text-purple-300 text-xs">
          <Loader2 size={12} className="animate-spin" />
          <span className="font-medium">Reviewing...</span>
        </div>
      )}

      {/* Review result banner - only show in Triage column (needs_review state) */}
      {/* Once ticket moves to Ready/Backlog, the review is complete and badge shouldn't show */}
      {reviewResult && !isBeingReviewed && ticket.state === 'needs_review' && (
        <div className={`flex items-center gap-2 mb-2 px-2 py-1 rounded text-xs ${
          reviewResult.verdict === 'ready' ? 'bg-green-900/50 text-green-300' :
          reviewResult.verdict === 'minor_gaps' ? 'bg-yellow-900/50 text-yellow-300' :
          reviewResult.verdict === 'needs_revision' ? 'bg-orange-900/50 text-orange-300' :
          reviewResult.error ? 'bg-red-900/50 text-red-300' :
          'bg-gray-800 text-gray-400'
        }`}>
          {reviewResult.verdict === 'ready' && <CheckCircle2 size={12} />}
          {reviewResult.verdict === 'minor_gaps' && <Clock size={12} />}
          {reviewResult.verdict === 'needs_revision' && <XCircle size={12} />}
          {reviewResult.error && <XCircle size={12} />}
          <span className="font-medium">
            {reviewResult.error ? 'Review failed' :
             reviewResult.verdict === 'ready' ? 'Ready' :
             reviewResult.verdict === 'minor_gaps' ? 'Gaps fixed' :
             reviewResult.verdict === 'needs_revision' ? 'Revised' :
             reviewResult.verdict}
          </span>
        </div>
      )}

      {/* Batch indicator */}
      {ticket.batch_id && (
        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-indigo-900/30 border-l-2 border-indigo-500 rounded-r text-xs text-indigo-300">
          <Layers size={12} className="shrink-0" />
          <span>Batched (ID: {ticket.batch_id})</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Review queue checkbox */}
          {showReviewCheckbox && onToggleReviewQueue && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleReviewQueue();
              }}
              className={`shrink-0 p-0.5 rounded transition-colors ${
                isInReviewQueue
                  ? 'text-purple-400 hover:text-purple-300'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
              title={isInReviewQueue ? 'Remove from review queue' : 'Add to review queue'}
            >
              {isInReviewQueue ? <CheckSquare size={16} /> : <Square size={16} />}
            </button>
          )}
          {/* Green pulsing dot when agent is actively working */}
          {ticket.state === 'in_progress' && !needsAttention && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
          )}
          <span className="text-gray-400 text-sm shrink-0">#{ticket.github_issue_number}</span>
          <h3 className="font-medium text-sm truncate">{ticket.title}</h3>
        </div>
        <a
          href={ticket.github_issue_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-gray-500 hover:text-gray-200 hover:bg-gray-700 p-1 rounded shrink-0 transition-colors"
          title="Open GitHub issue"
        >
          <ExternalLink size={14} />
        </a>
      </div>

      {/* Labels */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {labels.slice(0, 3).map((label, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 text-xs rounded bg-gray-700 text-gray-300"
            >
              {label}
            </span>
          ))}
          {labels.length > 3 && (
            <span className="px-1.5 py-0.5 text-xs text-gray-500">
              +{labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Dependency indicators */}
      {ticket.blocked_by && ticket.blocked_by.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-red-900/30 border-l-2 border-red-500 rounded-r text-xs text-red-300">
          <Lock size={12} className="shrink-0" />
          <span>Blocked by #{ticket.blocked_by.join(', #')}</span>
        </div>
      )}
      {ticket.blocks && ticket.blocks.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-orange-900/30 border-l-2 border-orange-500 rounded-r text-xs text-orange-300">
          <Link2 size={12} className="shrink-0" />
          <span>Blocks #{ticket.blocks.join(', #')}</span>
        </div>
      )}

      {/* Current task for in_progress tickets */}
      {ticket.state === 'in_progress' && !needsAttention && (
        <div className="mb-2 bg-gray-700/50 rounded p-2">
          {todoProgress ? (
            <div className="space-y-1.5">
              {/* Todo progress */}
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-gray-600 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all duration-300"
                    style={{ width: `${(todoProgress.completed / todoProgress.total) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 shrink-0">
                  {todoProgress.completed}/{todoProgress.total}
                </span>
              </div>
              {/* Current task */}
              {activeTask && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Loader2 size={12} className="text-blue-400 animate-spin shrink-0" />
                  <span className="text-blue-300 truncate">{activeTask.activeForm}</span>
                </div>
              )}
            </div>
          ) : progress ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{progress.phase}</span>
                <span className="text-blue-400 font-medium">{progress.percent}%</span>
              </div>
              <div className="h-1.5 bg-gray-600 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-500 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" />
              <span>Initializing agent...</span>
            </div>
          )}
        </div>
      )}

      {/* Status info */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <div className="flex items-center gap-2">
          {/* Pause/Resume button - for backlog and in_review states */}
          {(ticket.state === 'backlog' || ticket.state === 'in_review') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (Boolean(ticket.paused)) {
                  send({ type: 'resume_ticket', ticketId: ticket.id });
                } else {
                  send({ type: 'pause_ticket', ticketId: ticket.id, reason: 'Manual verification needed' });
                }
              }}
              className={`shrink-0 p-1 rounded transition-colors ${
                Boolean(ticket.paused)
                  ? 'text-yellow-400 bg-yellow-900/50 hover:bg-yellow-900'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
              title={Boolean(ticket.paused) ? 'Resume autoplay for this ticket' : 'Pause autoplay for this ticket'}
            >
              {Boolean(ticket.paused) ? <PlayCircle size={14} /> : <Pause size={14} />}
            </button>
          )}

          {/* Priority badge - click to cycle */}
          <button
            onClick={cyclePriority}
            className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${getPriorityInfo(ticket.priority || 'medium').color}`}
            title={`${getPriorityInfo(ticket.priority || 'medium').label} (click to change)`}
          >
            {getPriorityInfo(ticket.priority || 'medium').icon}
          </button>

          {ticket.state === 'in_progress' && ticket.worktree_slot && (
            <span className="flex items-center gap-1 text-blue-400">
              <GitBranch size={12} />
              Slot {ticket.worktree_slot}
            </span>
          )}

          {ticket.state === 'in_review' && (
            <>
              {ticket.current_score !== null ? (
                <span className={`flex items-center gap-1 ${getScoreColor(ticket.current_score)}`}>
                  {ticket.current_score >= 90 ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {ticket.current_score}/100
                </span>
              ) : (
                <span className="flex items-center gap-1 text-yellow-400">
                  <Clock size={12} />
                  Awaiting review
                </span>
              )}
            </>
          )}

          {ticket.state === 'done' && ticket.current_score !== null && (
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle2 size={12} />
              {ticket.current_score}/100
            </span>
          )}

          {ticket.attempt_count > 1 && (
            <span className="text-orange-400">
              Attempt {ticket.attempt_count}
            </span>
          )}
        </div>

        <span>{getTimeAgo(ticket.updated_at)}</span>
      </div>

      {/* PR link - compact button to avoid accidental clicks */}
      {ticket.pr_url && (
        <a
          href={ticket.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 inline-flex items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 bg-gray-700/50 hover:bg-gray-700 rounded transition-colors w-fit"
        >
          <GitBranch size={12} />
          View PR
          <ExternalLink size={10} />
        </a>
      )}

      {/* Actions - only show margin if we have buttons */}
      {((ticket.state === 'backlog' && onStart) || (ticket.state === 'in_progress' && needsAttention && onRetry)) && (
      <div className="mt-2 flex gap-2">
        {ticket.state === 'backlog' && onStart && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isPipelinePaused) return; // Don't start normally when paused
                setPendingAction('starting');
                onStart(false);
              }}
              disabled={!slotsAvailable || pendingAction === 'starting' || isPipelinePaused}
              title={isPipelinePaused ? 'Pipeline is paused' : undefined}
              className={`
                flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-sm font-medium
                ${!slotsAvailable || pendingAction === 'starting' || isPipelinePaused
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  : 'bg-green-600 hover:bg-green-500 text-white'}
              `}
            >
              {pendingAction === 'starting' ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Starting...
                </>
              ) : isPipelinePaused ? (
                <>
                  <Play size={14} />
                  Paused
                </>
              ) : (
                <>
                  <Play size={14} />
                  Start
                </>
              )}
            </button>
            {isPipelinePaused && slotsAvailable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingAction('starting');
                  onStart(true); // Force start
                }}
                disabled={pendingAction === 'starting'}
                title="Start anyway (for fix PRs)"
                className={`
                  flex items-center justify-center gap-1 px-2 py-1.5 rounded text-sm font-medium
                  ${pendingAction === 'starting'
                    ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                    : 'bg-yellow-600 hover:bg-yellow-500 text-white'}
                `}
              >
                <Play size={14} />
                Force
              </button>
            )}
            {/* Emergency button - start with urgent priority and displacement */}
            {ticket.priority !== 'urgent' && (
              <button
                onClick={handleEmergencyStart}
                disabled={pendingAction === 'emergency_starting'}
                title="EMERGENCY: Start immediately with urgent priority, displacing other work if needed"
                className={`
                  flex items-center justify-center px-1.5 py-1 rounded text-xs
                  ${pendingAction === 'emergency_starting'
                    ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                    : 'text-gray-500 hover:text-red-400 hover:bg-red-900/30'}
                `}
              >
                {pendingAction === 'emergency_starting' ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <span>!!!</span>
                )}
              </button>
            )}
          </>
        )}

        {ticket.state === 'in_progress' && needsAttention && onRetry && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPendingAction('restarting');
              onRetry();
            }}
            disabled={pendingAction === 'restarting'}
            className={`
              flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-sm font-medium
              ${pendingAction === 'restarting'
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-orange-600 hover:bg-orange-500 text-white'}
            `}
          >
            {pendingAction === 'restarting' ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Restarting...
              </>
            ) : (
              <>
                <RotateCcw size={14} />
                Restart
              </>
            )}
          </button>
        )}
      </div>
      )}

      {/* Emergency button for needs_review tickets - skip review and start immediately */}
      {ticket.state === 'needs_review' && ticket.priority !== 'urgent' && (
        <div className="mt-2">
          <button
            onClick={handleEmergencyStart}
            disabled={pendingAction === 'emergency_starting'}
            title="EMERGENCY: Skip review, start immediately with urgent priority"
            className={`
              flex items-center justify-center gap-1 px-2 py-1 rounded text-xs
              ${pendingAction === 'emergency_starting'
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'text-gray-500 hover:text-red-400 hover:bg-red-900/30'}
            `}
          >
            {pendingAction === 'emergency_starting' ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <span>!!!</span>
                <span>Emergency</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
