import { Octokit } from '@octokit/rest';

let octokit: Octokit;
let owner: string;
let repo: string;

export function initGitHubClient(token: string, repoOwner: string, repoName: string): void {
  octokit = new Octokit({ auth: token });
  owner = repoOwner;
  repo = repoName;
}

export function getOctokit(): Octokit {
  if (!octokit) {
    throw new Error('GitHub client not initialized. Call initGitHubClient() first.');
  }
  return octokit;
}

export function getRepoInfo(): { owner: string; repo: string } {
  return { owner, repo };
}

// Issue types
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state: 'open' | 'closed';
}

// PR types
export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed' | 'merged';
  head: {
    sha: string;
    ref: string;
  };
  base: {
    ref: string;
  };
  mergeable: boolean | null;
  mergeable_state: 'clean' | 'dirty' | 'unstable' | 'blocked' | 'behind' | 'unknown';
  merged: boolean;
}

export interface CheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  html_url: string | null;  // URL to view the check on GitHub
  details_url: string | null;  // URL to the CI system (e.g., GitHub Actions job)
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
  };
}

export interface PRComment {
  id: number;
  body: string;
  user: {
    login: string;
  };
  created_at: string;
}

// Issue operations
export async function getIssuesWithLabel(label: string): Promise<GitHubIssue[]> {
  const response = await octokit.issues.listForRepo({
    owner,
    repo,
    labels: label,
    state: 'open',
    per_page: 100
  });

  // Filter out PRs (GitHub API returns PRs as issues too)
  return response.data.filter(issue => !issue.pull_request) as GitHubIssue[];
}

export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  const response = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber
  });

  return response.data as GitHubIssue;
}

export async function closeIssue(issueNumber: number): Promise<boolean> {
  try {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed'
    });
    console.log(`Closed issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error(`Failed to close issue #${issueNumber}:`, error);
    return false;
  }
}

export async function addLabelToIssue(issueNumber: number, label: string): Promise<boolean> {
  try {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [label]
    });
    console.log(`Added label "${label}" to issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error(`Failed to add label to issue #${issueNumber}:`, error);
    return false;
  }
}

export async function removeLabelFromIssue(issueNumber: number, label: string): Promise<boolean> {
  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label
    });
    console.log(`Removed label "${label}" from issue #${issueNumber}`);
    return true;
  } catch (error) {
    // Label might not exist on the issue - that's ok
    console.log(`Label "${label}" not found on issue #${issueNumber} (or already removed)`);
    return true;
  }
}

export async function updateIssueBody(issueNumber: number, body: string): Promise<boolean> {
  try {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      body
    });
    console.log(`Updated body of issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error(`Failed to update issue #${issueNumber}:`, error);
    return false;
  }
}

export async function addCommentToIssue(issueNumber: number, body: string): Promise<boolean> {
  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body
    });
    console.log(`Added comment to issue #${issueNumber}`);
    return true;
  } catch (error) {
    console.error(`Failed to add comment to issue #${issueNumber}:`, error);
    return false;
  }
}

// PR operations
export async function getPR(prNumber: number): Promise<GitHubPR> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  });

  return response.data as unknown as GitHubPR;
}

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export async function getPRFiles(prNumber: number): Promise<PRFile[]> {
  const response = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100
  });

  return response.data.map(f => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes
  }));
}

