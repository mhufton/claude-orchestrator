import * as github from './client';
import * as db from '../db';
import { logStateTransition, archiveTicketLogs } from '../db';
import { parseReviewScore, getReviewFeedback } from './score-parser';
import { broadcastTicketUpdated, broadcastSlotStatus, broadcastChatMessagesDelivered } from '../ws/handler';
import { spawnAgent } from '../agents/spawner';
import { acquireSlot } from '../worktrees/pool';
import { recordPRWatchStart, recordPRWatchComplete, addActivity, setPRWatchInterval } from '../poll-status';
import { tryAcquireRespawnLock } from '../agents/respawn-coordinator';
import { addToQueue, isInQueue } from '../merge-queue/manager';
import { completeBatch } from '../state/machine';
import { categorizeError } from '../agents/error-types';
import { analyzeAgentFailure } from '../agents/failure-analyzer';
import type { Ticket, Batch } from '../state/types';

const SCORE_THRESHOLD = 90;

// Maximum attempts before requiring human intervention
// After this many attempts, stop auto-respawning and flag for attention
// Keep low - if agent can't solve in 3 attempts, it needs human guidance
const MAX_AUTO_ATTEMPTS = 3;

// Minimum time (in ms) that all checks must be completed before we consider merging
// This prevents merging when new checks are still being created
const MIN_CHECK_STABILITY_MS = 30000; // 30 seconds

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

