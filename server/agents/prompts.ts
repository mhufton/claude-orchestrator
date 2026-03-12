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
 * Directive retry prompt - tells agent exactly what to investigate and fix
 * No passive information dumps - clear action items only
 */
function buildRetryPrompt(ticket: Ticket, context: ReviewContext): string {
  const prNumber = ticket.pr_number;

  // Build investigation commands - what to run FIRST
  const investigationSteps: string[] = [];

  // STEP 1: Always check current state
  investigationSteps.push('1. Check PR status: `gh pr view ' + prNumber + '`');

  // STEP 2: CI failures - tell agent to go READ the logs
  if (context.ciFailures && context.ciFailures.length > 0) {
    investigationSteps.push('\n2. **CI IS FAILING** - Debug it now:');
    context.ciFailures.forEach((failure, idx) => {
      investigationSteps.push(`   ${String.fromCharCode(97 + idx)}. ${failure}`);
    });
    investigationSteps.push('   → Run those commands above to see FULL error logs');
    investigationSteps.push('   → Read the logs carefully and understand WHY it failed');
  }

  // STEP 3: Review score too low - go read the review
  if (context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90) {
    const step = context.ciFailures && context.ciFailures.length > 0 ? '3' : '2';
    investigationSteps.push(`\n${step}. **REVIEW SCORE TOO LOW (${context.previousScore}/100)** - Read the review:`);
    investigationSteps.push(`   → Run: \`gh pr view ${prNumber} --comments\``);
    investigationSteps.push('   → Find the comment with "QUALITY_SCORE: ' + context.previousScore + '"');
    investigationSteps.push('   → Read what the reviewer says is wrong');
    investigationSteps.push('   → Fix those specific issues');
  }

  // STEP 4: Merge conflicts - fix them
  if (context.hasMergeConflicts) {
    const step = String(investigationSteps.filter(s => /^\d+\./.test(s)).length + 1);
    investigationSteps.push(`\n${step}. **MERGE CONFLICTS** - Resolve them:`);
    investigationSteps.push('   → Run: `git fetch origin dev && git rebase origin/dev`');
    investigationSteps.push('   → Fix conflicts in each file');
    investigationSteps.push('   → Run: `git rebase --continue`');
  }

  // STEP 5: Review comments - address each one
  if (context.inlineComments && context.inlineComments.length > 0) {
    const step = String(investigationSteps.filter(s => /^\d+\./.test(s)).length + 1);
    investigationSteps.push(`\n${step}. **REVIEW COMMENTS (${context.inlineComments.length})** - Address each:`);
    context.inlineComments.slice(0, 5).forEach((comment, idx) => {
      investigationSteps.push(`   ${idx + 1}. ${comment}`);
    });
    if (context.inlineComments.length > 5) {
      investigationSteps.push(`   ... and ${context.inlineComments.length - 5} more (run \`gh pr view ${prNumber} --comments\` to see all)`);
    }
  }

  // STEP 6: User messages - read and respond
  if (context.userMessages && context.userMessages.length > 0) {
    const step = String(investigationSteps.filter(s => /^\d+\./.test(s)).length + 1);
    investigationSteps.push(`\n${step}. **USER MESSAGES** - The user said:`);
    context.userMessages.forEach((msg, idx) => {
      investigationSteps.push(`   ${idx + 1}. ${msg}`);
    });
  }

  // Failure analysis warning - if repeating same mistakes
  const repeatedPatternsWarning = (context.failureAnalysis && context.failureAnalysis.repeatedPatterns.length > 0)
    ? `
## ⚠️ WARNING - YOU'RE STUCK IN A LOOP

**Previous attempts kept doing this:**
${context.failureAnalysis.repeatedPatterns.map(p => `  - ${p}`).join('\n')}

**These approaches DID NOT WORK.** Try something completely different.

**Suggestions to break the loop:**
${context.failureAnalysis.suggestions.map(s => `  • ${s}`).join('\n')}

`
    : '';

  // Handoff notes from previous attempt (what was tried before)
  const handoffSection = ticket.handoff_notes
    ? `## What Previous Attempt Did:

${ticket.handoff_notes.length > 500 ? ticket.handoff_notes.slice(0, 500) + '\n...[truncated]' : ticket.handoff_notes}

`
    : '';

  // Review feedback details (if score was low)
  const reviewDetailsSection = (context.reviewFeedback && context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90)
    ? `## Specific Review Feedback:

${context.reviewFeedback}

`
    : '';

  // Include failure analysis if available
  const failureAnalysisSection = context.failureAnalysis
    ? `## Failure Analysis from Previous Attempt:

**Category:** ${context.failureAnalysis.category}
**Severity:** ${context.failureAnalysis.severity}
**Root Cause:** ${context.failureAnalysis.description}

${context.failureAnalysis.repeatedPatterns.length > 0
  ? `**⚠️ Warning - Repeated Patterns Detected:**
${context.failureAnalysis.repeatedPatterns.map(p => `  - ${p}`).join('\n')}

These approaches are NOT working. You must try something fundamentally different.

`
  : ''}${context.failureAnalysis.errorMessages.length > 0
  ? `**Recent Errors:**
${context.failureAnalysis.errorMessages.slice(0, 3).map((e, i) => `  ${i + 1}. ${e.split('\n')[0]}`).join('\n')}

`
  : ''}**Actionable Suggestions:**
${context.failureAnalysis.suggestions.map(s => `  • ${s}`).join('\n')}

`
    : '';

  return `Issue #${ticket.github_issue_number}: "${ticket.title}"
PR #${prNumber} - Attempt #${ticket.attempt_count}

## WHAT YOU MUST DO NOW:

${investigationSteps.join('\n')}

${repeatedPatternsWarning}${handoffSection}${reviewDetailsSection}${failureAnalysisSection}## After Investigating, Fix The Issues:

1. Make the necessary changes
2. Test locally: \`queue-run test npm test && queue-run lint npm run lint && queue-run build npm run build\`
3. Commit and push: \`git add . && git commit -m "Fix: [what you fixed]" && git push\`
4. Write handoff notes: Create \`.claude-handoff.md\` explaining what you did (don't commit it)

**Remember:**
- PRs target dev branch
- No "by Claude" in commits/PRs
- If the issue requires unrelated changes, create a follow-up issue instead: \`gh issue create --title "Follow-up: ..." --label "claude-review"\`
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

/**
 * Build a prompt for reviewing a PR created by an agent
 * This agent scores the PR and provides feedback
 */
export function buildPRReviewPrompt(
  ticket: Ticket,
  prNumber: number,
  isFollowUp: boolean = false
): string {
  const repoOwner = process.env.GITHUB_OWNER || 'OWNER';
  const repoName = process.env.GITHUB_REPO || 'REPO';

  const reviewType = isFollowUp ? 'FOLLOW-UP' : 'INITIAL';

  return `You are a code reviewer for an autonomous GitHub orchestrator system. Your job is to review PRs created by Claude agents and provide a quality score with actionable feedback.

**Context:** PRs are created by agents working on GitHub issues. Your review helps determine if the work is ready to merge or needs another attempt.

## This is a ${reviewType} Review

${isFollowUp ? `
**IMPORTANT:** This PR has been reviewed before. The agent has attempted to address previous feedback.

**YOUR OUTPUT FORMAT:**
- Start with QUALITY_SCORE line
- List REMAINING issues (not yet fixed)
- List NEW issues (introduced since last review)
- List RESOLVED issues (what was fixed)
- Keep it CONCISE - bullet points only
` : `
**IMPORTANT:** This is the first review of this PR.

**YOUR OUTPUT FORMAT:**
- Start with QUALITY_SCORE line
- Include PR Essence section (intent, scope, achievement)
- Provide detailed scoring with deductions
- Include breakdown by category
- Provide actionable summary
`}

## First: Understand the Essence

**CRITICAL:** Before diving into code review, understand what this PR is fundamentally trying to accomplish:

1. **Read the PR description and linked issue** - What problem is being solved?
2. **Identify the core intent** - Is this a bug fix, new feature, refactor, or infrastructure change?
3. **Understand success criteria** - How do we know if this PR achieves its goal?
4. **Scan the changes** - Do the file changes align with the stated intent?

**Red Flags:**
- PR description says "fix login bug" but changes unrelated files
- Massive scope creep (fixing one thing but refactoring everything)
- Intent unclear or missing from description

**The essence question:** *"If I had to explain this PR to someone in one sentence, what would I say?"*

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}
- PR: #${prNumber}
- Issue: #${ticket.github_issue_number}

