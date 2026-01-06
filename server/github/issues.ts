import * as github from './client';
import * as db from '../db';
import { broadcastTicketCreated, broadcastTicketUpdated, broadcast } from '../ws/handler';
import { recordIssueSyncStart, addActivity, setIssueSyncInterval } from '../poll-status';

const CLAUDE_REVIEW_LABEL = 'claude-review';

/**
 * Parse dependencies from issue body text
 * Looks for patterns like:
 * - "depends on #123"
 * - "blocked by #456"
 * - "requires #789"
 * - "after #101"
 */
function parseDependencies(body: string | null): number[] {
  if (!body) return [];

  const patterns = [
    /depends\s+on\s+#(\d+)/gi,
    /blocked\s+by\s+#(\d+)/gi,
    /requires\s+#(\d+)/gi,
    /after\s+#(\d+)/gi,
  ];

  const deps = new Set<number>();
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      deps.add(parseInt(match[1]));
    }
  }

  return [...deps];
}

/**
 * Update dependencies for a ticket based on its issue body
 */
function updateTicketDependencies(ticketId: number, body: string | null): void {
  const dependsOnIssues = parseDependencies(body);
  if (dependsOnIssues.length === 0) return;

  // Find tickets that correspond to these issue numbers
  for (const issueNumber of dependsOnIssues) {
    const dependsOnTicket = db.getTicketByIssueNumber(issueNumber);
    if (dependsOnTicket) {
      db.addDependency(ticketId, dependsOnTicket.id);
      console.log(`[sync] Added dependency: ticket ${ticketId} depends on ticket ${dependsOnTicket.id} (issue #${issueNumber})`);
    }
  }
}

