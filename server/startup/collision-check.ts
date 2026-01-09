/**
 * Startup Collision Check
 *
 * Runs before the main orchestrator loops start to detect potential
 * conflicts with work done outside the orchestrator (merged PRs,
 * closed issues, out-of-sync worktrees, etc.)
 */

import * as db from '../db';
import * as github from '../github/client';
import { getWorktreePath } from '../worktrees/manager';
import { execSync } from 'child_process';
import type { Ticket } from '../state/types';

export interface CollisionIssue {
  ticketId: number;
  issueNumber: number;
  type: 'pr_merged' | 'pr_closed' | 'issue_closed' | 'branch_diverged' | 'worktree_missing' | 'worktree_dirty';
  message: string;
  autoFix?: boolean; // Can this be auto-fixed?
}

export interface CollisionCheckResult {
  issues: CollisionIssue[];
  checked: number;
  clean: number;
}

/**
 * Check all in-flight tickets for potential collisions
 */
export async function checkForCollisions(): Promise<CollisionCheckResult> {
  const issues: CollisionIssue[] = [];

  // Get all tickets that are actively being worked on
  const inProgressTickets = db.getTicketsByState('in_progress');
  const inReviewTickets = db.getTicketsByState('in_review');
  const activeTickets = [...inProgressTickets, ...inReviewTickets];

  console.log(`[collision-check] Checking ${activeTickets.length} active tickets for collisions...`);

  for (const ticket of activeTickets) {
    const ticketIssues = await checkTicket(ticket);
    issues.push(...ticketIssues);
  }

  const result: CollisionCheckResult = {
    issues,
    checked: activeTickets.length,
    clean: activeTickets.length - new Set(issues.map(i => i.ticketId)).size
  };

  return result;
}

async function checkTicket(ticket: Ticket): Promise<CollisionIssue[]> {
  const issues: CollisionIssue[] = [];

  // 1. Check if GitHub issue is still open
  try {
    const issue = await github.getIssue(ticket.github_issue_number);
    if (issue.state === 'closed') {
      issues.push({
        ticketId: ticket.id,
        issueNumber: ticket.github_issue_number,
        type: 'issue_closed',
        message: `GitHub issue #${ticket.github_issue_number} was closed externally`,
        autoFix: true // Can move to done
      });
    }
  } catch (err) {
    console.warn(`[collision-check] Could not fetch issue #${ticket.github_issue_number}:`, err);
  }

  // 2. If ticket has a PR, check PR status
  if (ticket.pr_number) {
    try {
      const pr = await github.getPR(ticket.pr_number);

      if (pr.merged) {
        issues.push({
          ticketId: ticket.id,
          issueNumber: ticket.github_issue_number,
          type: 'pr_merged',
          message: `PR #${ticket.pr_number} was merged externally`,
          autoFix: true // Can move to done
        });
      } else if (pr.state === 'closed') {
        issues.push({
          ticketId: ticket.id,
          issueNumber: ticket.github_issue_number,
          type: 'pr_closed',
          message: `PR #${ticket.pr_number} was closed without merging`,
          autoFix: false // Needs human decision
        });
      }
    } catch (err) {
      console.warn(`[collision-check] Could not fetch PR #${ticket.pr_number}:`, err);
    }
  }

  // 3. If ticket has a worktree slot, check worktree status
  if (ticket.worktree_slot !== null) {
    const worktreePath = getWorktreePath(ticket.worktree_slot);

    // Check if worktree exists
    try {
      execSync(`test -d "${worktreePath}"`, { stdio: 'ignore' });
    } catch {
      issues.push({
        ticketId: ticket.id,
        issueNumber: ticket.github_issue_number,
        type: 'worktree_missing',
        message: `Worktree for slot ${ticket.worktree_slot} is missing`,
        autoFix: false // Needs recreation
      });
      return issues; // Can't check further without worktree
    }

    // Check if worktree is dirty (uncommitted changes)
    try {
      const status = execSync(`cd "${worktreePath}" && git status --porcelain`, { encoding: 'utf-8' });
      if (status.trim()) {
        issues.push({
          ticketId: ticket.id,
          issueNumber: ticket.github_issue_number,
          type: 'worktree_dirty',
          message: `Worktree has uncommitted changes`,
          autoFix: false // Needs human review
        });
      }
    } catch (err) {
      console.warn(`[collision-check] Could not check worktree status for slot ${ticket.worktree_slot}:`, err);
    }

    // Check if local branch diverged from remote
    if (ticket.branch_name) {
      try {
        // Fetch latest from remote
        execSync(`cd "${worktreePath}" && git fetch origin ${ticket.branch_name} 2>/dev/null || true`, { stdio: 'ignore' });

        // Check if local is behind or diverged
        const behindAhead = execSync(
          `cd "${worktreePath}" && git rev-list --left-right --count origin/${ticket.branch_name}...HEAD 2>/dev/null || echo "0 0"`,
          { encoding: 'utf-8' }
        ).trim();

        const [behind, ahead] = behindAhead.split(/\s+/).map(Number);

        if (behind > 0 && ahead > 0) {
          issues.push({
            ticketId: ticket.id,
            issueNumber: ticket.github_issue_number,
            type: 'branch_diverged',
            message: `Local branch diverged from remote (${behind} behind, ${ahead} ahead) - likely external push`,
            autoFix: false // Needs human decision on how to resolve
          });
        } else if (behind > 0) {
          issues.push({
            ticketId: ticket.id,
            issueNumber: ticket.github_issue_number,
            type: 'branch_diverged',
            message: `Local branch is ${behind} commits behind remote - external commits detected`,
            autoFix: false // Could auto-pull but risky
          });
        }
      } catch (err) {
        // Branch might not exist on remote yet, that's fine
      }
    }
  }

  return issues;
}

