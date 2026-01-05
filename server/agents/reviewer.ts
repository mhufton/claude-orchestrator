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
  verdict: 'ready' | 'minor_gaps' | 'needs_revision' | 'closed';
  gaps: string[];
  recommendations: string | null;
  changesMade: string | null;
  complexity: 'simple' | 'complex' | null;  // Complexity assessment
  priority: 'high' | 'medium' | 'low' | null;  // Criticality/priority
  error?: string;
}

// Active review processes
const activeReviews = new Map<number, { process: ReturnType<typeof spawn>; aborted: boolean }>();

export function isReviewRunning(): boolean {
  return activeReviews.size > 0;
}

export function stopAllReviews(): void {
  for (const [ticketId, { process }] of activeReviews) {
    try {
      process.kill();
    } catch (e) {
      console.error(`Failed to kill review process for ticket ${ticketId}:`, e);
    }
  }
  activeReviews.clear();
}

export async function runBatchReview(
  ticketIds: number[],
  issueNumbers: number[]
): Promise<void> {
  const config = loadConfig();
  const { owner, repo } = github.getRepoInfo();

  // Get max concurrent from settings
  const settings = db.getSettings();
  const maxConcurrent = settings.maxParallelReviews;

  console.log(`[review] Starting batch review for ${ticketIds.length} tickets (max ${maxConcurrent} concurrent)`);

  // Broadcast that review is starting
  broadcast({
    type: 'review_started',
    ticketIds,
    issueNumbers
  });

  const results: ReviewResult[] = [];

  // Process issues in parallel (but limit concurrency)
  for (let i = 0; i < ticketIds.length; i += maxConcurrent) {
    const batch = ticketIds.slice(i, i + maxConcurrent);
    const batchIssues = issueNumbers.slice(i, i + maxConcurrent);

    const batchResults = await Promise.all(
      batch.map((ticketId, idx) =>
        reviewSingleIssue(ticketId, batchIssues[idx], owner, repo)
      )
    );

    results.push(...batchResults);

    // Broadcast progress
    broadcast({
      type: 'review_progress',
      completed: Math.min(i + maxConcurrent, ticketIds.length),
      total: ticketIds.length,
      results: batchResults
    });
  }

  // Process results - update GitHub and database
  for (const result of results) {
    if (result.error) {
      console.error(`[review] Error reviewing #${result.issueNumber}:`, result.error);
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

    // If ready, minor_gaps, or needs_revision (reviewer fixes all of them), move to Ready column
    // Only 'closed' stays out of the Ready column
    if (result.verdict === 'ready' || result.verdict === 'minor_gaps' || result.verdict === 'needs_revision') {
      // Remove claude-review label
      await github.removeLabelFromIssue(result.issueNumber, CLAUDE_REVIEW_LABEL);
      // Add claude-ready label so it appears in Ready column
      await github.addLabelToIssue(result.issueNumber, config.github.claudeReadyLabel);

      const changeNote = result.verdict === 'ready'
        ? 'no changes needed'
        : result.verdict === 'minor_gaps'
          ? 'minor gaps fixed'
          : 'significant revisions made';
      console.log(`[review] Issue #${result.issueNumber} is ready (${changeNote}), swapped ${CLAUDE_REVIEW_LABEL} -> ${config.github.claudeReadyLabel}`);

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
}

async function reviewSingleIssue(
  ticketId: number,
  issueNumber: number,
  owner: string,
  repo: string
): Promise<ReviewResult> {
  console.log(`[review] Reviewing issue #${issueNumber}`);

  const ticket = db.getTicketById(ticketId);
  if (!ticket) {
    return {
      ticketId,
      issueNumber,
      verdict: 'needs_revision',
      gaps: [],
      recommendations: null,
      changesMade: null,
      complexity: null,
      priority: null,
      error: 'Ticket not found'
    };
  }

  // Build the review prompt - comprehensive review like /review-plan.md
  const reviewPrompt = `
You are conducting a THOROUGH review of GitHub issue #${issueNumber} from the ${owner}/${repo} repository.

Your goal is to ensure the issue is complete, well-defined, measurable, and ready for implementation.

## Step 1: Fetch and Understand the Issue

\`\`\`bash
gh issue view ${issueNumber} --json title,body,labels,comments
\`\`\`

Understand:
- What problem is this trying to solve?
- What is the proposed solution?
- What are the deliverables?
- What is the scope?

## Step 2: Completeness Check

Review against these critical questions:

### Problem Definition
- [ ] Clear Problem Statement: Is the problem being solved clearly articulated?
- [ ] Root Cause: Does the plan address the root cause or just symptoms?
- [ ] Context Provided: Is there enough background to understand why this matters?
- [ ] Dependencies Identified: Are there blockers or prerequisites?

### Solution Design
- [ ] Approach Explained: Is the proposed solution clearly described?
- [ ] Alternatives Considered: Were other approaches evaluated?
- [ ] Risks Acknowledged: What could go wrong? Failure modes?
- [ ] Migration Path: If changing existing systems, is there a migration strategy?

### Missing Pieces to Check
- [ ] Monitoring & Observability: How will we know the system is healthy?
- [ ] Rollback Plan: If something goes wrong, how do we undo it?
- [ ] Performance Considerations: Are there scale/performance implications?
- [ ] Security Implications: Are there security considerations?
- [ ] Cost Impact: Will this affect AWS/infrastructure costs?

## Step 3: Clarity & Definition Check

### Requirements
- [ ] Specific Requirements: Are requirements concrete, not vague?
  - BAD: "Make it faster"
  - GOOD: "Reduce API response time from 500ms to <200ms"
- [ ] Acceptance Criteria: Are there clear pass/fail criteria?
- [ ] Edge Cases: Are boundary conditions considered?

### Scope Boundaries
- [ ] In Scope: Is it clear what IS included?
- [ ] Out of Scope: Is it clear what is NOT included?
- [ ] Follow-up Work: Are future enhancements separated from MVP?

## Step 4: Technical Soundness Research

**IMPORTANT: Use web research to validate the technical approach:**

If the issue involves:
- AWS services → Research current best practices and limitations
- External APIs/services → Verify integration patterns
- Security-sensitive features → Check OWASP and security best practices
- Performance-critical components → Research performance characteristics
- New technologies → Verify they're appropriate and well-supported

Use WebSearch to find:
- Official documentation for mentioned technologies
- Best practices for the proposed approach
- Common pitfalls to avoid
- Alternative approaches that might be better

## Step 5: Red Flags to Watch For

- Vague requirements ("improve", "enhance", "fix issues")
- Scope creep signs (AND, ALSO, additionally)
- Multiple unrelated features bundled
- Missing context or dependencies
- No success metrics
- No testing strategy mentioned
- Hacky solutions instead of proper fixes
- Technical debt being created

## Step 6: Complexity Assessment

**SIMPLE (use Sonnet):**
- Single file changes
- Bug fixes with clear reproduction steps
- Small refactors
- Adding tests for existing code
- Documentation updates
- Simple UI tweaks

**COMPLEX (use Opus):**
- Multi-file architectural changes
- New features requiring design decisions
- Performance optimization requiring analysis
- Security-related changes
- Database/infrastructure changes
- Complex state management
- Integration with external systems
- AWS CDK changes

## Step 7: Priority Assessment

**HIGH priority:**
- Blocking other work or team members
- Security vulnerabilities
- Production bugs affecting users
- Critical path for upcoming release
- Data integrity issues

**MEDIUM priority (default):**
- Regular feature work
- Non-critical bugs
- Improvements and enhancements

**LOW priority:**
- Nice-to-have features
- Minor polish/cosmetic changes
- Tech debt that isn't urgent
- Documentation improvements

## Step 8: Actions Based on Your Analysis

**IMPORTANT: Your job is to FIX issues, not just report them. Always attempt to improve the issue.**

### If READY (comprehensive, no gaps):
- Output: VERDICT:ready
- Include recommendations for implementation approach

### If GAPS FOUND (minor or major - YOU MUST FIX THEM):
1. First, document what gaps you found
2. Then EDIT the issue body to add the missing information:
   \`\`\`bash
   gh issue edit ${issueNumber} --body "..."
   \`\`\`
3. Add what was missing:
   - Acceptance criteria if missing
   - Scope definition (in/out of scope) if unclear
   - Success metrics if not defined
   - Technical approach if vague
   - Edge cases if not considered
   - Any other missing sections from your analysis
4. If you made minor additions: Output VERDICT:minor_gaps
5. If you made significant revisions: Output VERDICT:needs_revision
   - But still move it forward - you've done the revision!

The difference between minor_gaps and needs_revision is the SEVERITY of changes you made, not whether you fixed them. You should ALWAYS attempt to fix the issue.

### If SHOULD BE CLOSED:
1. Add comment explaining why (duplicate, out of scope, invalid)
2. Output: VERDICT:closed

### If you truly cannot proceed (very rare):
Only if the issue is so unclear that you cannot even attempt a fix (e.g., just says "fix the thing" with no context), then:
1. Add a comment asking specific clarifying questions
2. Output: VERDICT:needs_revision
But try your best to infer intent and make reasonable assumptions before giving up.

## Output Format

After completing your analysis and any actions, output:

VERDICT:<ready|minor_gaps|needs_revision|closed>
COMPLEXITY:<simple|complex>
PRIORITY:<high|medium|low>
GAPS:<comma-separated list or "none">
CHANGES:<description of changes made or "none">
RECOMMENDATIONS:<implementation recommendations, best practices to follow, potential pitfalls to avoid - be specific and actionable>
`;

  try {
    // Run Claude to review the issue
    const result = await runClaudeReview(reviewPrompt, ticketId);

    // Parse the result
    const verdictMatch = result.match(/VERDICT:(ready|minor_gaps|needs_revision|closed)/);
    const complexityMatch = result.match(/COMPLEXITY:(simple|complex)/);
    const priorityMatch = result.match(/PRIORITY:(high|medium|low)/);
    const gapsMatch = result.match(/GAPS:([^\n]+)/);
    const changesMatch = result.match(/CHANGES:([^\n]+)/);
    // Recommendations can be multi-line, capture until end or next section
    const recommendationsMatch = result.match(/RECOMMENDATIONS:([\s\S]*?)(?=\n[A-Z]+:|$)/);

    const verdict = (verdictMatch?.[1] as ReviewResult['verdict']) || 'needs_revision';
    const complexity = (complexityMatch?.[1] as 'simple' | 'complex') || null;
    const priority = (priorityMatch?.[1] as 'high' | 'medium' | 'low') || null;
    const gapsStr = gapsMatch?.[1]?.trim() || 'none';
    const gaps = gapsStr === 'none' ? [] : gapsStr.split(',').map(g => g.trim());
    const changesMade = changesMatch?.[1]?.trim() || null;
    const recommendations = recommendationsMatch?.[1]?.trim() || null;

    return {
      ticketId,
      issueNumber,
      verdict,
      gaps,
      recommendations: recommendations === 'none' ? null : recommendations,
      changesMade: changesMade === 'none' ? null : changesMade,
      complexity,
      priority
    };
  } catch (error) {
    return {
      ticketId,
      issueNumber,
      verdict: 'needs_revision',
      gaps: [],
      recommendations: null,
      changesMade: null,
      complexity: null,
      priority: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runClaudeReview(prompt: string, ticketId: number): Promise<string> {
  // Run from current directory (should be repo root)
  // Review agent doesn't need a worktree - it just uses gh commands
  const cwd = Bun.env.PWD || '.';

  const args = [
    'claude',
    '-p', prompt,
    '--model', 'sonnet',  // Use Sonnet for reviews
    '--output-format', 'text',
    '--max-turns', '25',  // More turns for thorough review with research
    '--allowedTools', 'Bash,Read,Grep,Glob,WebSearch,WebFetch' // Enable web research
  ];

  console.log(`[review] Running claude for ticket ${ticketId} in ${cwd}`);

  const proc = spawn(args, {
    cwd,
    env: { ...Bun.env },
    stdout: 'pipe',
    stderr: 'pipe'
  });

  activeReviews.set(ticketId, { process: proc, aborted: false });

  let output = '';

  // Read stdout
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      output += chunk;

      // Broadcast progress
      broadcast({
        type: 'review_output',
        ticketId,
        content: chunk
      });
    }
  } finally {
    reader.releaseLock();
  }

  // Wait for process to complete
  const exitCode = await proc.exited;

  activeReviews.delete(ticketId);

  if (exitCode !== 0) {
    // Read stderr
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

    console.error(`[review] Claude failed for ticket ${ticketId}:`, stderr || output);
    throw new Error(`Claude exited with code ${exitCode}: ${stderr || output}`);
  }

  console.log(`[review] Claude completed for ticket ${ticketId}, output length: ${output.length}`);
  return output;
}