export async function getPRsForBranch(branchName: string): Promise<GitHubPR[]> {
  const response = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${branchName}`,
    state: 'open'
  });

  return response.data as unknown as GitHubPR[];
}

/**
 * Search for PRs on any branch starting with the given prefix
 * Useful when agent creates branch like "claude/1443-description" instead of exact "claude/1443"
 */
export async function getPRsForBranchPrefix(branchPrefix: string): Promise<GitHubPR[]> {
  // List all open PRs and filter by branch prefix
  const response = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100
  });

  const matchingPRs = (response.data as unknown as GitHubPR[]).filter(pr =>
    pr.head.ref.startsWith(branchPrefix)
  );

  return matchingPRs;
}

/**
 * Search for PRs by issue number - looks for "Closes #123" or "#123" in title/body
 */
export async function getPRsForIssue(issueNumber: number): Promise<GitHubPR[]> {
  try {
    // Search for open PRs that reference this issue
    const searchResponse = await octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr is:open ${issueNumber} in:body`,
      sort: 'updated',
      order: 'desc',
      per_page: 5
    });

    // Filter to only PRs that actually reference this issue number
    const prs = searchResponse.data.items.filter(item => {
      const body = item.body || '';
      const title = item.title || '';
      // Look for common patterns: "Closes #123", "#123", "fixes #123"
      const pattern = new RegExp(`(closes|fixes|resolves)?\\s*#${issueNumber}\\b`, 'i');
      return pattern.test(body) || pattern.test(title);
    });

    // Fetch full PR data for each match
    const fullPRs: GitHubPR[] = [];
    for (const item of prs) {
      try {
        const pr = await getPR(item.number);
        fullPRs.push(pr);
      } catch {
        // Skip if we can't fetch the full PR
      }
    }

    return fullPRs;
  } catch (error) {
    console.error(`Error searching PRs for issue #${issueNumber}:`, error);
    return [];
  }
}

/**
 * Search for PRs that reference ALL of the specified issue numbers.
 * Used for batch PRs that close multiple issues.
 */
export async function getPRsForMultipleIssues(issueNumbers: number[]): Promise<GitHubPR[]> {
  if (issueNumbers.length === 0) return [];

  try {
    // Search for open PRs that reference the first issue (as a starting filter)
    const searchResponse = await octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr is:open ${issueNumbers[0]} in:body`,
      sort: 'updated',
      order: 'desc',
      per_page: 10
    });

    // Filter to PRs that close ALL the specified issues
    const prs = searchResponse.data.items.filter(item => {
      const body = (item.body || '').toLowerCase();
      const title = (item.title || '').toLowerCase();
      const combined = body + ' ' + title;

      // Check that ALL issue numbers are referenced with closing keywords
      return issueNumbers.every(n => {
        const pattern = new RegExp(`(closes|fixes|resolves)\\s*#${n}\\b`, 'i');
        return pattern.test(combined);
      });
    });

    // Fetch full PR data for each match
    const fullPRs: GitHubPR[] = [];
    for (const item of prs) {
      try {
        const pr = await getPR(item.number);
        fullPRs.push(pr);
      } catch {
        // Skip if we can't fetch the full PR
      }
    }

    console.log(`[github] Found ${fullPRs.length} PR(s) closing issues ${issueNumbers.map(n => `#${n}`).join(', ')}`);
    return fullPRs;
  } catch (error) {
    console.error(`Error searching PRs for multiple issues:`, error);
    return [];
  }
}

export interface MergeResult {
  success: boolean;
  error?: string;
  errorCode?: number;
}

export async function mergePR(prNumber: number): Promise<MergeResult> {
  try {
    await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: 'squash'
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Extract HTTP status code if available (Octokit errors include it)
    const statusCode = (error as { status?: number }).status;
    console.error(`Failed to merge PR #${prNumber} (status: ${statusCode}):`, message);
    return { success: false, error: message, errorCode: statusCode };
  }
}

/**
 * Update a PR branch to be up-to-date with the base branch.
 * This is a lightweight operation - just merges base into head, no agent needed.
 * Returns true if successful, false if conflicts or other error.
 */
