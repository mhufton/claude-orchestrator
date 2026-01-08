import * as db from '../db';
import { acquireSlot, releaseSlot } from '../worktrees/pool';
import { spawnAgent, stopAgent } from '../agents/spawner';
import { spawnBatchAgent, stopBatchAgent } from '../agents/batch-spawner';
import { broadcastTicketUpdated, broadcastSlotStatus, broadcast } from '../ws/handler';
import type { Ticket, TicketState, Batch, BatchState } from './types';

export interface TransitionResult {
  success: boolean;
  error?: string;
  newState?: TicketState;
}

/**
 * Start a ticket - move from backlog to in_progress
 */
export async function startTicket(ticketId: number): Promise<TransitionResult> {
  const ticket = db.getTicketById(ticketId);

  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  if (ticket.state !== 'backlog') {
    return { success: false, error: `Cannot start ticket in state: ${ticket.state}` };
  }

  // Check for unresolved dependencies (blockers)
  const deps = db.getDependenciesForTicket(ticketId);
  if (deps.blockedBy.length > 0) {
    // Check if any blocking tickets are not done
    const unresolvedBlockers: number[] = [];
    for (const blockerId of deps.blockedBy) {
      const blocker = db.getTicketById(blockerId);
      if (blocker && blocker.state !== 'done') {
        unresolvedBlockers.push(blocker.github_issue_number);
      }
    }
    if (unresolvedBlockers.length > 0) {
      return {
        success: false,
        error: `Blocked by unfinished ticket(s): #${unresolvedBlockers.join(', #')}`
      };
    }
  }

  // Generate branch name
  const branchName = `claude/${ticket.github_issue_number}`;

  // Acquire a worktree slot
  const allocation = await acquireSlot(ticketId, branchName);

  if (!allocation) {
    return { success: false, error: 'No worktree slots available' };
  }

  // Update ticket state
  db.updateTicket(ticketId, {
    state: 'in_progress',
    worktree_slot: allocation.slot,
    branch_name: branchName,
    attempt_count: ticket.attempt_count + 1
  });

  broadcastTicketUpdated(ticketId, {
    state: 'in_progress',
    worktree_slot: allocation.slot,
    branch_name: branchName,
    attempt_count: ticket.attempt_count + 1
  });

  // Update slot status in sidebar
  broadcastSlotStatus();

  // Spawn the agent (don't await - let it run in background)
  spawnAgent(db.getTicketById(ticketId)!).catch(error => {
    console.error(`Agent spawn failed for ticket ${ticketId}:`, error);
  });

  return { success: true, newState: 'in_progress' };
}

/**
 * Stop a ticket - kill the agent and release the slot
 */
export async function stopTicket(ticketId: number): Promise<TransitionResult> {
  const ticket = db.getTicketById(ticketId);

  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  if (ticket.state !== 'in_progress' && ticket.state !== 'in_review') {
    return { success: false, error: `Cannot stop ticket in state: ${ticket.state}` };
  }

  // Stop the agent if running
  stopAgent(ticketId);

  // Release the worktree slot
  if (ticket.worktree_slot) {
    await releaseSlot(ticket.worktree_slot);
  }

  // Move back to backlog
  db.updateTicket(ticketId, {
    state: 'backlog',
    worktree_slot: null
  });

  broadcastTicketUpdated(ticketId, {
    state: 'backlog',
    worktree_slot: null
  });

  broadcastSlotStatus();

  return { success: true, newState: 'backlog' };
}

/**
 * Retry a ticket - restart the agent with the existing worktree
 * If ticket is part of a failed batch, retries the entire batch
 * @param ticketId - The ticket to retry
 * @param command - Optional command/instructions to pass to the agent
 */
