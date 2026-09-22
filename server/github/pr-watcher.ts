import * as github from './client';
import * as db from '../db';
import { logStateTransition, archiveTicketLogs } from '../db';
import { getReviewFeedback } from './score-parser';
import { broadcastTicketUpdated, broadcastSlotStatus, broadcastChatMessagesDelivered } from '../ws/handler';
import { spawnAgent } from '../agents/spawner';
import { spawnBatchAgent, isBatchAgentRunning } from '../agents/batch-spawner';
import { acquireSlot } from '../worktrees/pool';
import { recordPRWatchStart, recordPRWatchComplete, addActivity, setPRWatchInterval } from '../poll-status';
import { tryAcquireRespawnLock } from '../agents/respawn-coordinator';
import { addToQueue, isInQueue } from '../merge-queue/manager';
import { completeBatch } from '../state/machine';
import { categorizeError } from '../agents/error-types';
import { analyzeAgentFailure } from '../agents/failure-analyzer';
import { evaluateMergeBlockers } from './merge-blockers';
import { getPRReviewContext } from './review-context';
import { MAX_AUTO_ATTEMPTS } from '../config';
import type { Ticket, Batch, ReviewContext, UnresolvedThreadContext } from '../state/types';

interface WatchResult {
  action: 'waiting' | 'back_to_progress' | 'completed' | 'error' | 'respawned';
  reason?: string;
  score?: number;
}

/**
 * Update CI status on a ticket for live tracking in the UI.
 * This is called every time we check CI, so the UI always has current info.
 *
 * IMPORTANT: Auto-clears needs_attention when CI is running or passing,
 * since that means work is progressing normally.
 */
function updateCIStatus(
  ticket: Ticket,
  status: 'pending' | 'running' | 'passing' | 'failing' | 'unknown',
  checks: Array<{ name: string; status: string; conclusion: string | null }>
): void {
  const checksJson = JSON.stringify(checks.map(c => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion
  })));

  // Auto-clear needs_attention if CI is running or passing
  // This prevents stale "stuck" flags when work is actually progressing
  const shouldClearAttention = (status === 'running' || status === 'passing') && ticket.needs_attention;

  const updates: Partial<Ticket> = {
    ci_status: status,
    ci_checks: checksJson,
    ci_updated_at: new Date().toISOString()
  };

  if (shouldClearAttention) {
    updates.needs_attention = 0;
    updates.attention_reason = null;
    console.log(`[pr-watcher] Auto-cleared needs_attention for #${ticket.github_issue_number} (CI ${status})`);
  }

  db.updateTicket(ticket.id, updates);

  // Broadcast to UI
  broadcastTicketUpdated(ticket.id, updates);
}

/**
 * Helper to respawn agent for a specific issue (merge conflicts, CI failures, etc.)
 * Extracted to avoid code duplication for early respawn cases
 */
