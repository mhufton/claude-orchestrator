import type { Ticket, ReviewContext, Batch } from '../state/types';

export function buildAgentPrompt(ticket: Ticket, context?: ReviewContext): string {
  const repoOwner = process.env.GITHUB_OWNER || 'OWNER';
  const repoName = process.env.GITHUB_REPO || 'REPO';

  // For retries, use streamlined prompt with just the issues
  if (context && ticket.attempt_count > 1) {
    return buildRetryPrompt(ticket, context);
  }

  // First attempt - full context prompt
  const basePrompt = `You are working on GitHub issue #${ticket.github_issue_number}

## Issue Title
${ticket.title}

## Issue Description
${ticket.body || 'No description provided.'}

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}

## CRITICAL REQUIREMENTS

**BEFORE creating a PR, you MUST verify:**
1. The actual problem described in the issue is SOLVED
2. Tests pass (\`queue-run test npm test\`)
3. Lint passes (\`queue-run lint npm run lint\`)
4. Build passes (\`queue-run build npm run build\`)

**IMPORTANT:** Use \`queue-run\` for all test/lint/build commands. This prevents resource contention when multiple agents run simultaneously. The command will wait in queue if another agent is running tests.

**If you encounter obstacles:** Debug them. Read error messages carefully. Try different approaches.

## CORE PRINCIPLES

- **Simple is Better** - Don't over-engineer
- **Small Commits, Small Scope** - Do one thing well
- **PRs Target dev** - All PRs must target the \`dev\` branch, NOT \`main\`
- **Scope Guard** - If a change isn't required for this issue, create a follow-up issue:
  \`gh issue create --title "Follow-up: <description>" --body "..." --label "claude-review"\`

## WORKFLOW

1. **Implement** the solution
2. **Verify locally**: \`queue-run test npm test && queue-run lint npm run lint && queue-run build npm run build\`
3. **Rebase on dev**: \`git fetch origin dev && git rebase origin/dev\`
4. **Write handoff notes** (see below)
5. **Push and create PR**: \`gh pr create --base dev --title "..." --body "..."\`

PR body format:
\`\`\`
## Summary
[1-2 sentences]

## Changes
- [Key changes]

Closes #${ticket.github_issue_number}
\`\`\`

## BEFORE YOU FINISH: Write Handoff Notes

**CRITICAL**: Before creating the PR, write a \`.claude-handoff.md\` file in the repo root with:

\`\`\`markdown
# Handoff Notes for Issue #${ticket.github_issue_number}

## What I Did
- [Brief summary of the approach taken]
- [Key files modified and why]

## How It Works
- [Explain the core logic/approach]

## Watch Out For
- [Any tricky parts or edge cases]
- [Things that might break or need attention]

## If This Fails Review
- [What to check first]
- [Likely causes of issues]
\`\`\`

**IMPORTANT:** Do NOT commit this file. The orchestrator will capture it automatically.
This helps the next agent (or yourself on retry) quickly understand the work done.

IMPORTANT: Do NOT include "by Claude", "authored by Claude", or similar phrases anywhere.
`;

  return basePrompt;
}

/**
 * Streamlined retry prompt - just the issues and minimal instructions
 * The agent already knows how to use git/gh commands
 */
function buildRetryPrompt(ticket: Ticket, context: ReviewContext): string {
  // Build simple, direct statements about what's wrong (like a human would say)
  const problems: string[] = [];

  if (context.ciFailures && context.ciFailures.length > 0) {
    problems.push(`- CI is failing (${context.ciFailures.length} check(s) failed)`);
  }

  if (context.hasMergeConflicts) {
    problems.push('- There are merge conflicts with dev branch');
  }

  if (context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90) {
    problems.push(`- Review score is ${context.previousScore}/100 (needs >= 90)`);
  }

  if (context.inlineComments && context.inlineComments.length > 0) {
    problems.push(`- There are ${context.inlineComments.length} unaddressed review comment(s)`);
  }

  if (context.userMessages && context.userMessages.length > 0) {
    problems.push(`- User left ${context.userMessages.length} message(s) for you`);
  }

  // Build the "what's wrong" section - short and direct
  const problemsSection = problems.length > 0
    ? `## What's wrong:
${problems.join('\n')}

`
    : '';

  // If there's review feedback, include it as "here's what the reviewer found"
  const reviewFindingsSection = (context.reviewFeedback && context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90)
    ? `## Reviewer findings:
${context.reviewFeedback}

`
    : '';

  // If there are inline comments, list them briefly
  const commentsSection = (context.inlineComments && context.inlineComments.length > 0)
    ? `## Review comments to address:
${context.inlineComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}

`
    : '';

  // User messages
  const userMessagesSection = (context.userMessages && context.userMessages.length > 0)
    ? `## Messages from user:
${context.userMessages.join('\n')}

`
    : '';

  // Bot comments (from GitHub Actions, review bots, etc.)
  const botCommentsSection = (context.botComments && context.botComments.length > 0)
    ? `## Bot/CI comments:
${context.botComments.join('\n\n')}

`
    : '';

  // Include handoff notes from database if available (truncate to save tokens)
  const handoffSection = ticket.handoff_notes
    ? `## Handoff Notes from Previous Attempt:

${ticket.handoff_notes.length > 500 ? ticket.handoff_notes.slice(0, 500) + '\n...[truncated]' : ticket.handoff_notes}

`
    : '';

  return `You are continuing work on GitHub issue #${ticket.github_issue_number}: "${ticket.title}"

This is attempt #${ticket.attempt_count}. A PR exists but has problems that need fixing.

${problemsSection}${reviewFindingsSection}${commentsSection}${botCommentsSection}${userMessagesSection}${handoffSection}## Your task

1. **Investigate** - Use \`git status\`, \`gh pr checks ${ticket.pr_number}\`, and \`gh run view <id> --log-failed\` to understand current state
2. **Fix** - Address the issues above. Run \`queue-run test npm test && queue-run lint npm run lint && queue-run build npm run build\` locally before pushing
3. **Push** - Commit with a descriptive message and push
4. **Update handoff notes** - Write \`.claude-handoff.md\` with what you learned (don't commit it)

PRs target dev branch. No "by Claude" in commits/PRs.
`;
}