export async function retryTicket(ticketId: number, command?: string): Promise<TransitionResult> {
  const ticket = db.getTicketById(ticketId);

  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  // Check if ticket is part of a batch - if so, retry ALL tickets in the batch
  if (ticket.batch_id) {
    const batchTickets = db.getTicketsInBatch(ticket.batch_id);
    const otherTickets = batchTickets.filter(t => t.id !== ticketId);

    if (otherTickets.length > 0) {
      console.log(`[retry] Ticket ${ticketId} is part of batch ${ticket.batch_id}, also retrying ${otherTickets.length} other ticket(s)`);

      // Clear attention flags and prepare all batch tickets for retry
      for (const other of otherTickets) {
        // Only update tickets that need it (have attention flags or are in backlog)
        if (other.needs_attention || other.state === 'backlog') {
          db.updateTicket(other.id, {
            needs_attention: 0,
            attention_reason: null
          });

          broadcastTicketUpdated(other.id, {
            needs_attention: false,
            attention_reason: null
          });

          console.log(`[retry] Cleared attention for batch ticket ${other.id} (#${other.github_issue_number})`);
        }
      }
    }
  }

  // Allow retry from in_progress (retry stuck agent) or in_review (address feedback)
  // or backlog (for individual tickets or after batch failure)
  const allowedStates: TicketState[] = ['in_progress', 'in_review', 'backlog'];
  if (!allowedStates.includes(ticket.state)) {
    return { success: false, error: `Cannot retry ticket in state: ${ticket.state}` };
  }

  // Stop any running agent
  stopAgent(ticketId);

  // If a command was provided, store it as a pending chat message
  // This will be picked up by getRetryContext and included in the agent prompt
  if (command?.trim()) {
    db.insertChatMessage(ticketId, 'user', command.trim(), true);
    console.log(`[retry] Stored command for ticket ${ticketId}: "${command.trim().substring(0, 50)}..."`);
  }

  // If ticket doesn't have a worktree slot, acquire one
  let updatedTicket = ticket;
  if (!ticket.worktree_slot) {
    const branchName = ticket.branch_name || `claude/${ticket.github_issue_number}`;
    const allocation = await acquireSlot(ticketId, branchName);

    if (!allocation) {
      return { success: false, error: 'No worktree slots available' };
    }

    db.updateTicket(ticketId, {
      state: 'in_progress',
      worktree_slot: allocation.slot,
      branch_name: branchName
    });

    broadcastTicketUpdated(ticketId, {
      state: 'in_progress',
      worktree_slot: allocation.slot,
      branch_name: branchName
    });

    broadcastSlotStatus();
    updatedTicket = db.getTicketById(ticketId)!;
  }

  // Increment attempt count and clear needs_attention flag
  db.updateTicket(ticketId, {
    state: 'in_progress',
    attempt_count: updatedTicket.attempt_count + 1,
    needs_attention: 0,
    attention_reason: null
  });

  broadcastTicketUpdated(ticketId, {
    state: 'in_progress',
    attempt_count: updatedTicket.attempt_count + 1,
    needs_attention: false,
    attention_reason: null
  });

  // Spawn a new agent
  spawnAgent(db.getTicketById(ticketId)!).catch(error => {
    console.error(`Agent spawn failed for ticket ${ticketId}:`, error);
  });

  return { success: true, newState: 'in_progress' };
}

/**
 * Archive a ticket - move to done without merging
 */
export async function archiveTicket(ticketId: number): Promise<TransitionResult> {
  const ticket = db.getTicketById(ticketId);

  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  // Stop agent if running
  stopAgent(ticketId);

  // Release slot if assigned
  if (ticket.worktree_slot) {
    await releaseSlot(ticket.worktree_slot);
  }

  // Move to done
  db.updateTicket(ticketId, {
    state: 'done',
    worktree_slot: null
  });

  broadcastTicketUpdated(ticketId, {
    state: 'done',
    worktree_slot: null
  });

  broadcastSlotStatus();

  return { success: true, newState: 'done' };
}

/**
 * Displace a running ticket to make room for an urgent ticket.
 * Returns the displaced ticket's slot number, or null if displacement failed.
 */
export async function displaceForUrgent(urgentTicketId: number): Promise<{ slot: number; displacedTicketId: number } | null> {
  const urgentTicket = db.getTicketById(urgentTicketId);
  if (!urgentTicket) {
    console.log('[displace] Urgent ticket not found');
    return null;
  }

  // Find lowest priority running ticket
  const victim = db.getLowestPriorityRunningTicket();
  if (!victim) {
    console.log('[displace] No displaceable tickets found');
    return null;
  }

  console.log(`[displace] Displacing ticket #${victim.github_issue_number} (priority: ${victim.priority}) for urgent ticket #${urgentTicket.github_issue_number}`);

  // Stop the victim's agent
  stopAgent(victim.id);

  // Capture the slot before releasing
  const slot = victim.worktree_slot!;

  // Release the worktree slot
  await releaseSlot(slot);

  // Move victim to backlog with pause reason explaining displacement
  const pauseReason = `Displaced for urgent ticket #${urgentTicket.github_issue_number}: ${urgentTicket.title}`;

  db.updateTicket(victim.id, {
    state: 'backlog',
    worktree_slot: null,
    paused: 1,
    pause_reason: pauseReason
  });

  broadcastTicketUpdated(victim.id, {
    state: 'backlog',
    worktree_slot: null,
    paused: 1,
    pause_reason: pauseReason
  });

  // Log the displacement for audit trail
  db.logStateTransition(
    victim.id,
    victim.github_issue_number,
    'state',
    'in_progress',
    'backlog',
    'autoplay',
    `Displaced for urgent ticket #${urgentTicket.github_issue_number}`
  );

  // Broadcast activity
  broadcast({
    type: 'activity',
    activity: {
      timestamp: Date.now(),
      type: 'respawn',
      message: `Displaced #${victim.github_issue_number} for urgent #${urgentTicket.github_issue_number}`
    }
  });

  broadcastSlotStatus();

  return { slot, displacedTicketId: victim.id };
}