export async function syncIssues(readyLabel: string): Promise<{ added: number; updated: number; removed: number }> {
  // Fetch both claude-ready and claude-review labeled issues
  console.log(`[sync] Fetching issues with labels: "${readyLabel}" and "${CLAUDE_REVIEW_LABEL}"`);

  const [readyIssues, reviewIssues] = await Promise.all([
    github.getIssuesWithLabel(readyLabel),
    github.getIssuesWithLabel(CLAUDE_REVIEW_LABEL).catch((err) => {
      console.error(`[sync] Failed to fetch "${CLAUDE_REVIEW_LABEL}" issues:`, err.message || err);
      return [];
    })
  ]);

  console.log(`[sync] Fetched ${readyIssues.length} "${readyLabel}" issues, ${reviewIssues.length} "${CLAUDE_REVIEW_LABEL}" issues`);

  // Build a map of all issues we care about
  const allIssues = new Map<number, { issue: typeof readyIssues[0]; state: 'backlog' | 'needs_review' }>();

  // Issues with claude-review go to needs_review state
  for (const issue of reviewIssues) {
    const labelNames = issue.labels.map(l => l.name);
    console.log(`[sync] Issue #${issue.number} has "${CLAUDE_REVIEW_LABEL}" label -> needs_review (labels: ${labelNames.join(', ')})`);
    allIssues.set(issue.number, { issue, state: 'needs_review' });
  }

  // Issues with claude-ready (without claude-review) go to backlog
  for (const issue of readyIssues) {
    const labelNames = issue.labels.map(l => l.name);
    const hasReviewLabel = issue.labels.some(l => l.name === CLAUDE_REVIEW_LABEL);
    if (!hasReviewLabel) {
      console.log(`[sync] Issue #${issue.number} has "${readyLabel}" (no review label) -> backlog (labels: ${labelNames.join(', ')})`);
      allIssues.set(issue.number, { issue, state: 'backlog' });
    } else {
      console.log(`[sync] Issue #${issue.number} skipped from backlog - already has "${CLAUDE_REVIEW_LABEL}" label`);
    }
  }

  console.log(`[sync] Total issues to process: ${allIssues.size}`);

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const [issueNumber, { issue, state }] of allIssues) {
    const existing = db.getTicketByIssueNumber(issueNumber);
    const labelsJson = JSON.stringify(issue.labels.map(l => l.name));

    if (!existing) {
      // New issue - create ticket with appropriate state
      const ticket = db.createTicket({
        github_issue_number: issue.number,
        github_issue_url: issue.html_url,
        title: issue.title,
        body: issue.body || undefined,
        labels: labelsJson
      });

      // Update state if it should be needs_review
      if (state === 'needs_review') {
        db.updateTicket(ticket.id, { state: 'needs_review' });
        ticket.state = 'needs_review';
      }

      // Parse and add dependencies from issue body
      updateTicketDependencies(ticket.id, issue.body);

      broadcastTicketCreated(ticket);
      added++;
      console.log(`Added issue #${issue.number} to ${state}: ${issue.title}`);
    } else if (existing.state === 'backlog' || existing.state === 'needs_review') {
      // Update existing ticket if title/body/labels/state changed
      const changes: Record<string, unknown> = {};

      if (existing.title !== issue.title) changes.title = issue.title;
      if (existing.body !== issue.body) changes.body = issue.body;
      if (existing.labels !== labelsJson) changes.labels = labelsJson;
      if (existing.state !== state) changes.state = state;

      if (Object.keys(changes).length > 0) {
        console.log(`[sync] Updating issue #${issue.number}:`, Object.keys(changes).join(', '));
        db.updateTicket(existing.id, changes);
        broadcastTicketUpdated(existing.id, changes);
        updated++;

        // Re-parse dependencies if body changed
        if (changes.body) {
          updateTicketDependencies(existing.id, issue.body);
        }

        if (changes.state) {
          console.log(`[sync] Moved issue #${issue.number} from ${existing.state} to ${state}`);
        }
      } else {
        console.log(`[sync] Issue #${issue.number} unchanged (state: ${existing.state})`);
      }
    } else {
      console.log(`[sync] Issue #${issue.number} skipped - already in state "${existing.state}" (not backlog/needs_review)`);
    }
  }

  // Remove tickets that are no longer valid (closed or labels removed)
  // Only remove from backlog and needs_review states
  const validIssueNumbers = new Set(allIssues.keys());

  for (const state of ['backlog', 'needs_review'] as const) {
    const tickets = db.getTicketsByState(state);
    for (const ticket of tickets) {
      if (!validIssueNumbers.has(ticket.github_issue_number)) {
        db.deleteTicket(ticket.id);
        broadcast({ type: 'ticket_removed', ticketId: ticket.id });
        removed++;
        console.log(`Removed issue #${ticket.github_issue_number}: no longer has required labels or is closed`);
      }
    }
  }

  // Update sync timestamp
  db.setSyncState('last_issue_sync', new Date().toISOString());

  return { added, updated, removed };
}

export function startIssueSyncLoop(label: string, intervalMs: number): void {
  setIssueSyncInterval(intervalMs);

  // Initial sync
  recordIssueSyncStart();
  syncIssues(label).then(({ added, updated, removed }) => {
    console.log(`Initial sync complete: ${added} added, ${updated} updated, ${removed} removed`);
    if (added > 0) {
      addActivity('issue_sync', `Synced ${added} new issue(s) from GitHub`);
    }
  }).catch(err => {
    console.error('Initial issue sync failed:', err);
  });

  // Periodic sync
  setInterval(async () => {
    recordIssueSyncStart();
    try {
      const { added, updated, removed } = await syncIssues(label);
      if (added > 0 || updated > 0 || removed > 0) {
        console.log(`Issue sync: ${added} added, ${updated} updated, ${removed} removed`);
        addActivity('issue_sync', `Synced: ${added} new, ${updated} updated, ${removed} removed`);
      }
    } catch (err) {
      console.error('Issue sync failed:', err);
    }
  }, intervalMs);
}
