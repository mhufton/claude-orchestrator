/**
 * Proactive branch updater - keeps PR branches in sync with dev
 *
 * This runs periodically and updates any PR branches that are behind.
 * Much more reliable than having agents do git rebases.
 *
 * Benefits:
 * - No agent slots consumed
 * - No attempt counts burned
 * - Faster than waiting for pr-watcher to detect "behind" state
 * - Works even when agents aren't running
 */

import * as github from './client';
import * as db from '../db';
import { broadcastTicketUpdated } from '../ws/handler';
import { addActivity } from '../poll-status';

const UPDATE_INTERVAL_MS = 60000; // Check every 60 seconds

/**
 * Update all PR branches that are behind dev
 */
async function updateBehindBranches(): Promise<void> {
  // Get all tickets with PRs that are in active states
  const activeTickets = [
    ...db.getTicketsByState('in_progress'),
    ...db.getTicketsByState('in_review')
  ].filter(t => t.pr_number);

  for (const ticket of activeTickets) {
    if (!ticket.pr_number) continue;

    try {
      const pr = await github.getPR(ticket.pr_number);

      // Skip if PR is merged or closed
      if (pr.merged || pr.state === 'closed') continue;

      // Check if behind
      if (pr.mergeable_state === 'behind') {
        console.log(`[branch-updater] PR #${ticket.pr_number} is behind dev, updating...`);

        const result = await github.updatePRBranch(ticket.pr_number);

        if (result.success) {
          console.log(`[branch-updater] Successfully updated PR #${ticket.pr_number}`);
          addActivity('branch_update', `Auto-updated PR #${ticket.pr_number} to latest dev`);

          // Clear any "behind" attention flags
          if (ticket.needs_attention && ticket.attention_reason?.includes('behind')) {
            db.updateTicket(ticket.id, {
              needs_attention: 0,
              attention_reason: null
            });
            broadcastTicketUpdated(ticket.id, {
              needs_attention: 0,
              attention_reason: null
            });
          }
        } else {
          // Update failed - likely has conflicts
          console.log(`[branch-updater] Failed to update PR #${ticket.pr_number}: ${result.message}`);

          // Only flag if not already flagged
          if (!ticket.needs_attention) {
            db.updateTicket(ticket.id, {
              needs_attention: 1,
              attention_reason: `Branch update failed: ${result.message} - may need manual conflict resolution`
            });
            broadcastTicketUpdated(ticket.id, {
              needs_attention: 1,
              attention_reason: `Branch update failed: ${result.message} - may need manual conflict resolution`
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[branch-updater] Error checking PR #${ticket.pr_number}:`, err);
    }
  }
}

/**
 * Start the proactive branch update loop
 */
export function startBranchUpdateLoop(): void {
  console.log(`[branch-updater] Starting proactive branch update loop (interval: ${UPDATE_INTERVAL_MS}ms)`);

  // Run immediately on start
  updateBehindBranches().catch(err => {
    console.error('[branch-updater] Error in initial run:', err);
  });

  // Then run periodically
  setInterval(() => {
    updateBehindBranches().catch(err => {
      console.error('[branch-updater] Error in update loop:', err);
    });
  }, UPDATE_INTERVAL_MS);
}