// ============================================
// Batch Lifecycle Functions
// ============================================

export interface BatchTransitionResult {
  success: boolean;
  error?: string;
  newState?: BatchState;
}

/**
 * Start a batch - move from pending to in_progress, spawn batch agent
 */
export async function startBatch(batchId: number): Promise<BatchTransitionResult> {
  const batch = db.getBatchById(batchId);

  if (!batch) {
    return { success: false, error: 'Batch not found' };
  }

  if (batch.state !== 'pending') {
    return { success: false, error: `Cannot start batch in state: ${batch.state}` };
  }

  // Get all tickets in batch
  const tickets = db.getTicketsInBatch(batchId);
  if (tickets.length === 0) {
    return { success: false, error: 'Batch has no tickets' };
  }

  // Check dependencies for ALL tickets in the batch
  for (const ticket of tickets) {
    const deps = db.getDependenciesForTicket(ticket.id);
    if (deps.blockedBy.length > 0) {
      const unresolvedBlockers: number[] = [];
      for (const blockerId of deps.blockedBy) {
        const blocker = db.getTicketById(blockerId);
        if (blocker && blocker.state !== 'done') {
          unresolvedBlockers.push(blocker.github_issue_number);
        }
      }
      if (unresolvedBlockers.length > 0) {
        return {
          success: false,
          error: `Ticket #${ticket.github_issue_number} is blocked by: #${unresolvedBlockers.join(', #')}`
        };
      }
    }
  }

  // Generate batch branch name
  const branchName = `claude/batch-${batchId}`;

  // Acquire a worktree slot (one slot for entire batch)
  const allocation = await acquireSlot(batchId, branchName, 'batch');

  if (!allocation) {
    return { success: false, error: 'No worktree slots available' };
  }

  // Update batch state
  db.updateBatch(batchId, {
    state: 'in_progress',
    worktree_slot: allocation.slot,
    branch_name: branchName,
    attempt_count: batch.attempt_count + 1
  });

  // Update all tickets in batch to in_progress
  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      state: 'in_progress',
      worktree_slot: allocation.slot,
      branch_name: branchName
    });

    broadcastTicketUpdated(ticket.id, {
      state: 'in_progress',
      worktree_slot: allocation.slot,
      branch_name: branchName
    });

    // Log state transition for each ticket
    db.logStateTransition(
      ticket.id,
      ticket.github_issue_number,
      'state',
      'backlog',
      'in_progress',
      'autoplay',
      `Started as part of batch ${batchId}`
    );
  }

  // Broadcast batch started
  broadcast({
    type: 'batch_started',
    batchId,
    ticketIds: tickets.map(t => t.id)
  });

  broadcastSlotStatus();

  // Spawn batch agent (don't await - let it run in background)
  const updatedBatch = db.getBatchById(batchId)!;
  spawnBatchAgent(updatedBatch, tickets).catch(error => {
    console.error(`Batch agent spawn failed for batch ${batchId}:`, error);
  });

  console.log(`[batch] Started batch ${batchId} with ${tickets.length} tickets in slot ${allocation.slot}`);

  return { success: true, newState: 'in_progress' };
}

/**
 * Fail a batch - ALL tickets go back to backlog (all-or-nothing)
 */
export async function failBatch(batchId: number, reason: string): Promise<BatchTransitionResult> {
  const batch = db.getBatchById(batchId);

  if (!batch) {
    return { success: false, error: 'Batch not found' };
  }

  const tickets = db.getTicketsInBatch(batchId);

  // Stop batch agent
  stopBatchAgent(batchId);

  // Release slot
  if (batch.worktree_slot) {
    await releaseSlot(batch.worktree_slot);
  }

  // Move ALL tickets back to backlog (all-or-nothing)
  // Keep batch_id so users can restart the whole batch by clicking retry on any ticket
  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      state: 'backlog',
      worktree_slot: null,
      needs_attention: 1,
      attention_reason: `Batch failed: ${reason}`
    });

    broadcastTicketUpdated(ticket.id, {
      state: 'backlog',
      worktree_slot: null,
      needs_attention: true,
      attention_reason: `Batch failed: ${reason}`
    });

    // Log state transition
    db.logStateTransition(
      ticket.id,
      ticket.github_issue_number,
      'state',
      ticket.state,
      'backlog',
      'autoplay',
      `Batch ${batchId} failed: ${reason}`
    );
  }

  // Mark batch as failed
  db.updateBatch(batchId, {
    state: 'failed',
    worktree_slot: null,
    needs_attention: 1,
    attention_reason: reason
  });

  // Broadcast batch failed
  broadcast({
    type: 'batch_failed',
    batchId,
    reason,
    ticketIds: tickets.map(t => t.id)
  });

  broadcastSlotStatus();

  console.log(`[batch] Failed batch ${batchId}: ${reason}`);

  return { success: true, newState: 'failed' };
}