## Code Area Context

Adjust review focus based on the PR's primary area:

### Frontend (web/src/, UI components, React/TypeScript)
**High Priority:**
- Security: XSS prevention, input sanitization, secure state management
- User Experience: Error handling, loading states, accessibility
- Performance: Bundle size, render optimization, unnecessary re-renders
- Test Coverage: Component tests, user interaction flows

### Backend/API (server/, API routes, Express/Node.js)
**High Priority:**
- Security: Input validation, SQL injection, authentication/authorization
- Error Handling: Proper error responses, no leaked stack traces
- Database Operations: Transaction safety, connection pooling, migration safety
- Test Coverage: Integration tests, error case handling

### Database/Schema Changes (migrations, models)
**CRITICAL Priority:**
- Migration Safety: Reversible, no data loss, handles existing data
- Breaking Changes: Impact on existing queries, API contracts
- Performance: Index strategy, query performance

### Infrastructure/DevOps (CDK, GitHub Actions, deployment)
**High Priority:**
- Security: IAM permissions, secrets management
- Breaking Changes: Impact on running services
- Rollback Ability: Can revert changes safely

## Review Priorities (All Areas)

1. **Security (30 points):** Prevent vulnerabilities, exposed credentials, injection attacks
2. **Correctness (30 points):** Code solves the stated problem completely
3. **Test Coverage (20 points):** Critical paths tested, edge cases covered
4. **Code Quality (20 points):** Maintainable, follows existing patterns

