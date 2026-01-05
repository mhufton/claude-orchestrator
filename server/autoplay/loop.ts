import * as db from '../db';
import { spawnAgent, isAgentRunning } from '../agents/spawner';
import { runBatchReview, isReviewRunning } from '../agents/reviewer';
import { syncIssues } from '../github/issues';
import { broadcast } from '../ws/handler';
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

    // Step 2: Auto-start ready tickets
    await autoStartReadyTickets();

    // Step 3: If idle (nothing to do), sync issues to find new work
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

  const triageTickets = db.getTicketsByState('needs_review');

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
 * Automatically start tickets from Ready/Backlog when slots are available
 */
async function autoStartReadyTickets(): Promise<void> {
  const settings = db.getSettings();

  // Get current slot usage
  const slotStatus = db.getSlotStatus();
  const availableSlots = slotStatus.filter(s => s.available).length;

  if (availableSlots === 0) {
    return;
  }

  // Get ready tickets (backlog), ordered by priority
  const readyTickets = db.getTicketsByStateOrdered('backlog');

  if (readyTickets.length === 0) {
    return;
  }

  // Filter out blocked tickets
  const unblockedTickets = readyTickets.filter(ticket => {
    const deps = db.getDependenciesForTicket(ticket.id);
    if (deps.blockedBy.length === 0) return true;

    // Check if all blockers are done
    const blockers = deps.blockedBy.map(id => db.getTicketById(id)).filter(Boolean) as Ticket[];
    return blockers.every(b => b.state === 'done');
  });

  if (unblockedTickets.length === 0) {
    console.log('[autoplay] All ready tickets are blocked, waiting');
    return;
  }

  // Start tickets up to available slots
  const ticketsToStart = unblockedTickets.slice(0, availableSlots);

  for (const ticket of ticketsToStart) {
    console.log(`[autoplay] Auto-starting ticket #${ticket.github_issue_number} (priority: ${ticket.priority || 'medium'})`);

    // Assign a slot
    const slot = db.getAvailableSlot();
    if (!slot) {
      console.log('[autoplay] No slots available, stopping auto-start');
      break;
    }

    // Update ticket state
    db.updateTicket(ticket.id, {
      state: 'in_progress',
      worktree_slot: slot,
      attempt_count: (ticket.attempt_count || 0) + 1,
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
        attempt_count: (ticket.attempt_count || 0) + 1,
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
