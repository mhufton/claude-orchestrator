import type { Ticket, ReviewContext } from '../state/types';

export function buildAgentPrompt(ticket: Ticket, context?: ReviewContext): string {
  const repoOwner = process.env.GITHUB_OWNER || 'OWNER';
  const repoName = process.env.GITHUB_REPO || 'REPO';

  // For retries, use the investigation-first approach with known issues as hints
  if (context && ticket.attempt_count > 1) {
    return buildRetryPrompt(ticket, context, repoOwner, repoName);
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
2. Tests pass (\`npm test\`)
3. Lint passes (\`npm run lint\`)
4. Build passes (\`npm run build\`)

**If you encounter obstacles:** Debug them. Read error messages carefully. Try different approaches.

## CORE PRINCIPLES

- **Simple is Better** - Don't over-engineer
- **Small Commits, Small Scope** - Do one thing well
- **PRs Target dev** - All PRs must target the \`dev\` branch, NOT \`main\`
- **Scope Guard** - If a change isn't required for this issue, create a follow-up issue instead

## WORKFLOW

1. **Implement** the solution
2. **Verify locally**: \`npm test && npm run lint && npm run build\`
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

This helps the next agent (or yourself on retry) quickly understand the work done.

IMPORTANT: Do NOT include "by Claude", "authored by Claude", or similar phrases anywhere.
`;

  return basePrompt;
}

/**
 * Investigation-first retry prompt with known issues as hints
 * Simple statement of what's wrong (like a human would say it) + investigation commands
 */
function buildRetryPrompt(ticket: Ticket, context: ReviewContext, repoOwner: string, repoName: string): string {
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

  return `You are continuing work on GitHub issue #${ticket.github_issue_number}: "${ticket.title}"

This is attempt #${ticket.attempt_count}. A PR exists but has problems that need fixing.

${problemsSection}${reviewFindingsSection}${commentsSection}${userMessagesSection}## FIRST: Read the Handoff Notes

**Start by reading \`.claude-handoff.md\`** if it exists. This contains notes from the previous attempt explaining:
- What approach was taken
- Key files modified
- Tricky parts to watch out for
- What to check if things fail

\`\`\`bash
cat .claude-handoff.md 2>/dev/null || echo "No handoff notes found"
\`\`\`

## Then investigate and fix

Run these commands to understand the current state:

### Check your git state
\`\`\`bash
git status                          # See current state, any uncommitted changes
git log --oneline dev..HEAD         # See what commits you've made on this branch
git diff dev --stat                 # See what files were changed
\`\`\`

### Check the PR status
\`\`\`bash
gh pr view ${ticket.pr_number}                    # See PR description, status, comments
gh pr checks ${ticket.pr_number}                  # See which CI checks passed/failed
gh pr view ${ticket.pr_number} --comments         # See all comments on the PR
\`\`\`

### If CI checks failed, get the actual error logs
\`\`\`bash
gh run list --limit 5                           # Find recent workflow runs
gh run view <run-id> --log-failed               # See actual failure output
\`\`\`

### Check for merge conflicts
\`\`\`bash
git fetch origin dev
git rebase origin/dev                           # This will show conflicts if any exist
# If conflicts: resolve them, then git rebase --continue
# If stuck: git rebase --abort to reset
\`\`\`

### Check for review comments on specific lines
\`\`\`bash
gh api repos/${repoOwner}/${repoName}/pulls/${ticket.pr_number}/comments | jq '.[] | {path: .path, line: .line, body: .body}'
\`\`\`

## STEP 2: FIX WHAT YOU FIND

Based on your investigation:

**If tests/lint/build failed:**
1. Run the failing command locally: \`npm test\` or \`npm run lint\` or \`npm run build\`
2. Read the error output carefully
3. Fix the code
4. Verify locally before pushing: \`npm test && npm run lint && npm run build\`

**If there are review comments:**
1. Read each comment and understand what's being asked
2. Make the requested changes
3. Reply to confirm: \`gh api repos/${repoOwner}/${repoName}/pulls/${ticket.pr_number}/comments/<id>/replies -f body="Fixed"\`

**If there are merge conflicts:**
1. \`git fetch origin dev && git rebase origin/dev\`
2. Resolve each conflict (remove <<<<<<< ======= >>>>>>> markers)
3. \`git add <file>\` then \`git rebase --continue\`
4. Force push: \`git push --force-with-lease\`

**If you're stuck in a rebase:**
1. Check state: \`git status\`
2. If mid-rebase: either resolve and \`git rebase --continue\`, or \`git rebase --abort\` to start over
3. If mid-merge: either resolve and \`git merge --continue\`, or \`git merge --abort\`

## STEP 3: VERIFY AND PUSH

Before pushing, ALWAYS verify:
\`\`\`bash
npm test && npm run lint && npm run build
\`\`\`

If all pass, commit and push:
\`\`\`bash
git add -A
git commit -m "fix: <describe what you fixed>"
git push
\`\`\`

## STEP 4: Update Handoff Notes

Before pushing, update \`.claude-handoff.md\` with what you learned/fixed:
- What the issue was
- How you fixed it
- Any new gotchas discovered

This helps if another retry is needed.

## KEY RULES

- **Read handoff notes first** - Don't start from scratch
- **Investigate before acting** - Don't guess, look at the actual errors
- **PRs target dev branch** - Never push to main
- **No "by Claude" in commits/PRs** - Keep it clean
- **Run checks locally** - Don't push and hope, verify first
- **Update handoff notes** - Leave breadcrumbs for the next attempt

The answers are in the git history, CI logs, PR comments, and handoff notes. Go find them.
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