export function buildPRCreationPrompt(ticket: Ticket): string {
  return `Create a pull request for the changes you just made.

Title: Fix issue #${ticket.github_issue_number}: ${ticket.title}

The PR description should follow this format:
## Summary
<1-3 bullet points summarizing what was done>

## Test plan
- [ ] Manual testing completed
- [ ] Automated tests pass
- [ ] Linting passes

Closes #${ticket.github_issue_number}

IMPORTANT: Do NOT include "by Claude", "authored by Claude", or similar phrases anywhere in the PR.
`;
}

/**
 * Build a prompt for a batch agent that handles multiple related issues
 */
export function buildBatchAgentPrompt(batch: Batch, tickets: Ticket[]): string {
  const repoOwner = process.env.GITHUB_OWNER || 'OWNER';
  const repoName = process.env.GITHUB_REPO || 'REPO';
  const issueNumbers = tickets.map(t => t.github_issue_number);
  const closesClause = issueNumbers.map(n => `Closes #${n}`).join('\n');

  // Build the issues section
  const issuesSection = tickets.map((ticket, index) => `
### Issue ${index + 1}: #${ticket.github_issue_number}
**Title:** ${ticket.title}

**Description:**
${ticket.body || 'No description provided.'}
`).join('\n---\n');

  return `You are working on a BATCH of ${tickets.length} related GitHub issues.

These issues have been grouped together because they touch the same area of the codebase (${batch.area_key}).
Working on them together allows for a more efficient, cohesive implementation.

## Issues in This Batch
${issuesSection}

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}

## BATCH WORK INSTRUCTIONS

**IMPORTANT:** These issues are related and should be implemented together in a single cohesive PR.

### Strategy:
1. **Read ALL issues first** to understand the full scope
2. **Plan a unified approach** that addresses ALL issues efficiently
3. **Look for shared code/patterns** that can serve multiple issues
4. **Implement in logical order** (dependencies first)
5. **Create ONE PR** that closes ALL issues

## CRITICAL REQUIREMENTS

**BEFORE creating a PR, you MUST verify:**
1. ALL ${tickets.length} issues in the batch are addressed
2. Tests pass (\`queue-run test npm test\`)
3. Lint passes (\`queue-run lint npm run lint\`)
4. Build passes (\`queue-run build npm run build\`)

**IMPORTANT:** Use \`queue-run\` for all test/lint/build commands. This prevents resource contention when multiple agents run simultaneously.

## CORE PRINCIPLES

- **Simple is Better** - Don't over-engineer
- **Small Commits are OK** - But they should build toward solving ALL issues
- **PRs Target dev** - All PRs must target the \`dev\` branch, NOT \`main\`
- **Scope Guard** - For unrelated improvements, create follow-up issues

## WORKFLOW

1. **Analyze** all ${tickets.length} issues and plan unified approach
2. **Implement** solutions (may require multiple commits)
3. **Verify locally**: \`queue-run test npm test && queue-run lint npm run lint && queue-run build npm run build\`
4. **Rebase on dev**: \`git fetch origin dev && git rebase origin/dev\`
5. **Write handoff notes** (see below)
6. **Push and create PR**: \`gh pr create --base dev --title "..." --body "..."\`

## PR Format (CRITICAL - Must Close All Issues)

\`\`\`
## Summary
[Brief overview of what this batch accomplishes - 2-3 sentences]

## Changes
- [Key changes by area/component]

## Issues Addressed
${tickets.map(t => `- #${t.github_issue_number}: ${t.title}`).join('\n')}

${closesClause}
\`\`\`

**IMPORTANT:** The PR body MUST include "${closesClause}" to automatically close all issues when merged.

## BEFORE YOU FINISH: Write Handoff Notes

**CRITICAL**: Before creating the PR, write a \`.claude-handoff.md\` file in the repo root:

\`\`\`markdown
# Handoff Notes for Batch ${batch.id}

## Issues Addressed
${tickets.map(t => `- #${t.github_issue_number}: ${t.title}`).join('\n')}

## What I Did
- [Brief summary of the unified approach]
- [Key files modified and why]

## How It Works
- [Explain the core logic/approach]
- [How the changes relate to each issue]

## Watch Out For
- [Any tricky parts or edge cases]
- [Things that might break or need attention]

## If This Fails Review
- [What to check first]
- [Likely causes of issues]
\`\`\`

**IMPORTANT:** Do NOT commit this file. The orchestrator will capture it automatically.

IMPORTANT: Do NOT include "by Claude", "authored by Claude", or similar phrases anywhere.
`;
}
