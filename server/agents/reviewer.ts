import { spawn } from 'bun';
import { loadConfig } from '../config';
import * as db from '../db';
import * as github from '../github/client';
import { broadcast, broadcastTicketUpdated } from '../ws/handler';
import { syncIssues } from '../github/issues';

const CLAUDE_REVIEW_LABEL = 'claude-review';
const USE_OPUS_LABEL = 'use-opus';
const USE_SONNET_LABEL = 'use-sonnet';

interface ReviewResult {
  ticketId: number;
  issueNumber: number;
  verdict: 'ready' | 'minor_gaps' | 'needs_revision' | 'closed' | 'epic';
  gaps: string[];
  recommendations: string | null;
  changesMade: string | null;
  complexity: 'simple' | 'complex' | null;
  priority: 'high' | 'medium' | 'low' | null;
  error?: string;
}

// Active review process
let activeReviewProcess: ReturnType<typeof spawn> | null = null;

export function isReviewRunning(): boolean {
  return activeReviewProcess !== null;
}

export function stopAllReviews(): void {
  if (activeReviewProcess) {
    try {
      activeReviewProcess.kill();
    } catch (e) {
      console.error('Failed to kill review process:', e);
    }
    activeReviewProcess = null;
  }
}

export async function runBatchReview(
  ticketIds: number[],
  issueNumbers: number[]
): Promise<void> {
  const config = loadConfig();
  const { owner, repo } = github.getRepoInfo();

  console.log(`[review] Starting batch review for ${ticketIds.length} tickets using sub-agent pattern`);

  // Broadcast that review is starting
  broadcast({
    type: 'review_started',
    ticketIds,
    issueNumbers
  });

  // Build the coordinator prompt that spawns sub-agents
  const coordinatorPrompt = buildCoordinatorPrompt(issueNumbers, owner, repo);

  try {
    const output = await runCoordinatorAgent(coordinatorPrompt);

    // Parse results from coordinator output
    const results = parseCoordinatorResults(output, ticketIds, issueNumbers);

    // Process results - update GitHub and database
    for (const result of results) {
      if (result.error) {
        console.error(`[review] Error reviewing #${result.issueNumber}:`, result.error);

        // Broadcast individual result even on error
        broadcast({
          type: 'review_progress',
          completed: results.filter(r => !r.error).length,
          total: ticketIds.length,
          results: [result]
        });
        continue;
      }

      // Save review to database
      db.saveIssueReview({
        ticket_id: result.ticketId,
        verdict: result.verdict,
        gaps: JSON.stringify(result.gaps),
        recommendations: result.recommendations,
        changes_made: result.changesMade
      });

      // Set priority if determined by review
      if (result.priority) {
        db.updateTicket(result.ticketId, { priority: result.priority });
        broadcastTicketUpdated(result.ticketId, { priority: result.priority });
        console.log(`[review] Issue #${result.issueNumber} priority set to ${result.priority}`);
      }

      // If epic, add epic label and keep in backlog (don't work on directly)
      if (result.verdict === 'epic') {
        await github.removeLabelFromIssue(result.issueNumber, CLAUDE_REVIEW_LABEL);
        await github.addLabelToIssue(result.issueNumber, 'epic');
        // Move to backlog but it won't be picked up for work due to epic detection
        await github.addLabelToIssue(result.issueNumber, config.github.claudeReadyLabel);
        console.log(`[review] Issue #${result.issueNumber} identified as EPIC, labeled and will be tracked for completion`);
        continue; // Skip normal processing
      }

      // If ready, minor_gaps, or needs_revision, move to Ready column
      if (result.verdict === 'ready' || result.verdict === 'minor_gaps' || result.verdict === 'needs_revision') {
        // Remove claude-review label
        await github.removeLabelFromIssue(result.issueNumber, CLAUDE_REVIEW_LABEL);
        // Add claude-ready label
        await github.addLabelToIssue(result.issueNumber, config.github.claudeReadyLabel);

        const changeNote = result.verdict === 'ready'
          ? 'no changes needed'
          : result.verdict === 'minor_gaps'
            ? 'minor gaps fixed'
            : 'significant revisions made';
        console.log(`[review] Issue #${result.issueNumber} is ready (${changeNote})`);

        // Add complexity-based model label
        if (result.complexity === 'complex') {
          await github.addLabelToIssue(result.issueNumber, USE_OPUS_LABEL);
          console.log(`[review] Issue #${result.issueNumber} marked as complex -> ${USE_OPUS_LABEL}`);
        } else if (result.complexity === 'simple') {
          await github.addLabelToIssue(result.issueNumber, USE_SONNET_LABEL);
          console.log(`[review] Issue #${result.issueNumber} marked as simple -> ${USE_SONNET_LABEL}`);
        }
      }

      // If closed, close the issue
      if (result.verdict === 'closed') {
        await github.closeIssue(result.issueNumber);
        console.log(`[review] Issue #${result.issueNumber} closed by reviewer`);
      }

      // Broadcast progress for each completed result
      broadcast({
        type: 'review_progress',
        completed: results.indexOf(result) + 1,
        total: ticketIds.length,
        results: [result]
      });
    }

    // Sync issues to update the board
    try {
      await syncIssues(config.github.claudeReadyLabel);
    } catch (e) {
      console.error('[review] Failed to sync after review:', e);
    }

    // Broadcast completion
    broadcast({
      type: 'review_completed',
      results: results.map(r => ({
        ticketId: r.ticketId,
        issueNumber: r.issueNumber,
        verdict: r.verdict,
        gaps: r.gaps,
        error: r.error
      }))
    });

    console.log(`[review] Batch review completed: ${results.filter(r => !r.error).length}/${results.length} succeeded`);

  } catch (error) {
    console.error('[review] Coordinator agent failed:', error);

    broadcast({
      type: 'review_completed',
      results: ticketIds.map((ticketId, i) => ({
        ticketId,
        issueNumber: issueNumbers[i],
        verdict: 'needs_revision' as const,
        gaps: [],
        error: error instanceof Error ? error.message : String(error)
      }))
    });
  }
}