export async function updatePRBranch(prNumber: number): Promise<{ success: boolean; message: string }> {
  try {
    await octokit.pulls.updateBranch({
      owner,
      repo,
      pull_number: prNumber
    });
    console.log(`Successfully updated PR #${prNumber} branch to latest base`);
    return { success: true, message: 'Branch updated successfully' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // "expected head sha didn't match" means the branch was updated by another process
    // (branch-updater and pr-watcher racing, or agent pushed new commits)
    // This is not a failure - just means we should check again on next cycle
    if (message.includes("head sha didn't match") || message.includes("expected head sha")) {
      console.log(`PR #${prNumber}: Branch state changed (likely already updated), will recheck`);
      return { success: true, message: 'Branch state changed, will recheck' };
    }

    // 422 with "conflict" means actual merge conflicts that need resolution
    if (message.includes('conflict')) {
      console.log(`PR #${prNumber} has conflicts that need manual resolution`);
      return { success: false, message: 'Conflicts need manual resolution' };
    }

    console.error(`Failed to update PR #${prNumber} branch:`, error);
    return { success: false, message };
  }
}

// Get the latest commit SHA for a branch (to detect stale PR data)
export async function getBranchHeadSha(branchName: string): Promise<string> {
  const response = await octokit.repos.getBranch({
    owner,
    repo,
    branch: branchName
  });
  return response.data.commit.sha;
}

// Check runs (CI status)
export async function getCheckRuns(sha: string): Promise<CheckRun[]> {
  const response = await octokit.checks.listForRef({
    owner,
    repo,
    ref: sha
  });

  return response.data.check_runs as CheckRun[];
}

// PR comments (issue-level comments)
export async function getPRComments(prNumber: number): Promise<PRComment[]> {
  const response = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100
  });

  return response.data as PRComment[];
}

// PR review comments (inline code review comments)
export interface PRReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: {
    login: string;
  };
  created_at: string;
  in_reply_to_id?: number;
}

export async function getPRReviewComments(prNumber: number): Promise<PRReviewComment[]> {
  const response = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100
  });

  return response.data as unknown as PRReviewComment[];
}

// Get all feedback for a PR (comments + review comments + check failures)
export async function getPRFeedback(prNumber: number, sha: string): Promise<{
  issueComments: PRComment[];
  reviewComments: PRReviewComment[];
  checkFailures: CheckRun[];
}> {
  const [issueComments, reviewComments, checkStatus] = await Promise.all([
    getPRComments(prNumber),
    getPRReviewComments(prNumber),
    getCheckStatus(sha).catch(() => ({ failures: [] as CheckRun[], allPassed: true, pending: false }))
  ]);

  return {
    issueComments,
    reviewComments,
    checkFailures: checkStatus.failures
  };
}

// Create a follow-up issue for minor review items
export async function createFollowUpIssue(
  originalIssueNumber: number,
  prNumber: number,
  suggestions: string[]
): Promise<number | null> {
  if (suggestions.length === 0) return null;

  try {
    // Generate a meaningful title from the suggestions
    // Extract key themes/actions from the suggestions
    const title = generateFollowUpTitle(suggestions, originalIssueNumber);

    const response = await octokit.issues.create({
      owner,
      repo,
      title,
      body: `## Follow-up Items from PR #${prNumber}

The following minor suggestions were noted during code review but were not blocking:

${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

These items can be addressed in a future PR.

---
*Auto-created by Claude Orchestrator from PR #${prNumber} (Issue #${originalIssueNumber})*`,
      // Include claude-review so it goes through triage pipeline
      labels: ['follow-up', 'enhancement', 'claude-review']
    });

    console.log(`Created follow-up issue #${response.data.number}: "${title}" (from PR #${prNumber})`);
    return response.data.number;
  } catch (error) {
    console.error('Failed to create follow-up issue:', error);
    return null;
  }
}

/**
 * Generate a meaningful title for follow-up issues based on the actual suggestions.
 * Extracts key themes and actions to create a descriptive title.
 */
