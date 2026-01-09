/**
 * Merge Queue Processor
 *
 * Runs periodically to process the merge queue and merge PRs
 * in FIFO order, one at a time per lane.
 */

import * as db from '../db';
import * as github from '../github/client';
import { broadcastMergeStarted, broadcastMergeCompleted, broadcastMergeQueueUpdated, broadcastTicketUpdated, broadcastSlotStatus } from '../ws/handler';
import { addActivity } from '../poll-status';
import { archiveTicket } from '../state/machine';

const PROCESS_INTERVAL_MS = 10000; // Check every 10 seconds

let processorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Process the merge queue
 * - Get the next entry ready to merge
 * - Verify it's still mergeable
 * - Perform the merge
 * - Handle success/failure
 */
async function processQueue(): Promise<void> {
  // Check if paused
  if (db.isMergeQueuePaused()) {
    return;
  }

  // Get distinct lanes with waiting entries
  const status = db.getMergeQueueStatus();
  const lanes = status.lanes.length > 0 ? status.lanes : ['default'];

  for (const lane of lanes) {
    try {
      await processLane(lane);
    } catch (err) {
      console.error(`[merge-queue] Error processing lane '${lane}':`, err);
    }
  }
}

/**
 * Process a single lane
 */
async function processLane(lane: string): Promise<void> {
  // Get next entry ready to merge in this lane
  const entry = db.getNextToMerge(lane);
  if (!entry) {
    return; // Nothing to merge in this lane
  }

  const ticket = db.getTicketById(entry.ticket_id);
  if (!ticket || !ticket.pr_number) {
    console.log(`[merge-queue] Entry ${entry.id} has no valid ticket/PR, removing`);
    db.removeFromMergeQueue(entry.ticket_id);
    broadcastMergeQueueUpdated();
    return;
  }

  console.log(`[merge-queue] Processing lane '${lane}': PR #${ticket.pr_number} (ticket #${ticket.github_issue_number})`);

  // Verify PR is still mergeable
  let pr;
  try {
    pr = await github.getPR(ticket.pr_number);
  } catch (err) {
    console.error(`[merge-queue] Failed to get PR #${ticket.pr_number}:`, err);
    return; // Try again next cycle
  }

  // Check if PR is already merged or closed
  if (pr.merged) {
    console.log(`[merge-queue] PR #${ticket.pr_number} already merged, completing entry`);
    db.completeMerge(entry.id);
    broadcastMergeQueueUpdated();

    // Archive the ticket
    await archiveTicket(entry.ticket_id);
    return;
  }

  if (pr.state === 'closed') {
    console.log(`[merge-queue] PR #${ticket.pr_number} was closed, removing from queue`);
    db.failMerge(entry.id, 'PR was closed');
    broadcastMergeQueueUpdated();
    return;
  }

  // Check if branch is behind - trigger update and wait
  if (pr.mergeable_state === 'behind') {
    console.log(`[merge-queue] PR #${ticket.pr_number} is behind, triggering branch update`);
    try {
      const updateResult = await github.updatePRBranch(ticket.pr_number);
      if (!updateResult.success) {
        console.log(`[merge-queue] Failed to update PR #${ticket.pr_number}: ${updateResult.message}`);
        // Don't fail yet - may have conflicts, will be caught by mergeable check
      }
    } catch (err) {
      console.warn(`[merge-queue] Error updating PR #${ticket.pr_number}:`, err);
    }
    return; // Wait for next cycle after update completes
  }

  // Check if PR is mergeable
  if (!pr.mergeable || pr.mergeable_state === 'dirty') {
    console.log(`[merge-queue] PR #${ticket.pr_number} has conflicts, flagging ticket`);
    db.failMerge(entry.id, 'PR has merge conflicts');
    db.updateTicket(entry.ticket_id, {
      needs_attention: 1,
      attention_reason: 'PR has merge conflicts - needs manual resolution'
    });
    broadcastTicketUpdated(entry.ticket_id, {
      needs_attention: 1,
      attention_reason: 'PR has merge conflicts - needs manual resolution'
    });
    broadcastMergeQueueUpdated();
    return;
  }

  // Check CI status
  try {
    const checkStatus = await github.getCheckStatus(pr.head.sha);
    if (checkStatus.pending) {
      console.log(`[merge-queue] PR #${ticket.pr_number} has pending CI, waiting`);
      return; // Wait for CI to complete
    }

    if (!checkStatus.allPassed) {
      console.log(`[merge-queue] PR #${ticket.pr_number} has failing CI, flagging`);
      db.failMerge(entry.id, 'CI checks failed');
      db.updateTicket(entry.ticket_id, {
        needs_attention: 1,
        attention_reason: 'CI checks failed - cannot merge'
      });
      broadcastTicketUpdated(entry.ticket_id, {
        needs_attention: 1,
        attention_reason: 'CI checks failed - cannot merge'
      });
      broadcastMergeQueueUpdated();
      return;
    }
  } catch (err) {
    console.warn(`[merge-queue] Could not check CI status for PR #${ticket.pr_number}:`, err);
    // Continue anyway - CI check might not be required
  }

  // Start the merge
  console.log(`[merge-queue] Starting merge for PR #${ticket.pr_number}`);
  if (!db.startMerging(entry.id)) {
    console.log(`[merge-queue] Failed to acquire merge lock for entry ${entry.id}`);
    return;
  }

  broadcastMergeStarted(entry.ticket_id, ticket.pr_number);
  addActivity('merge_started', `Starting merge for PR #${ticket.pr_number} (#${ticket.github_issue_number})`);

  // Perform the merge
  try {
    const result = await github.mergePR(ticket.pr_number);

    if (result.success) {
      console.log(`[merge-queue] Successfully merged PR #${ticket.pr_number}`);
      db.completeMerge(entry.id);

      broadcastMergeCompleted(entry.ticket_id, ticket.pr_number, true, 'Merged successfully');
      addActivity('merge_completed', `Merged PR #${ticket.pr_number} (#${ticket.github_issue_number})`);
      broadcastMergeQueueUpdated();

      // Archive the ticket
      await archiveTicket(entry.ticket_id);
    } else {
      const errorMsg = result.error || 'Merge failed';
      console.log(`[merge-queue] Merge failed for PR #${ticket.pr_number}: ${errorMsg}`);
      db.failMerge(entry.id, errorMsg);

      db.updateTicket(entry.ticket_id, {
        needs_attention: 1,
        attention_reason: `Merge failed: ${errorMsg}`
      });
      broadcastTicketUpdated(entry.ticket_id, {
        needs_attention: 1,
        attention_reason: `Merge failed: ${errorMsg}`
      });

      broadcastMergeCompleted(entry.ticket_id, ticket.pr_number, false, errorMsg);
      broadcastMergeQueueUpdated();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[merge-queue] Error merging PR #${ticket.pr_number}:`, err);

    db.failMerge(entry.id, errorMessage);

    db.updateTicket(entry.ticket_id, {
      needs_attention: 1,
      attention_reason: `Merge error: ${errorMessage}`
    });
    broadcastTicketUpdated(entry.ticket_id, {
      needs_attention: 1,
      attention_reason: `Merge error: ${errorMessage}`
    });

    broadcastMergeCompleted(entry.ticket_id, ticket.pr_number, false, errorMessage);
    broadcastMergeQueueUpdated();
  }
}

/**
 * Start the merge queue processor
 */
export function startMergeQueueProcessor(): void {
  if (processorInterval) {
    console.log('[merge-queue] Processor already running');
    return;
  }

  console.log(`[merge-queue] Starting processor (interval: ${PROCESS_INTERVAL_MS}ms)`);

  // Run immediately on start
  processQueue().catch(err => {
    console.error('[merge-queue] Error in initial processing:', err);
  });

  // Then run periodically
  processorInterval = setInterval(() => {
    processQueue().catch(err => {
      console.error('[merge-queue] Error in processing loop:', err);
    });
  }, PROCESS_INTERVAL_MS);
}

/**
 * Stop the merge queue processor
 */
export function stopMergeQueueProcessor(): void {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    console.log('[merge-queue] Processor stopped');
  }
}

/**
 * Check if the processor is running
 */
export function isProcessorRunning(): boolean {
  return processorInterval !== null;
}