function buildCoordinatorPrompt(issueNumbers: number[], owner: string, repo: string): string {
  const issueList = issueNumbers.join(', ');

  return `You are reviewing ${issueNumbers.length} GitHub issues in parallel using sub-agents.

## Issues to Review
${issueNumbers.map(n => `- #${n}`).join('\n')}

## CRITICAL: Spawn ALL review agents in parallel

Use the Task tool to spawn one sub-agent per issue. You MUST spawn ALL agents in a SINGLE message with multiple Task tool calls.

For each issue, use:
- subagent_type: "general-purpose"
- model: "haiku" (fast and cost-efficient for quick reviews)
- description: "Review issue #<number>"
- prompt: The review prompt below (customized with the issue number)

## Review Prompt Template (for each sub-agent)

\`\`\`
Quick review of GitHub issue #<ISSUE_NUMBER> from ${owner}/${repo}.

1. Fetch the issue:
   gh issue view <ISSUE_NUMBER> --json title,body,labels

2. Quick assessment (2 min max):
   - Clear problem statement? (what's broken/needed)
   - Clear solution approach? (how to fix it)
   - Acceptance criteria? (how to verify it's done)
   - Bounded scope? (what's in/out)
   - Reasonable size? (can finish in 1-2 days)

3. Red flags:
   - Vague requirements ("improve", "fix issues")?
   - Scope creep signs (AND, ALSO, additionally)?
   - Multiple unrelated features bundled?

4. EPIC DETECTION (important!):
   Is this an EPIC/PARENT ticket? Check for:
   - Labels: epic, parent, meta, tracking, umbrella
   - Body has "Sub-issues:", "Tasks:", "Deliverables:" sections
   - Multiple checkbox items with issue references (- [ ] #123)
   - References 3+ other issues
   If EPIC: output VERDICT:epic (special handling, not worked directly)

5. Complexity assessment:
   SIMPLE: Single file, bug fix, small refactor, docs, UI tweak
   COMPLEX: Multi-file architecture, new features, security, DB changes, AWS/CDK

6. Priority assessment:
   HIGH: Blocking work, security issues, production bugs
   MEDIUM: Regular features, non-critical bugs (default)
   LOW: Nice-to-have, polish, tech debt

7. If gaps found (and not an epic), edit the issue to add missing info:
   gh issue edit <ISSUE_NUMBER> --body "..."

8. Output format (MUST include this exactly):
   ISSUE:<ISSUE_NUMBER>
   VERDICT:<ready|minor_gaps|needs_revision|closed|epic>
   COMPLEXITY:<simple|complex>
   PRIORITY:<high|medium|low>
   GAPS:<comma-separated list or "none">
   CHANGES:<what you added/fixed or "none">
   RECOMMENDATION:<one sentence>
\`\`\`

## After All Sub-Agents Complete

Collect all results and output a consolidated summary in this EXACT format:

\`\`\`
=== REVIEW RESULTS ===
${issueNumbers.map(n => `
ISSUE:${n}
VERDICT:<verdict>
COMPLEXITY:<complexity>
PRIORITY:<priority>
GAPS:<gaps>
CHANGES:<changes>
RECOMMENDATION:<recommendation>
`).join('')}
=== END RESULTS ===
\`\`\`

Make sure every issue number appears in the results, even if a sub-agent failed (use VERDICT:needs_revision for failures).
`;
}