export async function watchTicketPR(ticket: Ticket): Promise<WatchResult> {
  if (!ticket.pr_number) {
    return { action: 'waiting', reason: 'No PR number' };
  }

  try {
    const pr = await github.getPR(ticket.pr_number);

    // Check if PR was merged (externally or via auto-merge)
    if (pr.merged) {
      // Ensure the corresponding GitHub issue is closed
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

      return { action: 'completed', reason: 'PR merged' };
    }

    // Check if PR was closed without merging
    if (pr.state === 'closed') {
      return { action: 'waiting', reason: 'PR closed without merge' };
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
    // BRANCH IS CLEAN - NOW CHECK CI STATUS
    // ==========================================

    let checkStatus: { pending: boolean; allPassed: boolean; failures: Array<{ name: string }>; checksCompletedAt: Date | null; checks?: Array<{ name: string; status: string; conclusion: string | null }> } | null = null;
    try {
      checkStatus = await github.getCheckStatus(pr.head.sha);
    } catch (checkError) {
      console.warn('Could not fetch check status:', checkError instanceof Error ? checkError.message : checkError);
      updateCIStatus(ticket, 'unknown', []);
      return { action: 'waiting', reason: 'Cannot verify CI status - waiting' };
    }

    // Update CI status in database for live tracking
    const ciStatus = checkStatus.pending ? 'running' : (checkStatus.allPassed ? 'passing' : 'failing');
    updateCIStatus(ticket, ciStatus, checkStatus.checks || []);

    if (checkStatus.pending) {
      console.log(`PR #${ticket.pr_number}: CI checks still pending`);
      return { action: 'waiting', reason: 'CI checks pending' };
    }

    // SAFETY CHECK: Ensure checks have been stable (completed) for a minimum time
    if (checkStatus.checksCompletedAt) {
      const timeSinceCompletion = Date.now() - checkStatus.checksCompletedAt.getTime();
      if (timeSinceCompletion < MIN_CHECK_STABILITY_MS) {
        const remainingMs = MIN_CHECK_STABILITY_MS - timeSinceCompletion;
        console.log(`PR #${ticket.pr_number}: Checks completed ${Math.round(timeSinceCompletion / 1000)}s ago, waiting ${Math.round(remainingMs / 1000)}s more for stability`);
        return { action: 'waiting', reason: `Waiting for check stability (${Math.round(remainingMs / 1000)}s remaining)` };
      }
    }

    // ==========================================
    // GATHER REMAINING ISSUES (CI failures, score, comments)
    // ==========================================

    const issues: string[] = [];
    let hasCIFailures = false;
    let hasUnrepliedComments = false;

    // Check CI status
    if (!checkStatus.allPassed) {
      hasCIFailures = true;
      const ciFailureNames = checkStatus.failures.map(f => f.name).join(', ');
      issues.push(`CI failures: ${ciFailureNames}`);
    }

    // Check review score and unreplied comments
    const score = await parseReviewScore(ticket.pr_number);
    const unrepliedComments = await github.getUnrepliedBotComments(ticket.pr_number);

    if (score) {
      db.updateTicket(ticket.id, { current_score: score.total });
      broadcastTicketUpdated(ticket.id, { current_score: score.total });

      if (score.total < SCORE_THRESHOLD) {
        issues.push(`Review score ${score.total}/100 (needs >= ${SCORE_THRESHOLD})`);
      }
    }

    // Only count unreplied comments as blocking if score is below threshold
    // If score >= SCORE_THRESHOLD, the reviewer has already judged them as non-blocking
    // (The score would be lower if the comments were actually important)
    if (unrepliedComments.length > 0 && (!score || score.total < SCORE_THRESHOLD)) {
      hasUnrepliedComments = true;
      issues.push(`${unrepliedComments.length} unreplied review comments`);
    }

    console.log(`PR #${ticket.pr_number}: CI=${hasCIFailures ? 'FAILED' : 'passed'}, score=${score?.total ?? 'none'}, unrepliedComments=${unrepliedComments.length}, attempt=${ticket.attempt_count}`);

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
        ciFailures: hasCIFailures ? checkStatus.failures.map(f => ({
          name: f.name,
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

    // Score passed - check for minor suggestions before merging
    // If there were any deductions (score < 100), create follow-up issue
    if (score.total < 100 && score.feedback) {
      const suggestions = score.feedback
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('-') || line.startsWith('•'))
        .map(line => line.replace(/^[-•]\s*/, ''));

      if (suggestions.length > 0) {
        await github.createFollowUpIssue(
          ticket.github_issue_number,
          ticket.pr_number,
          suggestions
        );
      }
    }

    // Add to merge queue instead of merging directly
    // The merge queue processor will handle the actual merge in FIFO order
    if (isInQueue(ticket.id)) {
      console.log(`PR #${ticket.pr_number}: Already in merge queue, waiting`);
      return { action: 'waiting', reason: 'In merge queue, waiting for turn' };
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
 * Watch a batch's PR for merge status
 * Simpler than ticket watching - batches don't auto-retry on failure,
 * they just need to detect when the PR is merged
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

    return { action: 'waiting', reason: 'PR still open' };
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
  let ciFailures: string[] = [];
  let inlineComments: string[] = [];
  let botComments: string[] = [];
  let hasMergeConflicts = false;

  if (ticket.pr_number) {
    try {
      const pr = await github.getPR(ticket.pr_number);

      // Check for merge conflicts from actual PR state
      hasMergeConflicts = pr.mergeable === false;

      // Get all PR feedback in parallel
      const prFeedback = await github.getPRFeedback(ticket.pr_number, pr.head.sha);

      // CI failures with actionable details (truncated to save tokens)
      ciFailures = prFeedback.checkFailures.map(f => {
        const output = f.output.summary || f.output.text || '';
        const url = f.html_url || f.details_url || '';
        // Give the agent actionable information - truncate verbose output
        let info = `**${f.name}** FAILED`;
        if (output && output !== 'No details') {
          const truncatedOutput = output.length > 300 ? output.slice(0, 300) + '...' : output;
          info += `: ${truncatedOutput}`;
        }
        if (url) {
          info += `\n   Run: \`gh run view --job ${f.id} --log-failed\` for full logs`;
        }
        return info;
      });

      // Inline code review comments (include ID for replies)
      inlineComments = prFeedback.reviewComments.map(c => {
        return `[Comment ID: ${c.id}] ${c.path}${c.line ? `:${c.line}` : ''} (@${c.user.login}): ${c.body}`;
      });

      // Bot comments (GitHub Actions, code review bots, etc.)
      const botUsernames = ['github-actions', 'github-actions[bot]', 'codecov', 'codecov[bot]', 'sonarcloud', 'sonarcloud[bot]'];
      botComments = prFeedback.issueComments
        .filter(c => botUsernames.some(bot => c.user.login.toLowerCase().includes(bot.replace('[bot]', ''))))
        .map(c => `@${c.user.login}: ${c.body.slice(0, 500)}${c.body.length > 500 ? '...' : ''}`);

    } catch (err) {
      console.warn('Error getting PR feedback:', err);
    }
  }

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
    ciFailures,
    inlineComments,
    botComments,
    userMessages,
    lastActivity,
    recentToolCalls,
    recentErrors,
    filesModified: Array.from(filesModified),
    agentIntent,
    hasMergeConflicts,
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
