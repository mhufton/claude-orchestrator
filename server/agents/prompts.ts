import type { Ticket, ReviewContext } from '../state/types';

export function buildAgentPrompt(ticket: Ticket, context?: ReviewContext): string {
  const repoOwner = process.env.GITHUB_OWNER || 'OWNER';
  const repoName = process.env.GITHUB_REPO || 'REPO';

  const basePrompt = `You are working on GitHub issue #${ticket.github_issue_number}

## Issue Title
${ticket.title}

## Issue Description
${ticket.body || 'No description provided.'}

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}
${ticket.pr_number ? `- PR Number: ${ticket.pr_number}` : ''}

## CRITICAL REQUIREMENTS - READ THIS FIRST

**YOU MUST ACTUALLY SOLVE THE PROBLEM. DO NOT:**
- Give up after one or two attempts
- Create a PR without implementing the actual solution
- Say "I'll create a follow-up issue" for the main task itself
- Mark the issue as done without verifying the fix works
- Push incomplete or broken code

**BEFORE creating a PR, you MUST verify:**
1. The actual problem described in the issue is SOLVED
2. Tests pass (\`npm test\`)
3. Lint passes (\`npm run lint\`)
4. Build passes (\`npm run build\`)
5. If you made UI changes, the UI actually works
6. If you made API changes, the API actually works

**If you encounter obstacles:**
- Debug them. Read error messages carefully.
- Try different approaches if the first one fails.
- Research the codebase to understand how similar problems were solved.
- Only ask for help if you've genuinely tried multiple approaches.

**The issue is NOT done until the problem is actually fixed.**

## CORE PRINCIPLES - You MUST follow these

### Code Quality
1. **Simple is Better** - We're not building a rocket
2. **No Hacky Quick Fixes** - Build for the future
3. **Test Success at Each Step** - Don't change core functionality to get tests to pass
4. **Small Commits, Small Files, Small Scope**
5. **Clean Code**:
   - Self-documenting: Use \`calculateTotalRevenue()\` not \`calc()\`
   - Functions do one thing: If you use "and" to describe it, it does too much
   - No magic numbers: Use named constants
   - Readable over clever

### Tech Stack Rules
6. **Infrastructure as Code Only** - All Lambda via CDK, never manual zip/upload
7. **Dev First, Prod via CI/CD** - Test in dev, never deploy directly to prod
8. **Cost-Conscious** - Prefer serverless, avoid VPCs/NAT unless necessary

### Git Standards
9. **Branch Hygiene** - Always branch off latest dev (not main!)
10. **PRs Target dev** - All PRs must target the \`dev\` branch, NOT \`main\`. Workflow: feature → dev → main
11. **Commit Quality** - Explain WHY, format: \`type: description\`
12. **PR Standards** - Reviewable in <30 minutes, link to issues

### Quality & Testing
13. **DRY but Don't Over-Abstract** - Copy-paste twice is fine, third time extract
14. **Error Handling That Matters** - Every external call needs handling, fail loud
15. **Test the Contract, Not Implementation** - Mock external deps, tests should be fast

### Scope Guard (CRITICAL)
16. **Watch for scope creep** - If change isn't required for current issue, create follow-up issue instead
17. **The "Two PR Rule"** - If you think "This PR will do X AND Y" → STOP, create issue for Y, focus on X

## WORKFLOW

### Phase 1: Implementation
- Implement the solution following principles above
- Create follow-up issues for anything out of scope using: \`gh issue create --title "[TYPE]: Brief desc" --body "Follow-up to #${ticket.github_issue_number}. [Why separate]"\`

### Phase 2: Pre-Commit Verification
- Clean up temp files, debug logs, commented-out code
- Run tests: \`npm run test\`
- Run lint: \`npm run lint\`
- Run build: \`npm run build\`
- CDK synth if infrastructure changes: \`npx cdk synth --all\`
- Reflect: Could this be simpler? Over-engineering check?

### Phase 3: Commit & PR
- Meaningful commit message explaining WHY
- **Before pushing, ensure your branch is up to date:**
  \`\`\`
  git fetch origin dev
  git rebase origin/dev
  \`\`\`
  If conflicts occur, resolve them then \`git rebase --continue\`
- Push branch
- If push fails due to pre-push hooks (lefthook), **auto-resolve**:
  - **Tests failed**: Run \`npm test\`, fix failures, commit, retry push
  - **Lint failed**: Run \`npm run lint\`, fix errors, commit, retry push
  - **Build failed**: Run \`npm run build\`, fix errors, commit, retry push
  - **Branch behind dev**: Run \`git fetch origin dev && git rebase origin/dev\`, resolve conflicts, retry push
- Create PR **targeting \`dev\` branch** (NOT main!) with this structure:
  \`\`\`
  gh pr create --base dev --title "..." --body "..."
  \`\`\`
  PR body format:
  \`\`\`
  ## Summary
  [1-2 sentences of what and why]

  ## Changes
  - [Key changes with file paths]

  ## Testing
  - [ ] Tests pass
  - [ ] Lint passes
  - [ ] Build passes

  ## Follow-Up Issues Created
  - #XXX - [Brief description] (if any)

  Closes #${ticket.github_issue_number}
  \`\`\`

IMPORTANT: Do NOT include "by Claude", "authored by Claude", or similar phrases anywhere.
`;

  if (context) {
    // Count all issues for a summary
    const issueCount = [
      context.ciFailures?.length ?? 0,
      context.hasMergeConflicts ? 1 : 0,
      context.inlineComments?.length ?? 0,
      (context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90) ? 1 : 0,
    ].reduce((a, b) => a + (b > 0 ? 1 : 0), 0);

    let retryContext = `

## IMPORTANT: This is a retry attempt (Attempt #${ticket.attempt_count})

`;

    // Add escalating urgency for higher attempts
    if (ticket.attempt_count >= 4) {
      retryContext += `### ⚠️⚠️ CRITICAL: MULTIPLE PREVIOUS ATTEMPTS HAVE FAILED ⚠️⚠️

This is attempt #${ticket.attempt_count}. Previous attempts have NOT successfully resolved all issues.

**You MUST approach this differently:**
1. STOP and carefully analyze what went wrong in previous attempts
2. Read the ENTIRE feedback below before making ANY changes
3. Address EVERY issue completely - do not make partial fixes
4. TEST thoroughly before pushing - run ALL tests, lint, and build
5. If you're unsure about something, research it properly before implementing

Previous attempts failed because issues were not fully addressed.
This time, you MUST be thorough and complete.

`;
    } else if (ticket.attempt_count >= 2) {
      retryContext += `### Previous attempt did not fully resolve all issues

Take extra care to address ALL issues listed below completely before pushing.
Read through the entire list BEFORE starting to work.

`;
    }

    // Show summary of all issues if there are multiple
    if (issueCount > 1) {
      retryContext += `### ⚠️ MULTIPLE ISSUES TO FIX

You have ${issueCount} categories of issues to address in this session:
${context.ciFailures && context.ciFailures.length > 0 ? `- ❌ CI Failures (${context.ciFailures.length} checks failed)\n` : ''}${context.hasMergeConflicts ? '- 🔀 Merge Conflicts with main branch\n' : ''}${context.inlineComments && context.inlineComments.length > 0 ? `- 💬 Review Comments (${context.inlineComments.length} to address)\n` : ''}${context.previousScore !== null && context.previousScore !== undefined && context.previousScore < 90 ? `- 📊 Low Review Score (${context.previousScore}/100, needs >= 90)\n` : ''}
**Address ALL issues before pushing.** Do not push after fixing just one - fix everything first.

`;
    }

    // Show what the agent was doing before it stopped
    const hasActivityContext = (context.recentToolCalls && context.recentToolCalls.length > 0) ||
                               (context.recentErrors && context.recentErrors.length > 0) ||
                               (context.filesModified && context.filesModified.length > 0);

    if (hasActivityContext) {
      retryContext += `### Previous Session Activity
Your last session was interrupted. Here's what you were doing:

`;

      // Show agent's stated intent if available
      if (context.agentIntent) {
        retryContext += `**What you were trying to do:** "${context.agentIntent}..."

`;
      }

      // Show files that were modified
      if (context.filesModified && context.filesModified.length > 0) {
        retryContext += `**Files you modified:**
${context.filesModified.map(f => `- ${f}`).join('\n')}

`;
      }

      // Show recent tool calls
      if (context.recentToolCalls && context.recentToolCalls.length > 0) {
        retryContext += `**Recent tool calls (most recent last):**
${context.recentToolCalls.map(t => `- ${t}`).join('\n')}

`;
      }

      // Show errors encountered - this is crucial for debugging
      if (context.recentErrors && context.recentErrors.length > 0) {
        retryContext += `**⚠️ Errors encountered in previous session:**
${context.recentErrors.map(e => `\`\`\`\n${e}\n\`\`\``).join('\n')}

**You MUST address these errors before proceeding.** Do not repeat the same actions that caused these errors.

`;
      }

      if (context.lastActivity) {
        retryContext += `**Last message:** "${context.lastActivity}..."

`;
      }

      retryContext += `**Continue from where you left off.** Check \`git status\` to see what changes are already made.

`;
    }

    if (context.ciFailures && context.ciFailures.length > 0) {
      retryContext += `### CI Failures
The following CI checks failed:
${context.ciFailures.map(f => `- ${f}`).join('\n')}

**CRITICAL: You MUST reproduce and fix these failures locally before pushing again.**

Required workflow:
1. **Run the failing checks locally** to see the actual error output:
   - If "test" or "tests" failed: Run \`npm test\` and read ALL output carefully
   - If "lint" failed: Run \`npm run lint\` and fix all errors/warnings
   - If "build" or "typecheck" failed: Run \`npm run build\` and fix type errors
   - If "cdk" or "synth" failed: Run \`npx cdk synth --all\`

2. **Create a TodoWrite** with each issue you find from the output

3. **Fix each issue systematically** - don't skip any errors

4. **Re-run ALL checks** before pushing to verify everything passes:
   \`\`\`
   npm test && npm run lint && npm run build
   \`\`\`

5. **Only push after ALL checks pass locally**

DO NOT push until you have verified all checks pass locally. Pushing without local verification wastes CI cycles and delays progress.

`;
    }

    if (context.inlineComments && context.inlineComments.length > 0) {
      retryContext += `### MANDATORY: Code Review Comments (${context.inlineComments.length} items)

**CRITICAL: You MUST address EVERY comment below. Do not skip any.**

Before starting, you MUST:
1. Create a TodoWrite with ONE task for EACH comment below
2. Work through each task systematically
3. After fixing each issue, reply to that comment on GitHub using \`gh api\` to confirm the fix

Here are the comments you MUST address:

${context.inlineComments.map((c, i) => `**[${i + 1}/${context.inlineComments.length}]** ${c}`).join('\n\n')}

---
**Required workflow for EACH comment:**
1. Read the file mentioned in the comment
2. Understand what change is being requested
3. Make the fix
4. Reply to the comment on GitHub using this exact command (replace COMMENT_ID with the ID from the comment):
   \`gh api repos/${repoOwner}/${repoName}/pulls/${ticket.pr_number}/comments/COMMENT_ID/replies -f body="Fixed: <brief description of what you changed>"\`
5. Mark the todo as completed

DO NOT proceed to push until ALL ${context.inlineComments.length} comments have been addressed and replied to.

`;
    }

    if (context.botComments && context.botComments.length > 0) {
      retryContext += `### Bot/Automation Feedback
The following feedback was left by automated tools:
${context.botComments.map(c => `- ${c}`).join('\n')}

Review this feedback and address any issues raised.

`;
    }

    if (context.previousScore !== undefined && context.previousScore !== null) {
      retryContext += `### Previous Review Score: ${context.previousScore}/100 (needs >= 90)

`;

      retryContext += `### FIRST: Run Tests to Find Issues

Before making any changes, you MUST run tests to understand what's failing:

1. Run \`npm test\` and carefully read ALL output
2. Run \`npm run lint\` and check for any warnings/errors
3. Run \`npm run build\` to catch type errors

Look for:
- Failing tests (these cost the most points!)
- Type errors or TypeScript issues
- Linting warnings
- Console errors in test output

Create a TodoWrite with each issue you find, then fix them one by one.

`;

      if (context.reviewFeedback) {
        retryContext += `### Review Feedback
${context.reviewFeedback}

`;
      }

      retryContext += `**CRITICAL: You MUST address ALL issues and PUSH your changes.**

Required workflow:
1. Run tests/lint/build FIRST to identify all issues
2. Create TodoWrite items for each issue found
3. Fix each issue systematically
4. **VERIFY ALL CHECKS PASS** before pushing - run:
   \`\`\`
   npm test && npm run lint && npm run build
   \`\`\`
   If ANY of these fail, fix the issues before pushing!
5. Commit your changes with a meaningful message
6. **PUSH to the remote branch** - this is essential to trigger a new review

DO NOT stop without pushing. The score will only update when new code is pushed.
`;
    }

    if (context.userMessages && context.userMessages.length > 0) {
      retryContext += `### User Messages
The user has sent the following messages for you to consider:

${context.userMessages.map((m, i) => `${i + 1}. ${m}`).join('\n\n')}

Please acknowledge and address these messages in your work.
`;
    }

    if (context.hasMergeConflicts) {
      retryContext += `### CRITICAL: Merge Conflicts Detected

Your PR has merge conflicts with the dev branch that MUST be resolved before it can be merged.

**Required steps to resolve:**
1. First, fetch the latest changes: \`git fetch origin dev\`
2. Rebase your branch onto dev: \`git rebase origin/dev\`
3. If conflicts occur, Git will pause and show which files have conflicts
4. For each conflicted file:
   - Open the file and look for conflict markers: \`<<<<<<<\`, \`=======\`, \`>>>>>>>\`
   - Edit the file to resolve conflicts by choosing the correct code
   - Remove ALL conflict markers completely
   - Stage the resolved file: \`git add <filename>\`
5. After resolving all conflicts: \`git rebase --continue\`
6. If the rebase gets too complicated, you can abort and try merge instead:
   - \`git rebase --abort\`
   - \`git merge origin/dev\`
7. **VERIFY no conflict markers remain**: \`git grep -n "^<<<<<<< \\|^=======\\|^>>>>>>> "\`
8. Run tests, lint, and build to verify nothing is broken
9. After resolving, force push your changes: \`git push --force-with-lease\`

**Important:**
- Check \`git status\` frequently to see what state you're in
- Use \`git diff\` to see what changes you're working with
- NEVER push code with conflict markers - the pre-push hook will block you

DO NOT skip this step. The PR cannot be merged until conflicts are resolved.
`;
    }

    return basePrompt + retryContext;
  }

  return basePrompt;
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