async function respawnForIssue(
  ticket: Ticket,
  reason: 'fixing_ci' | 'resolving_merge_conflict' | 'addressing_pr_comments' | 'improving_score',
  issues: string[],
  commitSha: string,
  context?: {
    ciFailures?: Array<{ name: string; output?: string }>;
    reviewScore?: number | null;
    hasMergeConflict?: boolean;
    recentErrors?: string[];
  }
): Promise<WatchResult> {
  // Check if another component already triggered a respawn for this ticket
  if (!tryAcquireRespawnLock(ticket.id, `pr-watcher:${reason}`)) {
    return {
      action: 'waiting',
      reason: 'Respawn already in progress from another source'
    };
  }

  // Categorize the error to get smart retry settings
  const categorized = categorizeError({
    ciFailures: context?.ciFailures,
    reviewScore: context?.reviewScore,
    hasMergeConflict: context?.hasMergeConflict,
    recentErrors: context?.recentErrors,
    attemptCount: ticket.attempt_count + 1 // Next attempt count
  });

  console.log(`[error-categorization] Ticket #${ticket.github_issue_number}: ${categorized.category} (${categorized.severity})`);
  console.log(`[error-categorization] Cooldown: ${categorized.suggestedCooldown}ms, Escalate: ${categorized.escalateModel}`);

  // CIRCUIT BREAKER: Check if we've exceeded max attempts
  if (ticket.attempt_count >= MAX_AUTO_ATTEMPTS) {
    console.log(`PR #${ticket.pr_number}: Maximum auto-attempts (${MAX_AUTO_ATTEMPTS}) reached. Flagging for human intervention.`);

    db.updateTicket(ticket.id, {
      needs_attention: 1,
      attention_reason: `Stuck after ${ticket.attempt_count} attempts. Issues: ${issues.join('; ')}`
    });
    broadcastTicketUpdated(ticket.id, {
      needs_attention: 1,
      attention_reason: `Stuck after ${ticket.attempt_count} attempts. Issues: ${issues.join('; ')}`
    });

    return {
      action: 'error',
      reason: `Maximum attempts (${MAX_AUTO_ATTEMPTS}) reached - requires human intervention`
    };
  }

  const newAttemptCount = ticket.attempt_count + 1;

  console.log(`Auto-respawning agent for ticket #${ticket.github_issue_number} to fix: ${issues.join(', ')} (cooldown: ${categorized.suggestedCooldown}ms)`);

  // Apply cooldown before respawning
  // Note: We delay the actual spawn, not the state transition
  // This prevents the agent from immediately starting while the issue may still be transient
  await new Promise(resolve => setTimeout(resolve, categorized.suggestedCooldown));

  // Check if we need to acquire a slot
  let slotToUse = ticket.worktree_slot;
  if (!slotToUse) {
    const branchName = ticket.branch_name || `claude/issue-${ticket.github_issue_number}`;
    const allocation = await acquireSlot(ticket.id, branchName);
    if (!allocation) {
      console.warn(`Cannot respawn - no slots available for ticket ${ticket.id}`);
      return { action: 'waiting', reason: 'No slots available for respawn' };
    }
    slotToUse = allocation.slot;
    console.log(`Acquired slot ${slotToUse} for respawning ticket #${ticket.github_issue_number}`);
  }

  // Log state transition for debugging
  logStateTransition(
    ticket.id,
    ticket.github_issue_number,
    'attempt_count',
    ticket.attempt_count,
    newAttemptCount,
    'pr-watcher',
    `${reason}: ${issues.join(', ')} [${categorized.category}]`
  );

  // Store error category for spawner to use
  const updates: Record<string, unknown> = {
    state: 'in_progress',
    worktree_slot: slotToUse,
    attempt_count: newAttemptCount,
    retry_reason: reason,
    needs_attention: 0,
    attention_reason: null,
    error_category: categorized.category,
    should_escalate_model: categorized.escalateModel ? 1 : 0,
    last_checked_sha: commitSha  // Track which commit we're respawning for
  };

  db.updateTicket(ticket.id, updates);
  broadcastTicketUpdated(ticket.id, updates);
  broadcastSlotStatus();

  const updatedTicket = db.getTicketById(ticket.id);
  if (updatedTicket) {
    spawnAgent(updatedTicket).catch(err => {
      console.error(`Failed to respawn agent for ticket ${ticket.id}:`, err);
    });
  }

  addActivity('respawn', `Respawned #${ticket.github_issue_number}: ${reason} [${categorized.category}]`);

  return {
    action: 'respawned',
    reason: `Agent respawned to fix: ${issues.join('; ')} (${categorized.description})`
  };
}

/** Tickets we have already filed a follow-up issue for, so a requeue does not file another. */
const followUpIssueCreated = new Set<number>();

const MAX_FOLLOW_UP_SUGGESTIONS = 10;

/** Pull bullet/numbered items out of review prose for the follow-up issue body. */
function extractSuggestions(feedback: string): string[] {
  return feedback
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^([-*•]|\d+[.)])\s+/.test(line))
    .map(line => line.replace(/^([-*•]|\d+[.)])\s+/, '').trim())
    .filter(line => line.length >= 10)
    .slice(0, MAX_FOLLOW_UP_SUGGESTIONS);
}