function generateFollowUpTitle(suggestions: string[], originalIssueNumber: number): string {
  // Common action keywords to look for
  const actionPatterns = [
    { pattern: /\b(add|adding|include)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Add' },
    { pattern: /\b(fix|fixing)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Fix' },
    { pattern: /\b(update|updating)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Update' },
    { pattern: /\b(improve|improving)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Improve' },
    { pattern: /\b(refactor|refactoring)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Refactor' },
    { pattern: /\b(remove|removing)\s+(\w+(?:\s+\w+)?)/i, prefix: 'Remove' },
    { pattern: /\b(test|testing|tests)\b/i, prefix: 'Add tests for' },
    { pattern: /\b(documentation|docs|document)\b/i, prefix: 'Improve documentation for' },
    { pattern: /\b(error\s*handling|errors)\b/i, prefix: 'Improve error handling in' },
    { pattern: /\b(validation|validate)\b/i, prefix: 'Add validation for' },
    { pattern: /\b(logging|logs)\b/i, prefix: 'Improve logging in' },
    { pattern: /\b(types?|typing|typescript)\b/i, prefix: 'Improve types for' },
  ];

  // Try to extract meaningful themes from suggestions
  const themes: string[] = [];
  const allText = suggestions.join(' ').toLowerCase();

  for (const { pattern, prefix } of actionPatterns) {
    const match = allText.match(pattern);
    if (match) {
      themes.push(prefix);
      break; // Just get the primary theme
    }
  }

  // Look for specific file/component mentions
  const fileMatch = allText.match(/\b(\w+\.(ts|tsx|js|jsx|css|md))\b/i);
  const componentMatch = allText.match(/\b([A-Z][a-zA-Z]+(?:Component|Page|Hook|Service|Provider|Context))\b/);

  let subject = '';
  if (componentMatch) {
    subject = componentMatch[1];
  } else if (fileMatch) {
    subject = fileMatch[1];
  }

  // Build the title
  if (themes.length > 0 && subject) {
    return `${themes[0]} ${subject}`;
  } else if (themes.length > 0) {
    // Use first suggestion as context, truncated
    const firstSuggestion = suggestions[0].slice(0, 50).replace(/[^\w\s]/g, '').trim();
    return `${themes[0]}: ${firstSuggestion}${suggestions[0].length > 50 ? '...' : ''}`;
  } else if (suggestions.length === 1) {
    // Single suggestion - use it directly, truncated
    const title = suggestions[0].slice(0, 60).replace(/[^\w\s-]/g, '').trim();
    return title.length > 50 ? `${title.slice(0, 50)}...` : title;
  } else {
    // Multiple suggestions - summarize count and first item
    const firstItem = suggestions[0].slice(0, 40).replace(/[^\w\s]/g, '').trim();
    return `${suggestions.length} improvements: ${firstItem}...`;
  }
}

// Check if all bot review comments have been replied to
export async function getUnrepliedBotComments(prNumber: number): Promise<PRReviewComment[]> {
  const reviewComments = await getPRReviewComments(prNumber);

  // Get comments from bots (github-actions, etc)
  const botComments = reviewComments.filter(c =>
    c.user.login === 'github-actions[bot]' ||
    c.user.login.includes('[bot]')
  );

  // A comment is "replied to" if there's another comment with in_reply_to_id pointing to it
  // Note: GitHub API includes in_reply_to_id on replies
  const repliedToIds = new Set(
    reviewComments
      .filter(c => c.in_reply_to_id)
      .map(c => c.in_reply_to_id!)
  );

  // Return bot comments that haven't been replied to
  return botComments.filter(c => !repliedToIds.has(c.id));
}

// Combined status check - tries Check Runs API first, falls back to Commit Status API
export async function getCheckStatus(sha: string): Promise<{
  allPassed: boolean;
  pending: boolean;
  failures: CheckRun[];
  checksCompletedAt: Date | null;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
}> {
  // Try Check Runs API first (works with GitHub Apps and some PATs)
  try {
    const checks = await getCheckRuns(sha);

    if (checks.length > 0) {
      // Use case-insensitive comparison - GitHub API may return different cases
      const pending = checks.some(c => c.status.toLowerCase() !== 'completed');
      const failures = checks.filter(c =>
        c.status.toLowerCase() === 'completed' &&
        c.conclusion?.toLowerCase() !== 'success' &&
        c.conclusion?.toLowerCase() !== 'skipped'
      );

      console.log(`[getCheckStatus] SHA ${sha.slice(0, 7)}: ${checks.length} checks, pending=${pending}, failures=${failures.length}`);
      if (pending) {
        const pendingChecks = checks.filter(c => c.status.toLowerCase() !== 'completed');
        console.log(`[getCheckStatus] Pending checks: ${pendingChecks.map(c => `${c.name}:${c.status}`).join(', ')}`);
      }
      const allPassed = !pending && failures.length === 0;

      // Find the most recent completion time (when the last check finished)
      let checksCompletedAt: Date | null = null;
      if (!pending) {
        const completedTimes = checks
          .map(c => (c as unknown as { completed_at?: string }).completed_at)
          .filter((t): t is string => Boolean(t))
          .map(t => new Date(t));

        if (completedTimes.length > 0) {
          checksCompletedAt = new Date(Math.max(...completedTimes.map(d => d.getTime())));
        }
      }

      // Map checks to simple format for UI display
      const checksForUI = checks.map(c => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion
      }));

      return { allPassed, pending, failures, checksCompletedAt, checks: checksForUI };
    }

    // No checks registered yet for this SHA - treat as pending
    // This prevents acting on stale data when GitHub Actions hasn't started yet
    console.log(`No check runs found for SHA ${sha.slice(0, 7)} - treating as pending`);
    return { allPassed: false, pending: true, failures: [], checksCompletedAt: null, checks: [] };
  } catch (err) {
    // Check Runs API failed (likely permission issue), fall through to Status API
    console.log('Check Runs API unavailable, trying Commit Status API...');
  }

  // Fallback: Commit Status API (works with most PATs)
  try {
    const response = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha
    });

    const status = response.data;

    // If no statuses exist yet, treat as pending (same logic as above)
    if (status.statuses.length === 0) {
      console.log(`No commit statuses found for SHA ${sha.slice(0, 7)} - treating as pending`);
      return { allPassed: false, pending: true, failures: [], checksCompletedAt: null, checks: [] };
    }

    const pending = status.state === 'pending';
    const allPassed = status.state === 'success';

    // Find the most recent update time from statuses
    let checksCompletedAt: Date | null = null;
    if (!pending) {
      const updateTimes = status.statuses
        .map(s => (s as unknown as { updated_at?: string }).updated_at)
        .filter((t): t is string => Boolean(t))
        .map(t => new Date(t));

      if (updateTimes.length > 0) {
        checksCompletedAt = new Date(Math.max(...updateTimes.map(d => d.getTime())));
      }
    }

    // Convert statuses to CheckRun-like format for consistency
    const failures: CheckRun[] = status.statuses
      .filter(s => s.state === 'failure' || s.state === 'error')
      .map(s => ({
        id: 0,
        name: s.context,
        status: 'completed' as const,
        conclusion: 'failure' as const,
        html_url: s.target_url,
        details_url: s.target_url,
        output: {
          title: s.description,
          summary: s.description,
          text: s.target_url
        }
      }));

    // Map statuses to simple format for UI
    const checksForUI = status.statuses.map(s => ({
      name: s.context,
      status: s.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: s.state === 'success' ? 'success' : (s.state === 'failure' || s.state === 'error' ? 'failure' : null)
    }));

    return { allPassed, pending, failures, checksCompletedAt, checks: checksForUI };
  } catch (statusErr) {
    console.error('Both Check Runs and Commit Status APIs failed:', statusErr);
    throw statusErr;
  }
}