/**
 * Auto-fix issues that are safe to fix automatically
 */
export async function autoFixCollisions(issues: CollisionIssue[]): Promise<{ fixed: number; skipped: number }> {
  let fixed = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (!issue.autoFix) {
      skipped++;
      continue;
    }

    try {
      if (issue.type === 'pr_merged' || issue.type === 'issue_closed') {
        // Move ticket to done
        db.updateTicket(issue.ticketId, {
          state: 'done',
          worktree_slot: null,
          needs_attention: 0,
          attention_reason: null
        });
        console.log(`[collision-check] Auto-fixed: Moved ticket ${issue.ticketId} (issue #${issue.issueNumber}) to done`);
        fixed++;
      }
    } catch (err) {
      console.error(`[collision-check] Failed to auto-fix issue for ticket ${issue.ticketId}:`, err);
      skipped++;
    }
  }

  return { fixed, skipped };
}

/**
 * Flag non-auto-fixable issues for human attention
 */
export function flagCollisionsForAttention(issues: CollisionIssue[]): number {
  let flagged = 0;

  for (const issue of issues) {
    if (issue.autoFix) continue; // Already handled

    try {
      db.updateTicket(issue.ticketId, {
        needs_attention: 1,
        attention_reason: `Collision detected: ${issue.message}`
      });
      flagged++;
    } catch (err) {
      console.error(`[collision-check] Failed to flag ticket ${issue.ticketId}:`, err);
    }
  }

  return flagged;
}

/**
 * Print a summary of collision check results
 */
export function printCollisionSummary(result: CollisionCheckResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('STARTUP COLLISION CHECK');
  console.log('='.repeat(60));
  console.log(`Checked: ${result.checked} active tickets`);
  console.log(`Clean: ${result.clean}`);
  console.log(`Issues found: ${result.issues.length}`);

  if (result.issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of result.issues) {
      const autoFixLabel = issue.autoFix ? '[AUTO-FIX]' : '[NEEDS ATTENTION]';
      console.log(`  ${autoFixLabel} Ticket ${issue.ticketId} (#${issue.issueNumber}): ${issue.message}`);
    }
  }

  console.log('='.repeat(60) + '\n');
}

/**
 * Run full collision check with auto-fix and flagging
 * Returns true if safe to proceed, false if there are unresolved issues requiring attention
 */
export async function runStartupCollisionCheck(options: { autoFix?: boolean; flagRemaining?: boolean } = {}): Promise<boolean> {
  const { autoFix = true, flagRemaining = true } = options;

  const result = await checkForCollisions();
  printCollisionSummary(result);

  if (result.issues.length === 0) {
    console.log('[collision-check] No collisions detected. Safe to proceed.');
    return true;
  }

  if (autoFix) {
    const autoFixable = result.issues.filter(i => i.autoFix);
    if (autoFixable.length > 0) {
      console.log(`[collision-check] Auto-fixing ${autoFixable.length} issues...`);
      const { fixed, skipped } = await autoFixCollisions(result.issues);
      console.log(`[collision-check] Auto-fixed: ${fixed}, Skipped: ${skipped}`);
    }
  }

  if (flagRemaining) {
    const remaining = result.issues.filter(i => !i.autoFix);
    if (remaining.length > 0) {
      console.log(`[collision-check] Flagging ${remaining.length} issues for attention...`);
      const flagged = flagCollisionsForAttention(remaining);
      console.log(`[collision-check] Flagged: ${flagged}`);
    }
  }

  const unresolved = result.issues.filter(i => !i.autoFix);
  if (unresolved.length > 0) {
    console.log(`\n[collision-check] WARNING: ${unresolved.length} issues require manual attention before proceeding.`);
    return false;
  }

  return true;
}
