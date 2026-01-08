import * as db from '../db';
import { logStateTransition } from '../db';
import { spawnAgent, isAgentRunning } from '../agents/spawner';
import { runBatchReview, isReviewRunning } from '../agents/reviewer';
import { syncIssues } from '../github/issues';
import { broadcast } from '../ws/handler';
import { shouldSkipForWork, detectEpic } from '../epics/detector';
import { displaceForUrgent, startBatch } from '../state/machine';
import { findBatchableTickets, generateBatchName } from '../batching/area-detector';
import type { Ticket } from '../state/types';

// Track last sync to avoid syncing too frequently
let lastSyncTime = 0;
let consecutiveIdleSyncs = 0;
const MIN_SYNC_INTERVAL_MS = 120000; // 2 minutes minimum between syncs
const MAX_IDLE_SYNCS = 10; // Stop auto-play after this many idle syncs with no new work

let autoPlayInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the auto-play loop
 */
export function startAutoPlay(): void {
  const settings = db.getSettings();

  if (autoPlayInterval) {
    console.log('[autoplay] Already running, restarting with new settings');
    stopAutoPlay();
  }

  console.log(`[autoplay] Starting auto-play loop (interval: ${settings.autoPlayIntervalMs}ms)`);

  // Run immediately, then on interval
  runAutoPlayCycle();

  autoPlayInterval = setInterval(() => {
    runAutoPlayCycle();
  }, settings.autoPlayIntervalMs);

  broadcast({ type: 'autoplay_started' });
}

/**
 * Stop the auto-play loop
 */
export function stopAutoPlay(): void {
  if (autoPlayInterval) {
    clearInterval(autoPlayInterval);
    autoPlayInterval = null;
    console.log('[autoplay] Stopped auto-play loop');
    broadcast({ type: 'autoplay_stopped' });
  }
}

/**
 * Check if auto-play is currently active
 */
export function isAutoPlayActive(): boolean {
  return autoPlayInterval !== null;
}

/**
 * Single cycle of the auto-play loop
 */
