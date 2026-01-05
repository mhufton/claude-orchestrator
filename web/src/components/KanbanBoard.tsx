import { useState, useMemo } from 'react';
import { Loader2, Play } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useTicketsStore } from '../stores/tickets';
import { useWebSocket } from '../hooks/useWebSocket';
import { DroppableColumn } from './DroppableColumn';
import { SortableTicketCard } from './SortableTicketCard';
import { TicketCard } from './TicketCard';
import { LogViewer } from './LogViewer';
import { PRDetailView } from './PRDetailView';
import { AttentionDialog } from './AttentionDialog';
import { PipelinePauseBanner } from './PipelinePauseBanner';
import { MoveConfirmDialog } from './MoveConfirmDialog';
import type { TicketState } from '../lib/types';

const columns: Array<{ state: TicketState; title: string; color: string }> = [
  { state: 'needs_review', title: 'Triage', color: 'bg-purple-400' },
  { state: 'backlog', title: 'Ready', color: 'bg-gray-400' },
  { state: 'in_progress', title: 'In Progress', color: 'bg-blue-400' },
  { state: 'in_review', title: 'In Review', color: 'bg-yellow-400' },
  { state: 'done', title: 'Done', color: 'bg-green-400' }
];

interface PendingMove {
  ticketId: number;
  ticketNumber: number;
  ticketTitle: string;
  fromState: TicketState;
  toState: TicketState;
}