### Scoring Philosophy
- **Perfect is the enemy of good:** Pragmatic tradeoffs are acceptable
- **Favor simplicity:** Don't penalize for not over-engineering
- **Context matters:** A small bug fix needs less than a new feature
- **Tests prove correctness:** Passing tests are strong evidence of quality

## Minimum Passing Score: 90/100

- **Score ≥ 90 AND CI passing**: PR will be auto-merged
- **Score < 90**: Agent will be respawned to address your feedback
- **Maximum 3 respawn attempts** before human intervention required

${isFollowUp ? `
## OUTPUT FORMAT: FOLLOW-UP REVIEW

Use this CONCISE format:

\`\`\`
QUALITY_SCORE: [score]

### Remaining Issues

- **[Category]**: [1-2 sentence description] \`file:line\`
- **[Category]**: [1-2 sentence description] \`file:line\`

### New Issues (if any)

- **[Category]**: [1-2 sentence description] \`file:line\`

### Resolved ✓

- [Issue from initial review that was fixed]
- [Issue from initial review that was fixed]
\`\`\`

**Example:**
\`\`\`
QUALITY_SCORE: 92

### Remaining Issues

- **Missing validation**: \`server/api/users.ts:45\` email regex still allows invalid formats like "user@"

### New Issues

None - no new issues introduced.

### Resolved ✓

- SQL injection vulnerability fixed with parameterized queries
- Error messages no longer leak internal paths
- Added comprehensive error handling tests
\`\`\`
` : `
## OUTPUT FORMAT: INITIAL REVIEW

Use this format:

\`\`\`
QUALITY_SCORE: [score]

## PR Essence

**Intent:** [One sentence describing what this PR accomplishes]
**Scope:** [bug fix | small feature | major feature | refactor | infrastructure]
**Achievement:** [Does it accomplish what it set out to do? Yes/No/Partial]

## Scoring

Starting score: 100

Deductions:
- [-X points] [Brief description of issue with severity]
- [-X points] [Brief description of issue with severity]

Final Score: [score]/100

Breakdown:
- Code Quality: [score]/20
- Test Coverage: [score]/20
- Security: [score]/30
- Correctness: [score]/30

## Summary

[1-2 sentence summary highlighting main concerns or noting strong quality]
\`\`\`

**Example:**
\`\`\`
QUALITY_SCORE: 82

## PR Essence

**Intent:** Add user email validation to registration endpoint to prevent invalid email addresses
**Scope:** small feature
**Achievement:** Partial - validates format but has security vulnerabilities

## Scoring

Starting score: 100

Deductions:
- [-8 points] Missing input sanitization on user-provided email field (XSS risk)
- [-5 points] No test coverage for error handling paths (correctness)
- [-3 points] SQL query concatenates user input directly (SQL injection risk)
- [-2 points] Error messages leak internal path information (security)

Final Score: 82/100

Breakdown:
- Code Quality: 18/20
- Test Coverage: 15/20
- Security: 19/30
- Correctness: 30/30

## Summary

The email validation logic is implemented and functionally works, but has critical security vulnerabilities (SQL injection, potential XSS) and insufficient error path testing that must be addressed before merging.
\`\`\`
`}