async function runCoordinatorAgent(prompt: string): Promise<string> {
  const cwd = process.env.REPO_PATH || Bun.env.PWD || '.';

  const args = [
    'claude',
    '-p', prompt,
    '--model', 'sonnet',
    '--output-format', 'text',
    '--max-turns', '50',  // Enough turns to spawn agents and collect results
  ];

  console.log(`[review] Running coordinator agent`);

  const proc = spawn(args, {
    cwd,
    env: { ...Bun.env },
    stdout: 'pipe',
    stderr: 'pipe'
  });

  activeReviewProcess = proc;

  let output = '';
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      output += chunk;

      // Broadcast output for UI
      broadcast({
        type: 'review_output',
        ticketId: 0, // Coordinator output
        content: chunk
      });
    }
  } finally {
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  activeReviewProcess = null;

  if (exitCode !== 0) {
    const stderrReader = proc.stderr.getReader();
    let stderr = '';
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderr += decoder.decode(value);
      }
    } finally {
      stderrReader.releaseLock();
    }

    console.error('[review] Coordinator failed:', stderr || output);
    throw new Error(`Coordinator exited with code ${exitCode}: ${stderr || output}`);
  }

  console.log(`[review] Coordinator completed, output length: ${output.length}`);
  return output;
}

function parseCoordinatorResults(
  output: string,
  ticketIds: number[],
  issueNumbers: number[]
): ReviewResult[] {
  const results: ReviewResult[] = [];

  // Create a map of issue number to ticket ID
  const issueToTicket = new Map<number, number>();
  issueNumbers.forEach((issueNum, idx) => {
    issueToTicket.set(issueNum, ticketIds[idx]);
  });

  // Parse each issue's result from the output
  // Look for patterns like:
  // ISSUE:1234
  // VERDICT:ready
  // COMPLEXITY:simple
  // etc.

  for (const issueNumber of issueNumbers) {
    const ticketId = issueToTicket.get(issueNumber)!;

    // Try to find this issue's results in the output
    const issuePattern = new RegExp(
      `ISSUE:\\s*${issueNumber}[\\s\\S]*?` +
      `VERDICT:\\s*(ready|minor_gaps|needs_revision|closed|epic)[\\s\\S]*?` +
      `COMPLEXITY:\\s*(simple|complex)[\\s\\S]*?` +
      `PRIORITY:\\s*(high|medium|low)[\\s\\S]*?` +
      `GAPS:\\s*([^\\n]+)[\\s\\S]*?` +
      `CHANGES:\\s*([^\\n]+)[\\s\\S]*?` +
      `RECOMMENDATION:\\s*([^\\n]+)`,
      'i'
    );

    const match = output.match(issuePattern);

    if (match) {
      const [, verdict, complexity, priority, gaps, changes, recommendation] = match;

      const gapsStr = gaps?.trim() || 'none';
      const gapsList = gapsStr.toLowerCase() === 'none' ? [] : gapsStr.split(',').map(g => g.trim());

      results.push({
        ticketId,
        issueNumber,
        verdict: verdict.toLowerCase() as ReviewResult['verdict'],
        complexity: complexity?.toLowerCase() as 'simple' | 'complex' | null,
        priority: priority?.toLowerCase() as 'high' | 'medium' | 'low' | null,
        gaps: gapsList,
        recommendations: recommendation?.trim() || null,
        changesMade: changes?.trim() === 'none' ? null : changes?.trim() || null
      });

      console.log(`[review] Parsed result for #${issueNumber}: ${verdict}`);
    } else {
      // Couldn't parse result for this issue
      console.warn(`[review] Could not parse result for issue #${issueNumber}`);
      results.push({
        ticketId,
        issueNumber,
        verdict: 'needs_revision',
        complexity: null,
        priority: null,
        gaps: [],
        recommendations: null,
        changesMade: null,
        error: 'Could not parse review result from coordinator output'
      });
    }
  }

  return results;
}