/**
 * Retry a batch - reset batch and all tickets to pending, ready for autoplay to pick up
 */
export async function retryBatch(batchId: number): Promise<BatchTransitionResult> {
  const batch = db.getBatchById(batchId);

  if (!batch) {
    return { success: false, error: 'Batch not found' };
  }

  if (batch.state !== 'failed') {
    return { success: false, error: `Cannot retry batch in state: ${batch.state}` };
  }

  const tickets = db.getTicketsInBatch(batchId);

  // Reset batch to pending
  db.updateBatch(batchId, {
    state: 'pending',
    attempt_count: batch.attempt_count + 1,
    needs_attention: 0,
    attention_reason: null
  });

  // Reset all tickets - clear attention flags but keep in backlog with batch_id
  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      needs_attention: 0,
      attention_reason: null
    });

    // Broadcast full ticket update so UI refreshes for all tickets in batch
    broadcastTicketUpdated(ticket.id, {
      needs_attention: false,
      attention_reason: null,
      state: 'backlog'  // Confirm state for UI
    });

    // Log retry
    db.logStateTransition(
      ticket.id,
      ticket.github_issue_number,
      'batch_id',
      batchId,
      batchId,
      'user-retry',
      `Retrying batch ${batchId}`
    );
  }

  // Broadcast batch retry event so UI knows all tickets in batch are being retried
  broadcast({
    type: 'batch_started',  // Reuse batch_started to indicate batch is queued again
    batchId,
    ticketIds: tickets.map(t => t.id)
  });

  console.log(`[batch] Retrying batch ${batchId} with ${tickets.length} tickets (attempt ${batch.attempt_count + 1})`);

  // Autoplay will pick up the pending batch on next cycle
  return { success: true, newState: 'pending' };
}

/**
 * Complete a batch - all tickets move to done
 */
export async function completeBatch(batchId: number): Promise<BatchTransitionResult> {
  const batch = db.getBatchById(batchId);

  if (!batch) {
    return { success: false, error: 'Batch not found' };
  }

  const tickets = db.getTicketsInBatch(batchId);

  // Release slot
  if (batch.worktree_slot) {
    await releaseSlot(batch.worktree_slot);
  }

  // Move ALL tickets to done
  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      state: 'done',
      worktree_slot: null,
      pr_number: batch.pr_number,
      pr_url: batch.pr_url
    });

    broadcastTicketUpdated(ticket.id, {
      state: 'done',
      worktree_slot: null,
      pr_number: batch.pr_number,
      pr_url: batch.pr_url
    });

    // Log state transition
    db.logStateTransition(
      ticket.id,
      ticket.github_issue_number,
      'state',
      ticket.state,
      'done',
      'pr-watcher',
      `Batch ${batchId} completed`
    );

    // Archive old logs
    db.archiveTicketLogs(ticket.id);
  }

  // Mark batch as done
  db.updateBatch(batchId, {
    state: 'done',
    worktree_slot: null
  });

  // Broadcast batch completed
  broadcast({
    type: 'batch_completed',
    batchId,
    ticketIds: tickets.map(t => t.id)
  });

  broadcastSlotStatus();

  console.log(`[batch] Completed batch ${batchId} with ${tickets.length} tickets`);

  return { success: true, newState: 'done' };
}

/**
 * Move batch to in_review state (PR created)
 */
export function moveBatchToReview(batchId: number, prNumber: number, prUrl: string): BatchTransitionResult {
  const batch = db.getBatchById(batchId);

  if (!batch) {
    return { success: false, error: 'Batch not found' };
  }

  const tickets = db.getTicketsInBatch(batchId);

  // Update batch state
  db.updateBatch(batchId, {
    state: 'in_review',
    pr_number: prNumber,
    pr_url: prUrl
  });

  // Update all tickets to in_review with PR info
  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      state: 'in_review',
      pr_number: prNumber,
      pr_url: prUrl
    });

    broadcastTicketUpdated(ticket.id, {
      state: 'in_review',
      pr_number: prNumber,
      pr_url: prUrl
    });
  }

  // Broadcast batch moved to review
  broadcast({
    type: 'batch_in_review',
    batchId,
    prNumber,
    prUrl,
    ticketIds: tickets.map(t => t.id)
  });

  console.log(`[batch] Batch ${batchId} moved to review (PR #${prNumber})`);

  return { success: true, newState: 'in_review' };
}
