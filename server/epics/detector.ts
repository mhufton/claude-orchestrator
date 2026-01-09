import * as db from '../db';
import * as github from '../github/client';
import { broadcast, broadcastTicketUpdated } from '../ws/handler';
import type { Ticket } from '../state/types';

// Labels that indicate an epic/parent ticket
const EPIC_LABELS = ['epic', 'parent', 'meta', 'tracking', 'umbrella'];

// Patterns that indicate an epic (checkbox lists, sub-issue references)
// NOTE: "depends on" and "blocked by" are NOT epic patterns - they indicate dependencies!
const EPIC_PATTERNS = [
  /##\s*(sub-?issues|child\s*issues|tasks)/i,  // Explicit sub-issue sections
  /parent of:?\s*#\d+/i,  // Explicitly declares being a parent
  /tracks:?\s*(#\d+[,\s]*){2,}/i,  // Tracks multiple issues (2+)
];

// Patterns that require MULTIPLE matches to be considered an epic
// A single checkbox with an issue ref is normal; 3+ is an epic
const MULTI_CHECKBOX_PATTERN = /- \[[ xX]\] .*?#\d+/g;

// Pattern to extract linked issue numbers from epic body
const LINKED_ISSUE_PATTERN = /#(\d+)/g;
const CHECKBOX_ISSUE_PATTERN = /- \[([ xX])\] .*?#(\d+)/g;

export interface EpicInfo {
  isEpic: boolean;
  reason: string | null;
  linkedIssues: number[];
  checkboxes: Array<{ issueNumber: number; checked: boolean }>;
}

/**
 * Detect if a ticket is an epic based on labels and body patterns
 */
export function detectEpic(ticket: Ticket): EpicInfo {
  const result: EpicInfo = {
    isEpic: false,
    reason: null,
    linkedIssues: [],
    checkboxes: []
  };

  // Spikes are NOT epics - they're investigation/research tasks
  // They often have "## Deliverables" sections which would trigger epic detection
  if (ticket.title.toLowerCase().includes('[spike]')) {
    return result;
  }

  // Check 1: Label-based detection
  let labels: string[] = [];
  try {
    labels = JSON.parse(ticket.labels || '[]');
  } catch {
    labels = [];
  }

  const epicLabel = labels.find(l =>
    EPIC_LABELS.some(el => l.toLowerCase().includes(el))
  );

  if (epicLabel) {
    result.isEpic = true;
    result.reason = `has label: ${epicLabel}`;
  }

  // Check 2: Pattern detection in body
  const body = ticket.body || '';

  for (const pattern of EPIC_PATTERNS) {
    if (pattern.test(body)) {
      result.isEpic = true;
      result.reason = result.reason || `matches epic pattern`;
      break;
    }
  }

  // Check 3: Multiple checkbox items with issue references (3+ = epic)
  if (!result.isEpic) {
    const checkboxMatches = body.match(MULTI_CHECKBOX_PATTERN);
    if (checkboxMatches && checkboxMatches.length >= 3) {
      result.isEpic = true;
      result.reason = `has ${checkboxMatches.length} checkbox items with issue references`;
    }
  }

  // Extract linked issues and checkboxes
  if (body) {
    // Find all checkbox items with issue references
    let match;
    while ((match = CHECKBOX_ISSUE_PATTERN.exec(body)) !== null) {
      const checked = match[1].toLowerCase() === 'x';
      const issueNumber = parseInt(match[2], 10);
      result.checkboxes.push({ issueNumber, checked });
      if (!result.linkedIssues.includes(issueNumber)) {
        result.linkedIssues.push(issueNumber);
      }
    }

    // Find other linked issues (not in checkboxes) - for epic completion tracking only
    const allLinked = [...body.matchAll(LINKED_ISSUE_PATTERN)].map(m => parseInt(m[1], 10));
    for (const num of allLinked) {
      if (!result.linkedIssues.includes(num)) {
        result.linkedIssues.push(num);
      }
    }
    // NOTE: We no longer auto-flag as epic just because it references 3+ issues
    // Normal issues often reference related issues, dependencies, etc.
    // Epic detection should be based on explicit labels or structural patterns only
  }

  return result;
}

/**
 * Check if a ticket should be skipped for work assignment (is an epic)
 */
export function shouldSkipForWork(ticket: Ticket): boolean {
  const epicInfo = detectEpic(ticket);
  return epicInfo.isEpic;
}

/**
 * Check if an epic's DoDs are all complete
 * Returns true if all linked issues are closed
 */
export async function checkEpicCompletion(ticket: Ticket): Promise<{
  complete: boolean;
  progress: { done: number; total: number };
  openIssues: number[];
}> {
  const epicInfo = detectEpic(ticket);

  if (!epicInfo.isEpic || epicInfo.linkedIssues.length === 0) {
    return { complete: false, progress: { done: 0, total: 0 }, openIssues: [] };
  }

  const openIssues: number[] = [];
  let doneCount = 0;

  for (const issueNumber of epicInfo.linkedIssues) {
    try {
      const issue = await github.getIssue(issueNumber);
      if (issue.state === 'closed') {
        doneCount++;
      } else {
        openIssues.push(issueNumber);
      }
    } catch (error) {
      // Issue might not exist or be inaccessible
      console.warn(`[epic] Could not check issue #${issueNumber}:`, error);
      openIssues.push(issueNumber); // Treat as not done
    }
  }

  return {
    complete: openIssues.length === 0,
    progress: { done: doneCount, total: epicInfo.linkedIssues.length },
    openIssues
  };
}

/**
 * Run periodic check on all epics to see if any are complete
 */
export async function checkAllEpicsCompletion(): Promise<void> {
  console.log('[epic] Checking epic completion status...');

  // Get all tickets that might be epics (in any state except done)
  const allTickets = db.getAllTickets().filter(t => t.state !== 'done');

  for (const ticket of allTickets) {
    const epicInfo = detectEpic(ticket);

    if (!epicInfo.isEpic) continue;

    console.log(`[epic] Checking epic #${ticket.github_issue_number}: ${ticket.title}`);

    const completion = await checkEpicCompletion(ticket);

    console.log(`[epic] Epic #${ticket.github_issue_number} progress: ${completion.progress.done}/${completion.progress.total}`);

    if (completion.complete && completion.progress.total > 0) {
      console.log(`[epic] Epic #${ticket.github_issue_number} is COMPLETE! Closing...`);

      try {
        // Add completion comment
        await github.addCommentToIssue(
          ticket.github_issue_number,
          `All ${completion.progress.total} sub-issues have been completed. Closing this epic.\n\n` +
          `Linked issues: ${epicInfo.linkedIssues.map(n => `#${n}`).join(', ')}`
        );

        // Close the issue
        await github.closeIssue(ticket.github_issue_number);

        // Update local state
        db.updateTicket(ticket.id, { state: 'done' });
        broadcastTicketUpdated(ticket.id, { state: 'done' });

        broadcast({
          type: 'epic_completed',
          ticketId: ticket.id,
          issueNumber: ticket.github_issue_number,
          subIssues: epicInfo.linkedIssues
        });

      } catch (error) {
        console.error(`[epic] Failed to close epic #${ticket.github_issue_number}:`, error);
      }
    }
  }
}

/**
 * Move any epics stuck in needs_review to backlog
 * This handles epics that got into triage before we added filtering
 */
export function moveEpicsOutOfTriage(): void {
  const triageTickets = db.getTicketsByState('needs_review');

  for (const ticket of triageTickets) {
    const epicInfo = detectEpic(ticket);
    if (epicInfo.isEpic) {
      console.log(`[epic] Moving epic #${ticket.github_issue_number} from needs_review to backlog (${epicInfo.reason})`);
      db.updateTicket(ticket.id, { state: 'backlog' });
      broadcastTicketUpdated(ticket.id, { state: 'backlog' });
    }
  }
}

/**
 * Start periodic epic completion checking
 */
let epicCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startEpicChecker(intervalMs: number = 300000): void { // Default 5 min
  if (epicCheckInterval) {
    clearInterval(epicCheckInterval);
  }

  console.log(`[epic] Starting epic completion checker (interval: ${intervalMs}ms)`);

  // Move any stuck epics out of triage immediately
  moveEpicsOutOfTriage();

  // Run completion check immediately
  checkAllEpicsCompletion().catch(err => {
    console.error('[epic] Epic check failed:', err);
  });

  epicCheckInterval = setInterval(() => {
    // Also move epics out of triage periodically
    moveEpicsOutOfTriage();

    checkAllEpicsCompletion().catch(err => {
      console.error('[epic] Epic check failed:', err);
    });
  }, intervalMs);
}

export function stopEpicChecker(): void {
  if (epicCheckInterval) {
    clearInterval(epicCheckInterval);
    epicCheckInterval = null;
    console.log('[epic] Stopped epic completion checker');
  }
}