export function KanbanBoard() {
  const { send } = useWebSocket();
  const tickets = useTicketsStore(state => state.tickets);
  const getTicketsByState = useTicketsStore(state => state.getTicketsByState);
  const slots = useTicketsStore(state => state.slots);
  const selectedTicketId = useTicketsStore(state => state.selectedTicketId);
  const selectTicket = useTicketsStore(state => state.selectTicket);
  const reviewQueueIds = useTicketsStore(state => state.reviewQueueIds);
  const reviewProgress = useTicketsStore(state => state.reviewProgress);
  const toggleReviewQueue = useTicketsStore(state => state.toggleReviewQueue);
  const clearReviewQueue = useTicketsStore(state => state.clearReviewQueue);
  const setReviewProgress = useTicketsStore(state => state.setReviewProgress);
  const pipelineStatus = useTicketsStore(state => state.pipelineStatus);
  const [showingLogsForAttention, setShowingLogsForAttention] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const slotsAvailable = slots.some(s => s.available);
  const isPipelinePaused = pipelineStatus.paused;

  // Configure sensors for drag detection
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before starting drag
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Get the active ticket being dragged
  const activeTicket = useMemo(() => {
    if (!activeId) return null;
    return tickets.find(t => t.id === activeId);
  }, [activeId, tickets]);

  // Get issue numbers for selected review queue items
  const reviewQueueIssueNumbers = tickets
    .filter(t => reviewQueueIds.has(t.id))
    .map(t => t.github_issue_number);

  const handleStartBatchReview = () => {
    if (reviewQueueIssueNumbers.length === 0) return;
    const ticketIds = Array.from(reviewQueueIds);
    setReviewProgress({
      inProgress: true,
      activeTicketIds: new Set(ticketIds),
      completedCount: 0,
      totalCount: ticketIds.length,
      results: new Map(),
      output: ''
    });
    send({
      type: 'batch_review',
      ticketIds,
      issueNumbers: reviewQueueIssueNumbers
    });
  };

  // Get issue numbers being reviewed for display
  const reviewingIssueNumbers = tickets
    .filter(t => reviewProgress.activeTicketIds.has(t.id))
    .map(t => t.github_issue_number);

  const handleStart = (ticketId: number, force: boolean = false) => {
    selectTicket(null); // Don't auto-open log viewer
    send({ type: 'start_ticket', ticketId, force });
  };

  const handleRetry = (ticketId: number) => {
    send({ type: 'retry_ticket', ticketId });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as number);
  };

  const handleDragOver = (_event: DragOverEvent) => {
    // Visual feedback is handled by DroppableColumn's isOver state
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const ticketId = active.id as number;
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return;

    // Determine target column from the data property
    const overData = over.data.current;
    let targetState: TicketState | null = null;

    if (overData?.type === 'column') {
      // Dropped directly on a column
      targetState = overData.state as TicketState;
    } else if (overData?.type === 'ticket') {
      // Dropped on another ticket - use its column
      targetState = overData.state as TicketState;
    } else {
      // Fallback: check ID format
      const overId = String(over.id);
      if (overId.startsWith('column-')) {
        targetState = overId.replace('column-', '') as TicketState;
      } else {
        const targetTicket = tickets.find(t => t.id === over.id);
        if (targetTicket) {
          targetState = targetTicket.state;
        }
      }
    }

    if (!targetState || targetState === ticket.state) {
      // Same column - handle reorder
      // Only reorder if we dropped on another ticket (not on the column itself)
      if (overData?.type === 'ticket' && over.id !== active.id) {
        const columnTickets = getTicketsByState(ticket.state);
        const oldIndex = columnTickets.findIndex(t => t.id === ticketId);
        const newIndex = columnTickets.findIndex(t => t.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          // Reorder within column
          const newOrder = [...columnTickets];
          const [removed] = newOrder.splice(oldIndex, 1);
          newOrder.splice(newIndex, 0, removed);

          // Optimistic update - update positions immediately in the store
          const updateTicket = useTicketsStore.getState().updateTicket;
          newOrder.forEach((t, i) => updateTicket(t.id, { position: i }));

          send({
            type: 'reorder_tickets',
            state: ticket.state,
            ticketIds: newOrder.map(t => t.id)
          });
        }
      }
      return;
    }

    // Cross-column move - show confirmation
    setPendingMove({
      ticketId,
      ticketNumber: ticket.github_issue_number,
      ticketTitle: ticket.title,
      fromState: ticket.state,
      toState: targetState,
    });
  };

  const handleConfirmMove = () => {
    if (!pendingMove) return;

    send({
      type: 'move_ticket',
      ticketId: pendingMove.ticketId,
      toState: pendingMove.toState,
    });

    setPendingMove(null);
  };

  const handleCancelMove = () => {
    setPendingMove(null);
  };

  const selectedTicket = tickets.find(t => t.id === selectedTicketId);

  // Determine which dialog to show
  const showAttentionDialog = selectedTicket?.needs_attention && !showingLogsForAttention;
  const showLogViewer = selectedTicket && !selectedTicket.needs_attention || showingLogsForAttention;
  const showPRDetailView = false; // Disabled - now using unified LogViewer with PR tab

  return (
    <div className="flex flex-col h-full">
      <PipelinePauseBanner />
      <DndContext
        sensors={sensors}
        collisionDetection={rectIntersection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 flex gap-3 p-4 min-h-0 overflow-hidden">
          {columns.map(column => {
            const columnTickets = getTicketsByState(column.state);
            const ticketIds = columnTickets.map(t => t.id);
            const isNeedsReviewColumn = column.state === 'needs_review';

            return (
              <DroppableColumn
                key={column.state}
                state={column.state}
                title={column.title}
                count={columnTickets.length}
                color={column.color}
                ticketIds={ticketIds}
                headerContent={
                  isNeedsReviewColumn && columnTickets.length > 0 && (
                    <div className="mb-3 p-2 bg-purple-900/30 rounded-lg border border-purple-700/50">
                      {reviewProgress.inProgress ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Loader2 size={14} className="animate-spin text-purple-400" />
                            <span className="text-sm text-purple-300 font-medium">
                              Reviewing {reviewProgress.completedCount}/{reviewProgress.totalCount}
                            </span>
                          </div>
                          {reviewingIssueNumbers.length > 0 && (
                            <div className="text-xs text-gray-400">
                              Active: #{reviewingIssueNumbers.join(', #')}
                            </div>
                          )}
                          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-500 transition-all duration-300"
                              style={{ width: `${(reviewProgress.completedCount / reviewProgress.totalCount) * 100}%` }}
                            />
                          </div>
                          {reviewProgress.output && (
                            <div className="text-xs text-gray-500 truncate max-w-full">
                              {reviewProgress.output.split('\n').slice(-1)[0]?.slice(0, 60)}...
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  // Toggle all: if all selected, clear; otherwise select all
                                  const allSelected = columnTickets.every(t => reviewQueueIds.has(t.id));
                                  if (allSelected) {
                                    clearReviewQueue();
                                  } else {
                                    columnTickets.forEach(t => {
                                      if (!reviewQueueIds.has(t.id)) {
                                        toggleReviewQueue(t.id);
                                      }
                                    });
                                  }
                                }}
                                className="text-xs text-purple-400 hover:text-purple-300"
                              >
                                {columnTickets.every(t => reviewQueueIds.has(t.id)) ? 'Deselect All' : 'Select All'}
                              </button>
                              <span className="text-sm text-purple-300">
                                {reviewQueueIds.size > 0
                                  ? `${reviewQueueIds.size}/${columnTickets.length} selected`
                                  : 'Select issues to review'}
                              </span>
                            </div>
                            {reviewQueueIds.size > 0 && (
                              <button
                                onClick={() => clearReviewQueue()}
                                className="text-xs text-gray-400 hover:text-gray-200"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          <button
                            onClick={handleStartBatchReview}
                            disabled={reviewQueueIds.size === 0}
                            className={`
                              w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-sm font-medium
                              ${reviewQueueIds.size === 0
                                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                                : 'bg-purple-600 hover:bg-purple-500 text-white'}
                            `}
                          >
                            <Play size={14} />
                            Start Batch Review
                          </button>
                          <p className="text-xs text-gray-500 mt-2 text-center">
                            Lightweight agent - doesn't use worktree slots
                          </p>
                        </>
                      )}
                    </div>
                  )
                }
              >
                {columnTickets.map(ticket => {
                  const isBeingReviewed = reviewProgress.activeTicketIds.has(ticket.id);
                  const reviewResult = reviewProgress.results.get(ticket.id);
                  return (
                    <SortableTicketCard
                      key={ticket.id}
                      ticket={ticket}
                      isSelected={ticket.id === selectedTicketId}
                      slotsAvailable={slotsAvailable}
                      onSelect={() => {
                        setShowingLogsForAttention(false);
                        selectTicket(ticket.id === selectedTicketId ? null : ticket.id);
                      }}
                      onStart={column.state === 'backlog' ? (force) => handleStart(ticket.id, force) : undefined}
                      onRetry={column.state === 'in_progress' ? () => handleRetry(ticket.id) : undefined}
                      showReviewCheckbox={isNeedsReviewColumn}
                      isInReviewQueue={reviewQueueIds.has(ticket.id)}
                      onToggleReviewQueue={() => toggleReviewQueue(ticket.id)}
                      isPipelinePaused={isPipelinePaused}
                      isBeingReviewed={isBeingReviewed}
                      reviewResult={reviewResult}
                    />
                  );
                })}

                {columnTickets.length === 0 && (
                  <div className="text-center text-gray-600 py-8 text-sm">
                    No tickets
                  </div>
                )}
              </DroppableColumn>
            );
          })}
        </div>

        {/* Drag overlay - shows dragged card */}
        <DragOverlay>
          {activeTicket && (
            <div className="opacity-90 rotate-2 shadow-2xl">
              <TicketCard
                ticket={activeTicket}
                isSelected={false}
                slotsAvailable={false}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Move confirmation dialog */}
      <MoveConfirmDialog
        isOpen={pendingMove !== null}
        ticketNumber={pendingMove?.ticketNumber ?? 0}
        ticketTitle={pendingMove?.ticketTitle ?? ''}
        fromState={pendingMove?.fromState ?? 'backlog'}
        toState={pendingMove?.toState ?? 'backlog'}
        onConfirm={handleConfirmMove}
        onCancel={handleCancelMove}
      />

      {/* Show AttentionDialog for flagged tickets */}
      {showAttentionDialog && selectedTicket && (
        <AttentionDialog
          ticket={selectedTicket}
          onClose={() => {
            setShowingLogsForAttention(false);
            selectTicket(null);
          }}
          onViewLogs={() => setShowingLogsForAttention(true)}
        />
      )}

      {/* Show LogViewer for in_progress tickets or when viewing logs from attention */}
      {showLogViewer && selectedTicket && (
        <LogViewer
          ticketId={selectedTicket.id}
          onClose={() => {
            setShowingLogsForAttention(false);
            selectTicket(null);
          }}
        />
      )}

      {/* Show PRDetailView for in_review tickets */}
      {showPRDetailView && selectedTicket && (
        <PRDetailView
          ticket={selectedTicket}
          onClose={() => selectTicket(null)}
        />
      )}
    </div>
  );
}
