import * as db from '../db';
import { acquireSlot, releaseSlot } from '../worktrees/pool';
import { spawnAgent, stopAgent } from '../agents/spawner';
import { broadcastTicketUpdated, broadcastSlotStatus } from '../ws/handler';
import type { Ticket, TicketState } from './types';

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
 * @param ticketId - The ticket to retry
 * @param command - Optional command/instructions to pass to the agent
 */
export async function retryTicket(ticketId: number, command?: string): Promise<TransitionResult> {
  const ticket = db.getTicketById(ticketId);

  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }

  // Allow retry from in_progress (retry stuck agent) or in_review (address feedback)
  // or pending (force start even if no slots)
  const allowedStates: TicketState[] = ['in_progress', 'in_review', 'pending'];
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