export async function watchTicketPR(ticket: Ticket): Promise<WatchResult> {
  if (!ticket.pr_number) {
    return { action: 'waiting', reason: 'No PR number' };
  }

  try {
    const pr = await github.getPR(ticket.pr_number);

    // Check if PR was merged (externally or via auto-merge)
    if (pr.merged) {
      // Ensure the corresponding GitHub issue is closed
      const closeSuccess = await github.closeIssue(ticket.github_issue_number);

      if (!closeSuccess) {
        console.error(`[pr-watcher] Failed to close issue #${ticket.github_issue_number} after PR merge - will retry`);
        return { action: 'waiting', reason: 'Failed to close issue, will retry' };
      }

      db.updateTicket(ticket.id, {
        state: 'done',
        worktree_slot: null
      });
      broadcastTicketUpdated(ticket.id, { state: 'done', worktree_slot: null });
      broadcastSlotStatus();

      // Archive old logs to keep database lean (keep last 100 entries)
      const archived = archiveTicketLogs(ticket.id, 100);
      if (archived.deleted > 0) {
        console.log(`[pr-watcher] Archived ${archived.deleted} old log entries for ticket #${ticket.github_issue_number}`);
      }

      return { action: 'completed', reason: 'PR merged' };
    }

    // Check if PR was closed without merging
    if (pr.state === 'closed') {
      return { action: 'waiting', reason: 'PR closed without merge' };
    }

    // A batch PR is owned by its batch, not by the tickets inside it: the fix has to
    // come from a batch agent, and the attempt cap has to be counted once. Letting
    // each constituent ticket evaluate the same PR gave N respawns of the WRONG kind
    // of agent and N merge-queue entries. watchBatchPR handles it.
    if (ticket.batch_id) {
      return { action: 'waiting', reason: `PR owned by batch ${ticket.batch_id}` };
    }

    // CRITICAL SAFETY CHECK: Verify branch HEAD matches PR head SHA
    // This prevents merging based on stale check data when new commits were just pushed
    let actualBranchSha: string;
    try {
      actualBranchSha = await github.getBranchHeadSha(pr.head.ref);
    } catch (branchError) {
      console.warn(`Could not verify branch HEAD for ${pr.head.ref}:`, branchError);
      return { action: 'waiting', reason: 'Cannot verify branch HEAD - waiting' };
    }

    if (actualBranchSha !== pr.head.sha) {
      console.log(`PR #${ticket.pr_number}: Branch HEAD (${actualBranchSha.slice(0, 7)}) differs from PR head (${pr.head.sha.slice(0, 7)}) - new commits detected, waiting for API to sync`);
      return { action: 'waiting', reason: 'New commits detected, waiting for PR to update' };
    }

    // ==========================================
    // CHECK MERGE CONFLICTS / BEHIND FIRST
    // No point waiting for CI if branch needs rebasing - CI will re-run anyway
    // ==========================================

    // Check if GitHub is still calculating mergeability
    if (pr.mergeable === null) {
      return { action: 'waiting', reason: 'Checking mergeability...' };
    }

    // Branch is behind dev - update it directly without using an agent slot
    // This is a lightweight operation that doesn't need a full agent
    // IMPORTANT: Don't count this against attempt_count - it's mechanical, not a fix attempt
    if (pr.mergeable_state === 'behind') {
      console.log(`PR #${ticket.pr_number}: Behind dev branch, updating directly (no agent needed)`);

      const updateResult = await github.updatePRBranch(ticket.pr_number);

      if (updateResult.success) {
        console.log(`PR #${ticket.pr_number}: Branch updated successfully, waiting for CI to re-run`);
        addActivity('branch_update', `Updated PR #${ticket.pr_number} branch to latest dev`);
        return { action: 'waiting', reason: 'Branch updated, waiting for CI' };
      } else {
        // Update failed - likely has conflicts now, need an agent to resolve
        console.log(`PR #${ticket.pr_number}: Branch update failed (${updateResult.message}), need agent to resolve`);
        return await respawnForIssue(
          ticket,
          'resolving_merge_conflict',
          [`Branch update failed: ${updateResult.message}`],
          pr.head.sha,
          { hasMergeConflict: true }
        );
      }
    }

    // Check for merge conflicts - respawn immediately, don't wait for CI
    if (pr.mergeable === false) {
      console.log(`PR #${ticket.pr_number}: Has merge conflicts, respawning agent immediately`);
      return await respawnForIssue(
        ticket,
        'resolving_merge_conflict',
        ['Merge conflicts with dev branch'],
        pr.head.sha,
        { hasMergeConflict: true }
      );
    }

    // ==========================================
    // BRANCH IS CLEAN - NOW APPLY THE MERGE-BLOCKING RULES (shared with batches)
    // ==========================================

    const report = await evaluateMergeBlockers(ticket.pr_number, pr.head.sha);

    if (report.status !== 'evaluated') {
      const label: 'unknown' | 'running' = report.status === 'ci_unknown' ? 'unknown' : 'running';
      updateCIStatus(ticket, label, report.checks);
      console.log(`PR #${ticket.pr_number}: ${report.reason}`);
      return { action: 'waiting', reason: report.reason };
    }

    const { issues, hasCIFailures, hasBlockingComments: hasUnrepliedComments, score, threadOutcome } = report;

    updateCIStatus(ticket, hasCIFailures ? 'failing' : 'passing', report.checks);

    if (threadOutcome.resolved.length > 0) {
      addActivity('pr_check', `Resolved ${threadOutcome.resolved.length} review thread(s) on PR #${ticket.pr_number}`);
    }

    if (score) {
      db.updateTicket(ticket.id, { current_score: score.total });
      broadcastTicketUpdated(ticket.id, { current_score: score.total });
    }

    console.log(`PR #${ticket.pr_number}: CI=${hasCIFailures ? 'FAILED' : 'passed'}, score=${score?.total ?? 'none'}, blockers=${issues.length}, unresolved=${threadOutcome.stillOpen.length}, attempt=${ticket.attempt_count}`);

    // If there are ANY issues, respawn agent with ALL of them
    // Note: Merge conflicts are already handled earlier in the flow
    if (issues.length > 0) {
      // ANTI-DOUBLE-RESPAWN: Check if we're already working on fixing this exact commit
      // This prevents triggering multiple respawns while agent is still working on the same failing commit
      if (ticket.state === 'in_progress' && ticket.last_checked_sha === pr.head.sha) {
        console.log(`PR #${ticket.pr_number}: Already working on fixing issues from commit ${pr.head.sha.slice(0, 7)}, waiting for agent to push...`);
        return { action: 'waiting', reason: `Agent working on fixing ${issues.join(', ')}` };
      }

      // Determine primary retry reason (for UI display) - prioritize by severity
      let primaryReason: 'fixing_ci' | 'addressing_pr_comments' | 'improving_score' = 'improving_score';
      if (hasCIFailures) primaryReason = 'fixing_ci';
      if (hasUnrepliedComments) primaryReason = 'addressing_pr_comments';

      // Build context for error categorization
      const errorContext = {
        ciFailures: hasCIFailures ? report.ciFailureNames.map(name => ({
          name,
          output: undefined // We don't have detailed output here, categorization will use name
        })) : undefined,
        reviewScore: score?.total,
        hasMergeConflict: false
      };

      return await respawnForIssue(ticket, primaryReason, issues, pr.head.sha, errorContext);
    }

    // No issues and no score yet - wait for review
    if (!score) {
      return { action: 'waiting', reason: 'Waiting for review score' };
    }

    // Add to merge queue instead of merging directly
    // The merge queue processor will handle the actual merge in FIFO order
    if (isInQueue(ticket.id)) {
      console.log(`PR #${ticket.pr_number}: Already in merge queue, waiting`);
      return { action: 'waiting', reason: 'In merge queue, waiting for turn' };
    }

    // Score passed - file the leftover non-blocking suggestions as a follow-up.
    // Runs here, once, at the moment of queueing: it used to run on every poll, which
    // filed a duplicate issue every cycle the ticket sat in the queue. Harmless while
    // `feedback` was always undefined; not harmless now that `### Findings` parses.
    if (score.total < 100 && score.feedback) {
      const suggestions = extractSuggestions(score.feedback);

      if (suggestions.length > 0 && !followUpIssueCreated.has(ticket.id)) {
        followUpIssueCreated.add(ticket.id);
        await github.createFollowUpIssue(
          ticket.github_issue_number,
          ticket.pr_number,
          suggestions
        );
      }
    }

    console.log(`PR #${ticket.pr_number}: Ready to merge (score ${score.total}/100), adding to merge queue`);
    const queueEntry = await addToQueue(ticket.id, ticket.pr_number, ticket.merge_queue_priority);
    addActivity('pr_check', `PR #${ticket.pr_number} added to merge queue (position ${queueEntry.position})`);

    return {
      action: 'waiting',
      reason: `Added to merge queue at position ${queueEntry.position}`,
      score: score.total
    };

    // NOTE: The code below handles merge failures, but since we now use the queue,
    // merge failures are handled by the merge-queue/processor.ts
    // Keeping this code commented for reference during transition
    /*
    const mergeResult = await github.mergePR(ticket.pr_number);

    if (mergeResult.success) {
      // Close the corresponding GitHub issue
      await github.closeIssue(ticket.github_issue_number);

      db.updateTicket(ticket.id, {
        state: 'done',
        worktree_slot: null
      });
      broadcastTicketUpdated(ticket.id, { state: 'done', worktree_slot: null });
      broadcastSlotStatus();

      // Archive old logs to keep database lean (keep last 100 entries)
      const archived = archiveTicketLogs(ticket.id, 100);
      if (archived.deleted > 0) {
        console.log(`[pr-watcher] Archived ${archived.deleted} old log entries for ticket #${ticket.github_issue_number}`);
      }

      return {
        action: 'completed',
        reason: `Merged with score ${score.total}/100`,
        score: score.total
      };
    } else {
      // Merge failed - DON'T ASSUME WHY. Investigate the actual reason.
      console.log(`PR #${ticket.pr_number}: Merge failed (${mergeResult.error}), investigating cause...`);

      // Re-fetch PR to get current mergeable state
      const currentPR = await github.getPR(ticket.pr_number);
      console.log(`PR #${ticket.pr_number}: mergeable=${currentPR.mergeable}, mergeable_state=${currentPR.mergeable_state}`);

      // Handle based on actual state
      // With strict:false, being behind shouldn't block merge - something else is wrong
      if (currentPR.mergeable_state === 'behind') {
        console.log(`PR #${ticket.pr_number}: Behind main but merge failed - will retry merge directly`);
        // Don't update branch (triggers CI rerun), just wait and retry merge
        return { action: 'waiting', reason: 'Merge failed while behind main - will retry' };
      }

      if (currentPR.mergeable === false || currentPR.mergeable_state === 'dirty') {
        // Merge conflicts - respawn agent to resolve
        console.log(`PR #${ticket.pr_number}: Has merge conflicts, respawning agent to resolve`);

        // Use existing respawn logic
        if (ticket.attempt_count >= MAX_AUTO_ATTEMPTS) {
          db.updateTicket(ticket.id, {
            needs_attention: 1,
            attention_reason: `Merge conflicts persist after ${ticket.attempt_count} attempts - needs manual resolution`
          });
          broadcastTicketUpdated(ticket.id, {
            needs_attention: 1,
            attention_reason: `Merge conflicts persist after ${ticket.attempt_count} attempts - needs manual resolution`
          });
          return { action: 'error', reason: 'Merge conflicts - max attempts reached' };
        }

        // Respawn agent to fix conflicts
        let slotToUse = ticket.worktree_slot;
        if (!slotToUse) {
          const branchName = ticket.branch_name || `claude/issue-${ticket.github_issue_number}`;
          const allocation = await acquireSlot(ticket.id, branchName);
          if (!allocation) {
            return { action: 'waiting', reason: 'No slots available for conflict resolution' };
          }
          slotToUse = allocation.slot;
        }

        db.updateTicket(ticket.id, {
          state: 'in_progress',
          worktree_slot: slotToUse,
          attempt_count: ticket.attempt_count + 1,
          retry_reason: 'resolving_merge_conflict',
          needs_attention: 0,
          attention_reason: null
        });
        broadcastTicketUpdated(ticket.id, {
          state: 'in_progress',
          worktree_slot: slotToUse,
          attempt_count: ticket.attempt_count + 1,
          retry_reason: 'resolving_merge_conflict',
          needs_attention: 0,
          attention_reason: null
        });
        broadcastSlotStatus();

        const updatedTicket = db.getTicketById(ticket.id);
        if (updatedTicket) {
          spawnAgent(updatedTicket).catch(err => {
            console.error(`Failed to respawn agent for conflict resolution:`, err);
          });
        }

        return { action: 'respawned', reason: 'Merge conflicts detected, agent respawned to resolve' };
      }

      if (currentPR.mergeable_state === 'blocked') {
        // Something is blocking - could be required reviews, status checks, etc.
        // Check if it's something we can wait on vs something that needs human intervention
        const blockReason = mergeResult.error || 'Unknown blocking reason';

        // If blocked by required reviews, that's a human action needed
        if (blockReason.includes('review') || blockReason.includes('approval')) {
          db.updateTicket(ticket.id, {
            needs_attention: 1,
            attention_reason: `PR blocked: requires human approval`
          });
          broadcastTicketUpdated(ticket.id, {
            needs_attention: 1,
            attention_reason: `PR blocked: requires human approval`
          });
          return { action: 'error', reason: 'Requires human approval' };
        }

        // Other blocking reasons - wait and retry (might be transient)
        return { action: 'waiting', reason: `Merge blocked: ${blockReason}` };
      }

      if (currentPR.mergeable === null || currentPR.mergeable_state === 'unknown') {
        // GitHub is still calculating - wait
        return { action: 'waiting', reason: 'GitHub calculating mergeability, will retry' };
      }

      // If we get here, we truly don't know why merge failed
      // Log detailed info for debugging and flag for attention
      console.warn(`PR #${ticket.pr_number}: Merge failed for unknown reason. State: ${currentPR.mergeable_state}, Error: ${mergeResult.error}`);

      db.updateTicket(ticket.id, {
        needs_attention: 1,
        attention_reason: `Merge failed: ${mergeResult.error || 'unknown reason'} (state: ${currentPR.mergeable_state})`
      });
      broadcastTicketUpdated(ticket.id, {
        needs_attention: 1,
        attention_reason: `Merge failed: ${mergeResult.error || 'unknown reason'} (state: ${currentPR.mergeable_state})`
      });

      return {
        action: 'error',
        reason: `Merge failed: ${mergeResult.error || 'unknown reason'}`
      };
    }
    */
  } catch (error) {
    console.error(`Error watching PR for ticket ${ticket.id}:`, error);
    return {
      action: 'error',
      reason: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Respawn the batch agent to fix what is blocking its PR.
 *
 * The cap is counted on the BATCH, not on its tickets: a 4-ticket batch counting
 * per ticket would get 4x MAX_AUTO_ATTEMPTS respawns of the same PR, and the tickets
 * cannot be retried independently anyway — one branch, one PR, all-or-nothing.
 */
async function respawnBatchForIssues(batch: Batch, issues: string[]): Promise<WatchResult> {
  if (isBatchAgentRunning(batch.id)) {
    return { action: 'waiting', reason: 'Batch agent already running' };
  }

  if (batch.attempt_count >= MAX_AUTO_ATTEMPTS) {
    const reason = `Stuck after ${batch.attempt_count} attempts. Issues: ${issues.join('; ')}`;
    console.log(`[pr-watcher] Batch ${batch.id}: max auto-attempts (${MAX_AUTO_ATTEMPTS}) reached, flagging for human intervention`);
    db.updateBatch(batch.id, { needs_attention: 1, attention_reason: reason });
    return { action: 'error', reason: `Maximum attempts (${MAX_AUTO_ATTEMPTS}) reached - requires human intervention` };
  }

  const tickets = db.getTicketsInBatch(batch.id);
  if (tickets.length === 0) {
    return { action: 'error', reason: 'Batch has no tickets to respawn for' };
  }

  let slot = batch.worktree_slot;
  if (!slot) {
    const allocation = await acquireSlot(batch.id, batch.branch_name || `claude/batch-${batch.id}`, 'batch');
    if (!allocation) {
      return { action: 'waiting', reason: 'No slots available for batch respawn' };
    }
    slot = allocation.slot;
  }

  const context = await getBatchRetryContext(batch, tickets);

  db.updateBatch(batch.id, {
    state: 'in_progress',
    worktree_slot: slot,
    attempt_count: batch.attempt_count + 1,
    needs_attention: 0,
    attention_reason: null,
  });

  for (const ticket of tickets) {
    db.updateTicket(ticket.id, {
      state: 'in_progress',
      worktree_slot: slot,
      retry_reason: 'addressing_pr_comments',
    });
    broadcastTicketUpdated(ticket.id, {
      state: 'in_progress',
      worktree_slot: slot,
      retry_reason: 'addressing_pr_comments',
    });
  }

  broadcastSlotStatus();

  const updatedBatch = db.getBatchById(batch.id)!;
  spawnBatchAgent(updatedBatch, tickets, context).catch(err => {
    console.error(`[pr-watcher] Failed to respawn batch agent for batch ${batch.id}:`, err);
  });

  addActivity('respawn', `Respawned batch ${batch.id}: ${issues.join('; ')}`);

  return { action: 'respawned', reason: `Batch agent respawned to fix: ${issues.join('; ')}` };
}

/**
 * Watch a batch's PR: same merge-blocking rules as a single ticket (shared via
 * evaluateMergeBlockers), plus batch-shaped respawn and completion.
 */
async function watchBatchPR(batch: Batch): Promise<WatchResult> {
  if (!batch.pr_number) {
    return { action: 'waiting', reason: 'No PR number' };
  }

  try {
    const pr = await github.getPR(batch.pr_number);

    // Check if PR was merged
    if (pr.merged) {
      console.log(`[pr-watcher] Batch ${batch.id} PR #${batch.pr_number} was merged, completing batch`);

      const result = await completeBatch(batch.id);
      if (result.success) {
        addActivity('pr_merged', `Batch PR #${batch.pr_number} merged`);
        return { action: 'completed', reason: 'PR merged' };
      } else {
        console.error(`[pr-watcher] Failed to complete batch ${batch.id}:`, result.error);
        return { action: 'error', reason: result.error || 'Failed to complete batch' };
      }
    }

    // Check if PR was closed without merging
    if (pr.state === 'closed') {
      console.log(`[pr-watcher] Batch ${batch.id} PR #${batch.pr_number} was closed without merging`);
      db.updateBatch(batch.id, {
        needs_attention: 1,
        attention_reason: 'PR closed without merging'
      });
      return { action: 'error', reason: 'PR closed without merge' };
    }

    if (pr.mergeable === null) {
      return { action: 'waiting', reason: 'Checking mergeability...' };
    }

    if (pr.mergeable_state === 'behind') {
      const updateResult = await github.updatePRBranch(batch.pr_number);
      return {
        action: 'waiting',
        reason: updateResult.success ? 'Branch updated, waiting for CI' : `Branch update failed: ${updateResult.message}`,
      };
    }

    if (pr.mergeable === false) {
      return await respawnBatchForIssues(batch, ['Merge conflicts with main']);
    }

    // Same rules as the single-ticket path, including evidence-based thread resolution.
    const report = await evaluateMergeBlockers(batch.pr_number, pr.head.sha);
    if (report.status !== 'evaluated') {
      return { action: 'waiting', reason: report.reason };
    }

    if (report.threadOutcome.resolved.length > 0) {
      addActivity('pr_check', `Resolved ${report.threadOutcome.resolved.length} review thread(s) on batch PR #${batch.pr_number}`);
    }

    if (report.score) {
      db.updateBatch(batch.id, { current_score: report.score.total });
    }

    console.log(`[pr-watcher] Batch ${batch.id} PR #${batch.pr_number}: CI=${report.hasCIFailures ? 'FAILED' : 'passed'}, score=${report.score?.total ?? 'none'}, blockers=${report.issues.length}, attempt=${batch.attempt_count}`);

    if (report.issues.length > 0) {
      return await respawnBatchForIssues(batch, report.issues);
    }

    if (!report.score) {
      return { action: 'waiting', reason: 'Waiting for review score' };
    }

    // Nothing blocks the merge. The queue is keyed by ticket, so the batch rides in on
    // its lowest-numbered ticket; completeBatch finishes the rest once the PR merges.
    const tickets = db.getTicketsInBatch(batch.id).sort((a, b) => a.id - b.id);
    const representative = tickets[0];
    if (!representative) {
      return { action: 'error', reason: 'Batch has no tickets to queue' };
    }

    if (isInQueue(representative.id)) {
      return { action: 'waiting', reason: 'In merge queue, waiting for turn' };
    }

    const queueEntry = await addToQueue(representative.id, batch.pr_number, representative.merge_queue_priority);
    addActivity('pr_check', `Batch PR #${batch.pr_number} added to merge queue (position ${queueEntry.position})`);

    return { action: 'waiting', reason: `Added to merge queue at position ${queueEntry.position}`, score: report.score.total };
  } catch (error) {
    console.error(`Error watching PR for batch ${batch.id}:`, error);
    return {
      action: 'error',
      reason: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export function startPRWatchLoop(intervalMs: number): void {
  setPRWatchInterval(intervalMs);

  setInterval(async () => {
    recordPRWatchStart();

    // Check tickets in 'in_review' state
    const inReviewTickets = db.getTicketsByState('in_review');
    let ticketsChecked = 0;

    for (const ticket of inReviewTickets) {
      const result = await watchTicketPR(ticket);
      ticketsChecked++;

      if (result.action !== 'waiting') {
        console.log(`Ticket #${ticket.github_issue_number}: ${result.action} - ${result.reason}`);

        // Log activity based on result
        if (result.action === 'completed') {
          addActivity('pr_merged', `PR #${ticket.pr_number} merged for issue #${ticket.github_issue_number}`);
        } else if (result.action === 'respawned') {
          addActivity('respawn', `Respawned agent for #${ticket.github_issue_number}: ${result.reason}`);
        }
      }
    }

    // ALSO check 'in_progress' tickets that have a PR
    // This handles cases where the initial transition to 'in_review' failed
    // NOTE: We check these even if needs_attention is set, so we can auto-clear
    // the attention flag if CI is running/passing
    const inProgressTickets = db.getTicketsByState('in_progress');
    for (const ticket of inProgressTickets) {
      // If ticket has PR linked, process it (even if needs_attention is set)
      if (ticket.pr_number) {
        console.log(`[pr-watcher] Found in_progress ticket #${ticket.github_issue_number} with PR #${ticket.pr_number}, checking...`);
        const result = await watchTicketPR(ticket);

        if (result.action !== 'waiting') {
          console.log(`Ticket #${ticket.github_issue_number}: ${result.action} - ${result.reason}`);
        }
      } else {
        // No PR linked - try to find one (PR detection might have failed earlier)
        try {
          const branchPrefix = `claude/${ticket.github_issue_number}`;
          const prs = await github.getPRsForBranchPrefix(branchPrefix);

          if (prs.length > 0) {
            const pr = prs[0];
            console.log(`[pr-watcher] Found unlinked PR #${pr.number} for ticket #${ticket.github_issue_number}, linking and transitioning to in_review`);

            // Link the PR and transition to in_review
            db.updateTicket(ticket.id, {
              state: 'in_review',
              pr_number: pr.number,
              pr_url: pr.html_url,
              branch_name: pr.head.ref
            });

            broadcastTicketUpdated(ticket.id, {
              state: 'in_review',
              pr_number: pr.number,
              pr_url: pr.html_url,
              branch_name: pr.head.ref
            });
          }
        } catch (error) {
          console.warn(`[pr-watcher] Error checking for unlinked PRs for ticket #${ticket.github_issue_number}:`, error);
        }
      }
      ticketsChecked++;
    }

    // Check batches in 'in_review' state
    // Batches need to detect when their PR is merged to unblock the serial PR queue
    const inReviewBatches = db.getBatchesByState('in_review');
    for (const batch of inReviewBatches) {
      const result = await watchBatchPR(batch);
      if (result.action !== 'waiting') {
        console.log(`[pr-watcher] Batch ${batch.id}: ${result.action} - ${result.reason}`);
      }
    }

    recordPRWatchComplete(ticketsChecked);
  }, intervalMs);
}

/**
 * Retry context for a BATCH agent.
 *
 * Shares `getPRReviewContext` and `getReviewFeedback` with the single-ticket path;
 * what differs is only where the score, handoff notes and chat messages live — a
 * batch has one score and N tickets, so the messages are collected across them.
 */
export async function getBatchRetryContext(batch: Batch, tickets: Ticket[]): Promise<ReviewContext> {
  const prContext = batch.pr_number ? await getPRReviewContext(batch.pr_number) : null;
  const reviewFeedback = batch.pr_number
    ? await getReviewFeedback(batch.pr_number)
    : 'No previous PR review found.';

  const userMessages: string[] = [];
  for (const ticket of tickets) {
    const pending = db.getPendingChatMessages(ticket.id);
    if (pending.length === 0) continue;
    userMessages.push(...pending.map(m => `(#${ticket.github_issue_number}) ${m.content}`));
    db.markChatMessagesDelivered(ticket.id);
    broadcastChatMessagesDelivered(ticket.id);
  }

  return {
    previousScore: batch.current_score,
    reviewFeedback,
    ciFailures: prContext?.ciFailures ?? [],
    inlineComments: prContext?.inlineComments ?? [],
    botComments: prContext?.botComments ?? [],
    userMessages,
    hasMergeConflicts: prContext?.hasMergeConflicts ?? false,
    repoOwner: prContext?.repoOwner ?? github.getRepoInfo().owner,
    repoName: prContext?.repoName ?? github.getRepoInfo().repo,
    unresolvedThreads: prContext?.unresolvedThreads ?? [],
  };
}

/**
 * Get context for re-starting an agent after review failure or stall
 */
export async function getRetryContext(ticket: Ticket): Promise<{
  previousScore: number | null;
  reviewFeedback: string;
  ciFailures: string[];
  inlineComments: string[];
  botComments: string[];
  userMessages: string[];
  lastActivity: string;
  recentToolCalls: string[];
  recentErrors: string[];
  filesModified: string[];
  agentIntent: string;
  hasMergeConflicts: boolean;
  repoOwner: string;
  repoName: string;
  unresolvedThreads: UnresolvedThreadContext[];
  failureAnalysis?: {
    category: string;
    description: string;
    errorMessages: string[];
    repeatedPatterns: string[];
    suggestions: string[];
    severity: string;
  };
}> {
  const feedback = ticket.pr_number
    ? await getReviewFeedback(ticket.pr_number)
    : 'No previous PR review found.';

  // Get CI failures and PR feedback
  const prContext = ticket.pr_number
    ? await getPRReviewContext(ticket.pr_number)
    : null;

  // Get recent activity from logs - limit to reduce token usage
  const logs = db.getLogsForTicket(ticket.id, 20);
  const recentToolCalls: string[] = [];
  const recentErrors: string[] = [];
  const filesModified: Set<string> = new Set();
  let lastActivity = '';
  let agentIntent = '';

  for (const log of logs) {
    try {
      const parsed = JSON.parse(log.content);

      // Extract tool calls and file modifications
      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'tool_use' && block.name) {
            const input = block.input || {};
            let summary = block.name;

            if (block.name === 'Read' && input.file_path) {
              summary = `Read(${input.file_path})`;
            } else if (block.name === 'Edit' && input.file_path) {
              summary = `Edit(${input.file_path})`;
              filesModified.add(input.file_path);
            } else if (block.name === 'Write' && input.file_path) {
              summary = `Write(${input.file_path})`;
              filesModified.add(input.file_path);
            } else if (block.name === 'Bash' && input.command) {
              summary = `Bash: ${String(input.command).slice(0, 60)}`;
            } else if (block.name === 'Grep' && input.pattern) {
              summary = `Grep("${input.pattern}")`;
            }

            if (recentToolCalls.length < 5) {
              recentToolCalls.unshift(summary); // Most recent first
            }
          }

          // Extract agent's stated intent/plan
          if (block.type === 'text' && block.text) {
            const text = String(block.text);
            if (!lastActivity) {
              lastActivity = text.slice(0, 200);
            }
            // Look for intent statements like "I'll", "Let me", "I need to", "Now I will"
            if (!agentIntent && (text.includes("I'll") || text.includes("Let me") || text.includes("I need to") || text.includes("Now I"))) {
              agentIntent = text.slice(0, 300);
            }
          }
        }
      }

      // Extract errors from tool results
      if (parsed.type === 'user' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'tool_result' && block.content) {
            const content = String(block.content);
            // Look for error indicators
            if (content.includes('Error:') || content.includes('error:') ||
                content.includes('ENOENT') || content.includes('FAILED') ||
                content.includes('Exit code') && !content.includes('Exit code 0') ||
                content.includes('TypeError') || content.includes('SyntaxError') ||
                content.includes('Cannot find') || content.includes('not found')) {
              // Extract just the error part, not the whole output
              const errorLines = content.split('\n')
                .filter(line =>
                  line.includes('Error') || line.includes('error') ||
                  line.includes('FAILED') || line.includes('Cannot') ||
                  line.includes('not found') || line.includes('Exit code'))
                .slice(0, 3)
                .join('\n');
              if (errorLines && recentErrors.length < 5) {
                recentErrors.unshift(errorLines.slice(0, 200));
              }
            }
          }
        }
      }
    } catch {
      // Skip unparseable logs
    }
  }

  // Get pending chat messages from user
  const pendingChatMessages = db.getPendingChatMessages(ticket.id);
  const userMessages = pendingChatMessages.map(m => m.content);

  // Mark messages as delivered and broadcast to UI
  if (userMessages.length > 0) {
    db.markChatMessagesDelivered(ticket.id);
    broadcastChatMessagesDelivered(ticket.id);
  }

  // Analyze agent failure patterns to provide actionable feedback
  // This helps agents avoid repeating the same mistakes
  const failureAnalysis = ticket.attempt_count > 1 ? analyzeAgentFailure(ticket) : undefined;

  if (failureAnalysis) {
    console.log(`[pr-watcher] Failure analysis for ticket #${ticket.github_issue_number}:`);
    console.log(`  Category: ${failureAnalysis.category}, Severity: ${failureAnalysis.severity}`);
    if (failureAnalysis.repeatedPatterns.length > 0) {
      console.log(`  ⚠️ Repeated patterns: ${failureAnalysis.repeatedPatterns.join(', ')}`);
    }
  }

  return {
    previousScore: ticket.current_score,
    reviewFeedback: feedback,
    ciFailures: prContext?.ciFailures ?? [],
    inlineComments: prContext?.inlineComments ?? [],
    botComments: prContext?.botComments ?? [],
    userMessages,
    lastActivity,
    recentToolCalls,
    recentErrors,
    filesModified: Array.from(filesModified),
    agentIntent,
    hasMergeConflicts: prContext?.hasMergeConflicts ?? false,
    repoOwner: prContext?.repoOwner ?? github.getRepoInfo().owner,
    repoName: prContext?.repoName ?? github.getRepoInfo().repo,
    unresolvedThreads: prContext?.unresolvedThreads ?? [],
    failureAnalysis: failureAnalysis ? {
      category: failureAnalysis.category,
      description: failureAnalysis.description,
      errorMessages: failureAnalysis.errorMessages,
      repeatedPatterns: failureAnalysis.repeatedPatterns,
      suggestions: failureAnalysis.suggestions,
      severity: failureAnalysis.severity
    } : undefined
  };
}