## Critical Requirements

1. **QUALITY_SCORE line is MANDATORY** - Must be in format \`QUALITY_SCORE: 85\`
2. **Score must be a number** between 0-100
3. **Follow-up reviews MUST be concise** - Bullet points only, no essays
4. **Reference specific locations** - Include \`file:line\` references
5. **Focus on blocking issues** - Not style preferences or nice-to-haves

## Review Guidelines by Severity

### MUST FIX (10+ point deductions each)
- Security vulnerabilities (injection, XSS, exposed secrets)
- Breaking changes without migration path
- Data loss risks
- Complete lack of tests for new functionality
- Code doesn't solve the stated problem

### SHOULD FIX (5-9 point deductions each)
- Missing error handling for likely error cases
- Insufficient test coverage for critical paths
- Risky patterns (race conditions, memory leaks)
- Missing input validation on user data

### NICE TO FIX (1-4 point deductions each)
- Minor code quality issues
- Missing tests for edge cases
- Performance optimizations for non-critical paths
- Documentation gaps

### DON'T PENALIZE
- Style preferences (formatting, comments)
- "Could be more clever" refactoring
- Hypothetical future requirements
- Over-engineering avoidance (simplicity is good!)

## How to Review

1. **Fetch the PR and checkout the branch**:
   \`\`\`bash
   gh pr checkout ${prNumber}
   \`\`\`

2. **Read the changes**:
   \`\`\`bash
   gh pr diff ${prNumber}
   \`\`\`

3. **Review files individually** - Use Read tool to examine key files

4. **Check tests** - Are there tests? Do they actually validate behavior?

5. **Assess security** - Look for injection risks, exposed secrets, auth bypasses

6. **Verify intent** - Does the implementation match the issue description?

7. **Post your review** as a comment using \`gh pr comment\`:
   \`\`\`bash
   gh pr comment ${prNumber} --body "..."
   \`\`\`

## Agent Respawn Context

When you give a score < 90, the agent will receive:
- Your review score and feedback
- All inline review comments (if you add them)
- CI failure logs (if applicable)
- Their previous handoff notes
- Max 3 automatic retry attempts

Focus your review on **blocking issues** that prevent merge.

---

**NOW:** Review PR #${prNumber} and provide your scored feedback.
`;
}
