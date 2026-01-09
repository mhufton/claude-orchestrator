/**
 * Merge Queue Manager
 *
 * Coordinates adding PRs to the merge queue and provides
 * a unified interface for queue operations.
 */

import * as db from '../db';
import * as github from '../github/client';
import { detectLaneForPR } from './lanes';
import { broadcastMergeQueueUpdated } from '../ws/handler';
import type { MergeQueueEntry } from '../state/types';

/**
 * Add a PR to the merge queue
 */
export async function addToQueue(
  ticketId: number,
  prNumber: number,
  priority?: number
): Promise<MergeQueueEntry> {
  // Check if already in queue
  if (db.isInMergeQueue(ticketId)) {
    const existing = db.getMergeQueueEntryByTicketId(ticketId);
    if (existing) {
      console.log(`[merge-queue] Ticket ${ticketId} already in queue at position ${existing.position}`);
      return existing;
    }
  }

  // Detect lane from PR files
  const lane = await detectLaneForPR(prNumber);
  console.log(`[merge-queue] Detected lane '${lane}' for PR #${prNumber}`);

  // Get ticket's merge priority (from ticket or default to 0)
  const ticket = db.getTicketById(ticketId);
  const effectivePriority = priority ?? ticket?.merge_queue_priority ?? 0;

  // Add to queue
  const entry = db.addToMergeQueue(ticketId, prNumber, effectivePriority, lane);
  console.log(`[merge-queue] Added PR #${prNumber} to queue: position=${entry.position}, lane=${lane}, priority=${effectivePriority}`);

  // Broadcast update
  broadcastMergeQueueUpdated();

  return entry;
}

/**
 * Remove a PR from the queue
 */
export function removeFromQueue(ticketId: number): boolean {
  const removed = db.removeFromMergeQueue(ticketId);
  if (removed) {
    console.log(`[merge-queue] Removed ticket ${ticketId} from queue`);
    broadcastMergeQueueUpdated();
  }
  return removed;
}

/**
 * Set priority for a queued PR
 */
export function setPriority(ticketId: number, priority: number): boolean {
  const updated = db.setMergeQueuePriority(ticketId, priority);
  if (updated) {
    console.log(`[merge-queue] Set priority ${priority} for ticket ${ticketId}`);
    broadcastMergeQueueUpdated();
  }
  return updated;
}

/**
 * Reorder a PR in the queue
 */
export function reorder(ticketId: number, newPosition: number): boolean {
  const reordered = db.reorderMergeQueue(ticketId, newPosition);
  if (reordered) {
    console.log(`[merge-queue] Reordered ticket ${ticketId} to position ${newPosition}`);
    broadcastMergeQueueUpdated();
  }
  return reordered;
}

/**
 * Pause the merge queue
 */
export function pauseQueue(): void {
  db.setMergeQueuePaused(true);
  console.log('[merge-queue] Queue paused');
  broadcastMergeQueueUpdated();
}

/**
 * Resume the merge queue
 */
export function resumeQueue(): void {
  db.setMergeQueuePaused(false);
  console.log('[merge-queue] Queue resumed');
  broadcastMergeQueueUpdated();
}

/**
 * Check if queue is paused
 */
export function isPaused(): boolean {
  return db.isMergeQueuePaused();
}

/**
 * Get queue status for API
 */
export function getQueueStatus() {
  return db.getMergeQueueStatus();
}

/**
 * Check if a ticket is in the queue
 */
export function isInQueue(ticketId: number): boolean {
  return db.isInMergeQueue(ticketId);
}

/**
 * Get queue entry for a ticket
 */
export function getQueueEntry(ticketId: number): MergeQueueEntry | undefined {
  return db.getMergeQueueEntryByTicketId(ticketId);
}
