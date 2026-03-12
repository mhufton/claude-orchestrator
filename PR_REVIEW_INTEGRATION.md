# PR Review Agent Integration

## How This Would Work

### Current Flow
```
Agent creates PR
    ↓
External review (GitHub Actions / human)
    ↓
pr-watcher.ts polls for review score
    ↓
Parse score from comments (score-parser.ts)
    ↓
If score < 90: respawn agent with feedback
```

### New Flow with PR Review Agent
```
Agent creates PR
    ↓
Spawn PR Review Agent (Haiku for speed/cost)
    ↓
Review agent posts score + feedback as comment
    ↓
pr-watcher.ts detects review comment
    ↓
Parse score (already works via score-parser.ts)
    ↓
If score < 90: respawn work agent with feedback
```

## Code to Add to `server/agents/prompts.ts`

Add this function to generate the PR review agent prompt:

```typescript
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
```

## Usage

### When to Spawn PR Review Agent

In `server/agents/spawner.ts` or a new `pr-reviewer.ts` file:

```typescript
import { buildPRReviewPrompt } from './prompts';

async function spawnPRReviewAgent(ticket: Ticket, prNumber: number): Promise<void> {
  // Check if this is a follow-up review (previous review comments exist)
  const previousReviews = await github.getPRComments(prNumber);
  const hasReviewScore = previousReviews.some(c => c.body?.includes('QUALITY_SCORE:'));

  const prompt = buildPRReviewPrompt(ticket, prNumber, hasReviewScore);

  // Spawn agent (use Haiku for speed/cost)
  const agent = await spawnAgent(ticket, {
    prompt,
    model: 'haiku', // Fast and cheap for reviews
    type: 'pr-review'
  });

  // Wait for completion and parse score
  const reviewComment = await agent.waitForCompletion();
  const score = parseReviewScore(reviewComment);

  // The existing pr-watcher.ts will detect the score and handle respawn if needed
}
```

### Trigger Point

You could trigger this:
1. **After PR creation** - In the agent completion handler when a PR is detected
2. **On PR sync** - When agent pushes new commits after feedback
3. **Manual trigger** - Via dashboard button or API endpoint

### Benefits Over External Review

1. **Faster**: No waiting for CI to run first (though CI still runs in parallel)
2. **Context-aware**: Understands the issue being solved
3. **Cost-effective**: Haiku model is very cheap for reviews
4. **Integrated**: Seamlessly fits into existing respawn logic
5. **Consistent**: Same review quality every time

### Suggested Integration Path

1. **Add `buildPRReviewPrompt()` to `prompts.ts`** (code above)
2. **Create `server/agents/pr-reviewer.ts`** for spawning review agents
3. **Call from agent completion handler** when PR is detected
4. **Existing pr-watcher.ts handles the rest** (already parses scores & respawns)

This gives you autonomous PR review while keeping the battle-tested respawn logic you already have!