async function runAutoPlayCycle(): Promise<void> {
  // Prevent overlapping cycles
  if (isRunning) {
    console.log('[autoplay] Previous cycle still running, skipping');
    return;
  }

  isRunning = true;

  try {
    // Check if pipeline is paused
    const pipelinePaused = db.getSyncState('pipeline_paused') === 'true';
    if (pipelinePaused) {
      console.log('[autoplay] Pipeline is paused, skipping cycle');
      return;
    }

    // Check if autoplay is still enabled (could have been disabled mid-cycle)
    const settings = db.getSettings();
    if (!settings.autoPlayEnabled) {
      console.log('[autoplay] Auto-play disabled, stopping');
      stopAutoPlay();
      return;
    }

    // Step 1: Auto-review items in Triage
    await autoReviewTriageItems();

    // Step 2: Form batches from ready tickets with same area
    await autoFormBatches();

    // Step 3: Auto-start batches first, then individual tickets
    await autoStartBatchesAndTickets();

    // Step 4: If idle (nothing to do), sync issues to find new work
    await autoSyncIfIdle();

  } catch (error) {
    console.error('[autoplay] Error in auto-play cycle:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Automatically review items in the Triage column
 */
async function autoReviewTriageItems(): Promise<void> {
  // Don't start new reviews if one is already running
  if (isReviewRunning()) {
    console.log('[autoplay] Review already in progress, skipping auto-review');
    return;
  }

  const allTriageTickets = db.getTicketsByState('needs_review');

  // Filter out known epics - they don't need re-reviewing
  const triageTickets = allTriageTickets.filter(ticket => {
    if (shouldSkipForWork(ticket)) {
      const epicInfo = detectEpic(ticket);
      console.log(`[autoplay] Skipping epic #${ticket.github_issue_number} from review queue (${epicInfo.reason})`);
      return false;
    }
    return true;
  });

  if (triageTickets.length === 0) {
    return;
  }

  console.log(`[autoplay] Found ${triageTickets.length} tickets in Triage, starting auto-review`);

  const ticketIds = triageTickets.map(t => t.id);
  const issueNumbers = triageTickets.map(t => t.github_issue_number);

  // Run batch review (don't await - let it run in background)
  runBatchReview(ticketIds, issueNumbers).catch(error => {
    console.error('[autoplay] Auto-review failed:', error);
  });
}

/**
 * Automatically form batches from tickets with same area
 */
async function autoFormBatches(): Promise<void> {
  // Check if batching is enabled
  const settings = db.getSettings();
  if (!settings.batchingEnabled) {
    return;
  }

  // Get unbatched backlog tickets
  const unbatchedTickets = db.getUnbatchedBacklogTickets();

  if (unbatchedTickets.length < 2) {
    // Need at least 2 tickets to form a batch
    return;
  }

  // Filter out paused and epic tickets
  const eligibleTickets = unbatchedTickets.filter(ticket => {
    if (ticket.paused) return false;
    if (shouldSkipForWork(ticket)) return false;

    // Check if blocked
    const deps = db.getDependenciesForTicket(ticket.id);
    if (deps.blockedBy.length > 0) {
      const blockers = deps.blockedBy.map(id => db.getTicketById(id)).filter(Boolean) as Ticket[];
      if (!blockers.every(b => b.state === 'done')) return false;
    }

    return true;
  });

  if (eligibleTickets.length < 2) {
    return;
  }

  // Find batchable groups (tickets with same area)
  const maxBatchSize = 5; // Could add to settings
  const minBatchSize = 2;

  const batchableGroups = findBatchableTickets(eligibleTickets, minBatchSize, maxBatchSize);

  if (batchableGroups.size === 0) {
    return;
  }

  // Create batches for each group
  for (const [areaKey, tickets] of batchableGroups) {
    const batchName = generateBatchName(areaKey, tickets);

    // Create the batch record
    const batch = db.createBatch({
      area_key: areaKey,
      name: batchName
    });

    // Assign tickets to batch
    for (const ticket of tickets) {
      db.updateTicket(ticket.id, { batch_id: batch.id });
    }

    console.log(`[autoplay] Created batch ${batch.id} "${batchName}" for area "${areaKey}" with ${tickets.length} tickets`);

    // Broadcast batch created
    broadcast({
      type: 'batch_created',
      batchId: batch.id,
      name: batchName,
      areaKey,
      ticketIds: tickets.map(t => t.id)
    });
  }
}

/**
 * Automatically start batches and individual tickets when slots are available
 */
async function autoStartBatchesAndTickets(): Promise<void> {
  // Get current slot usage
  const slotStatus = db.getSlotStatus();
  let availableSlots = slotStatus.filter(s => s.available).length;

  if (availableSlots === 0) {
    return;
  }

  // Priority 1: Start pending batches (more efficient use of agent time)
  const pendingBatches = db.getBatchesByState('pending');

  for (const batch of pendingBatches) {
    if (availableSlots === 0) break;

    const result = await startBatch(batch.id);
    if (result.success) {
      console.log(`[autoplay] Started batch ${batch.id} (${batch.name})`);
      availableSlots--;
    } else {
      console.log(`[autoplay] Failed to start batch ${batch.id}: ${result.error}`);
    }
  }

  if (availableSlots === 0) {
    return;
  }

  // Priority 2: Start individual tickets not in batches
  await autoStartReadyTickets();
}

/**
 * Automatically start tickets from Ready/Backlog when slots are available
 * (Only handles tickets NOT in batches)
 */
async function autoStartReadyTickets(): Promise<void> {
  // Get current slot usage
  const slotStatus = db.getSlotStatus();
  let availableSlots = slotStatus.filter(s => s.available).length;

  // Get ready tickets (backlog), ordered by priority (urgent first)
  const readyTickets = db.getTicketsByStateOrdered('backlog');

  if (readyTickets.length === 0) {
    return;
  }

  // Filter out blocked tickets, epics, paused tickets, and batched tickets
  const unblockedTickets = readyTickets.filter(ticket => {
    // Skip tickets that are part of a batch - they'll be handled by batch processing
    if (ticket.batch_id) {
      return false;
    }

    // Skip paused tickets - user has manually paused them
    if (ticket.paused) {
      console.log(`[autoplay] Skipping paused ticket #${ticket.github_issue_number}${ticket.pause_reason ? ` (${ticket.pause_reason})` : ''}`);
      return false;
    }

    // Skip epics - they should not be worked on directly
    if (shouldSkipForWork(ticket)) {
      const epicInfo = detectEpic(ticket);
      console.log(`[autoplay] Skipping epic #${ticket.github_issue_number} (${epicInfo.reason})`);
      return false;
    }

    const deps = db.getDependenciesForTicket(ticket.id);
    if (deps.blockedBy.length === 0) return true;

    // Check if all blockers are done
    const blockers = deps.blockedBy.map(id => db.getTicketById(id)).filter(Boolean) as Ticket[];
    return blockers.every(b => b.state === 'done');
  });

  if (unblockedTickets.length === 0) {
    console.log('[autoplay] All ready tickets are blocked, paused, or are epics, waiting');
    return;
  }

  // Separate urgent tickets from normal tickets
  const urgentTickets = unblockedTickets.filter(t => t.priority === 'urgent');
  const normalTickets = unblockedTickets.filter(t => t.priority !== 'urgent');

  // Process urgent tickets first (with displacement if needed)
  for (const ticket of urgentTickets) {
    // Check max 1 urgent limit
    if (db.getUrgentInProgressCount() >= 1) {
      console.log(`[autoplay] Max urgent tickets (1) already in progress, skipping #${ticket.github_issue_number}`);
      continue;
    }

    let slot = db.getAvailableSlot();

    // If no slot available, try displacement
    if (!slot) {
      console.log(`[autoplay] No slots available for urgent ticket #${ticket.github_issue_number}, attempting displacement...`);
      const displacement = await displaceForUrgent(ticket.id);
      if (displacement) {
        slot = displacement.slot;
        const displacedTicket = db.getTicketById(displacement.displacedTicketId);
        console.log(`[autoplay] Displaced ticket #${displacedTicket?.github_issue_number} to free slot ${slot}`);
        availableSlots = db.getSlotStatus().filter(s => s.available).length;
      }
    }

    if (!slot) {
      console.log(`[autoplay] Could not acquire slot for urgent ticket #${ticket.github_issue_number}`);
      continue;
    }

    await startTicketInSlot(ticket, slot, 'urgent priority start');
    availableSlots--;
  }

  // Process normal tickets (only if slots available, no displacement)
  if (availableSlots === 0) {
    return;
  }

  const ticketsToStart = normalTickets.slice(0, availableSlots);

  for (const ticket of ticketsToStart) {
    const slot = db.getAvailableSlot();
    if (!slot) {
      console.log('[autoplay] No slots available, stopping auto-start');
      break;
    }

    await startTicketInSlot(ticket, slot, 'starting from backlog');
  }
}

/**
 * Helper to start a ticket in a specific slot
 */
async function startTicketInSlot(ticket: Ticket, slot: number, reason: string): Promise<void> {
  console.log(`[autoplay] Auto-starting ticket #${ticket.github_issue_number} (priority: ${ticket.priority || 'medium'}) in slot ${slot}`);

  // Log the state transition for debugging
  const newAttemptCount = (ticket.attempt_count || 0) + 1;
  logStateTransition(
    ticket.id,
    ticket.github_issue_number,
    'attempt_count',
    ticket.attempt_count || 0,
    newAttemptCount,
    'autoplay',
    reason
  );

  // Update ticket state
  db.updateTicket(ticket.id, {
    state: 'in_progress',
    worktree_slot: slot,
    attempt_count: newAttemptCount,
    needs_attention: 0,
    attention_reason: null
  });

  // Broadcast the update
  broadcast({
    type: 'ticket_updated',
    ticketId: ticket.id,
    changes: {
      state: 'in_progress',
      worktree_slot: slot,
      attempt_count: newAttemptCount,
      needs_attention: false,
      attention_reason: null
    }
  });

  // Get the updated ticket and spawn agent
  const updatedTicket = db.getTicketById(ticket.id);
  if (updatedTicket) {
    spawnAgent(updatedTicket).catch(error => {
      console.error(`[autoplay] Failed to spawn agent for ticket ${ticket.id}:`, error);
    });
  }

  // Small delay between spawns to avoid overwhelming the system
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Auto-sync issues if we're idle (no work in progress, nothing in queue)
 * This helps discover new work that was created externally
 * Stops after MAX_IDLE_SYNCS consecutive syncs with no new work
 */
async function autoSyncIfIdle(): Promise<void> {
  // Check if there's work in progress
  const inProgress = db.getTicketsByState('in_progress');
  const inReview = db.getTicketsByState('in_review');

  if (inProgress.length > 0 || inReview.length > 0) {
    // Not idle - work is happening, reset counter
    consecutiveIdleSyncs = 0;
    return;
  }

  // Check if there's work waiting
  const triage = db.getTicketsByState('needs_review');
  const backlog = db.getTicketsByState('backlog');

  if (triage.length > 0 || backlog.length > 0) {
    // Not idle - there's work queued, reset counter
    consecutiveIdleSyncs = 0;
    return;
  }

  // We're truly idle - no work anywhere
  // Check if we've hit the max idle syncs limit
  if (consecutiveIdleSyncs >= MAX_IDLE_SYNCS) {
    console.log(`[autoplay] No new work found after ${MAX_IDLE_SYNCS} syncs. Stopping auto-play.`);

    // Update settings and stop
    const settings = db.getSettings();
    db.saveSettings({ ...settings, autoPlayEnabled: false });
    stopAutoPlay();

    broadcast({
      type: 'autoplay_stopped',
      reason: `No work found after ${MAX_IDLE_SYNCS} idle syncs`
    });
    return;
  }

  // Check if enough time has passed since last sync
  const now = Date.now();
  if (now - lastSyncTime < MIN_SYNC_INTERVAL_MS) {
    return;
  }

  consecutiveIdleSyncs++;
  console.log(`[autoplay] System idle (sync ${consecutiveIdleSyncs}/${MAX_IDLE_SYNCS}), syncing issues to find new work...`);
  lastSyncTime = now;

  try {
    const config = db.getSyncState('claudeReadyLabel') || 'claude-ready';
    const beforeCount = db.getAllTickets().length;
    await syncIssues(config);
    const afterCount = db.getAllTickets().length;

    // If new work was found, reset the counter
    if (afterCount > beforeCount) {
      console.log(`[autoplay] Found ${afterCount - beforeCount} new ticket(s)!`);
      consecutiveIdleSyncs = 0;
    }

    broadcast({ type: 'sync_result', success: true, message: 'Auto-sync completed' });
  } catch (error) {
    console.error('[autoplay] Auto-sync failed:', error);
  }
}

/**
 * Initialize auto-play on server startup if it was enabled
 */
export function initAutoPlay(): void {
  const settings = db.getSettings();

  if (settings.autoPlayEnabled) {
    console.log('[autoplay] Auto-play was enabled, starting...');
    startAutoPlay();
  }
}
