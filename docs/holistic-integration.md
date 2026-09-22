# Holistic Analysis Integration for Claude Orchestrator

> **Summary**: How to integrate `/holistic` architectural analysis into the orchestrator's agent workflow to prevent reinventing the wheel and improve code quality.

## What is `/holistic`?

The `/holistic` command is a specialized skill that performs comprehensive architectural analysis before implementation:

1. **Code Reuse Detection** - Finds existing patterns, utilities, and shared libraries
2. **Dependency Mapping** - Traces cross-stack and cross-component dependencies
3. **Pattern Consistency** - Shows examples of similar code to follow
4. **Risk Assessment** - Identifies breaking changes, resource replacements, security issues
5. **End-to-End Flow Tracing** - Maps request → response flows

## Benefits for Orchestrator

### Without `/holistic`:
```
Agent spawns → Dives into implementation → Creates duplicate code →
Review finds issues → Retry → Still misses patterns → Low score
```

### With `/holistic`:
```
Agent spawns → Runs /holistic → Finds existing patterns →
Extends instead of creating → High quality PR → Auto-merge
```

## Integration Architecture

```
┌─────────────────────────────────────────────────┐
│  Orchestrator spawns agent for issue #123      │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  Agent Prompt Includes │
        │  "/holistic" Step      │
        └────────┬───────────────┘
                 │
                 ▼
    ┌────────────────────────────┐
    │  Agent runs /holistic      │
    │  "Add email notifications" │
    └────────┬───────────────────┘
             │
             ▼
    ┌─────────────────────────────────┐
    │  Analysis finds:                │
    │  - Existing notification system │
    │  - WebSocket broadcast pattern  │
    │  - Email service helper         │
    └────────┬────────────────────────┘
             │
             ▼
    ┌──────────────────────────────────┐
    │  Agent extends existing code     │
    │  instead of creating from scratch│
    └────────┬─────────────────────────┘
             │
             ▼
    ┌──────────────────────────────┐
    │  High quality PR created     │
    │  Score: 95/100               │
    │  Auto-merged ✓               │
    └──────────────────────────────┘
```

## Setup Instructions

### 1. Copy `/holistic` to Target Repository

The orchestrator's target repository needs the `/holistic` command:

```bash
# From your RentAWrap project
cd /path/to/target/repo

# Create .claude directories if they don't exist
mkdir -p .claude/commands .claude/checklists .claude/guides

# Copy holistic command
cp /Users/mikeh/raw/.claude/commands/holistic.md .claude/commands/

# Copy impact analysis checklist
cp /Users/mikeh/raw/.claude/checklists/impact-analysis.md .claude/checklists/

# Copy workflow guide (optional but helpful)
cp /Users/mikeh/raw/.claude/guides/holistic-workflow.md .claude/guides/

# Commit to repo
git add .claude/
git commit -m "Add /holistic command for architectural analysis"
git push origin dev
```

### 2. Update Agent Prompts

Modify `server/agents/prompts.ts` to include `/holistic` in the workflow:

**Add to `buildAgentPrompt()` function:**

```typescript
const basePrompt = `You are working on GitHub issue #${ticket.github_issue_number}

## Issue Title
${ticket.title}

## Issue Description
${ticket.body || 'No description provided.'}

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}

## STEP 1: HOLISTIC ANALYSIS (Run First!)

**BEFORE implementing anything**, run architectural analysis to understand existing patterns and avoid reinventing the wheel:

\`\`\`bash
/holistic "Issue #${ticket.github_issue_number}: ${ticket.title}"
\`\`\`

**What this does:**
- Finds existing code you can reuse or extend
- Shows you established patterns to follow
- Maps dependencies and integration points
- Identifies risks (breaking changes, resource replacements)
- Recommends which specialized agents to use

**Critical Questions to Answer:**
1. Does similar functionality already exist? (Can I extend it?)
2. What's the established pattern for this? (Show 2-3 examples)
3. What other parts of the system are affected?
4. Are there risks I should know about?

**Output:** The /holistic analysis will give you:
- ✅ Code reuse opportunities (MOST IMPORTANT)
- Dependency map (what's affected)
- Pattern examples (what to follow)
- Risk assessment (what to watch out for)
- Recommended approach (extend vs. create new)

**Next:** Based on the holistic findings, plan your implementation approach.

## STEP 2: IMPLEMENTATION

Now that you understand the context, implement the solution following the patterns discovered in Step 1.

## CRITICAL REQUIREMENTS

**BEFORE creating a PR, you MUST verify:**
1. The actual problem described in the issue is SOLVED
2. Tests pass (\`queue-run test npm test\`)
3. Lint passes (\`queue-run lint npm run lint\`)
4. Build passes (\`queue-run build npm run build\`)

**IMPORTANT:** Use \`queue-run\` for all test/lint/build commands. This prevents resource contention when multiple agents run simultaneously.

**If you encounter obstacles:** Debug them. Read error messages carefully. Try different approaches.

## CORE PRINCIPLES

- **Simple is Better** - Don't over-engineer
- **Reuse Over Reinvent** - Extend existing code when /holistic finds it
- **Follow Established Patterns** - Use the examples /holistic shows you
- **Small Commits, Small Scope** - Do one thing well
- **PRs Target dev** - All PRs must target the \`dev\` branch, NOT \`main\`
- **Scope Guard** - If a change isn't required for this issue, create a follow-up issue:
  \`gh issue create --title "Follow-up: <description>" --body "..." --label "claude-review"\`

[... rest of the prompt ...]
`;
```

**Add to `buildBatchAgentPrompt()` function:**

```typescript
return `You are working on a BATCH of ${tickets.length} related GitHub issues.

These issues have been grouped together because they touch the same area of the codebase (${batch.area_key}).
Working on them together allows for a more efficient, cohesive implementation.

## Issues in This Batch
${issuesSection}

## Repository Info
- Owner: ${repoOwner}
- Repo: ${repoName}

## STEP 1: HOLISTIC ANALYSIS FOR BATCH (Run First!)

**CRITICAL:** Before planning implementation, run holistic analysis to find shared patterns:

\`\`\`bash
/holistic "Batch work for ${batch.area_key}: ${tickets.map(t => '#' + t.github_issue_number).join(', ')}"
\`\`\`

**This is ESPECIALLY important for batch work because:**
- Multiple issues may share common code/patterns
- You can implement shared functionality ONCE instead of ${tickets.length} times
- Existing code may already handle some of these issues
- You'll avoid creating duplicate/conflicting implementations

**What to look for:**
1. Shared functionality across all ${tickets.length} issues
2. Existing patterns that handle similar cases
3. Common dependencies (database, APIs, components)
4. Opportunities to create reusable utilities

## STEP 2: BATCH WORK STRATEGY

Based on holistic findings, plan a unified approach:

[... rest of batch prompt ...]
`;
```

### 3. Update Handoff Notes Template

Modify the handoff notes section to capture holistic analysis findings:

```markdown
## BEFORE YOU FINISH: Write Handoff Notes

**CRITICAL**: Before creating the PR, write a \`.claude-handoff.md\` file in the repo root with:

\`\`\`markdown
# Handoff Notes for Issue #${ticket.github_issue_number}

## Holistic Analysis Summary
- Existing patterns found: [List any code you extended/reused]
- New patterns created: [List any new code you had to create]
- Dependencies affected: [Cross-stack or cross-component impacts]

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
```

### 4. Test the Integration

Test with a simple issue first:

```bash
# In your orchestrator dashboard:
1. Create a test issue: "Add logging to user registration"
2. Add label "claude-ready"
3. Watch the agent in the dashboard
4. Verify it runs /holistic before implementing
5. Check the PR quality (should find existing logging patterns)
```

## Expected Workflow

### First Attempt Flow

```
1. Agent spawns for issue #123
2. Reads agent prompt
3. Runs: /holistic "Issue #123: Add email validation"
4. Reviews holistic findings:
   - Found existing validation utils
   - Found similar pattern in user registration
   - Should extend libs/validation.ts
5. Implements by extending existing code
6. Runs tests, creates PR
7. Review score: 93/100 (high quality due to consistency)
8. Auto-merged ✓
```

### Retry Flow (Skips Holistic)

```
1. Agent spawns for issue #123 attempt 2
2. Reads retry prompt (focused on fixing issues)
3. Skips /holistic (already done in first attempt)
4. Fixes specific review feedback
5. Pushes update
```

## Metrics to Track

Monitor these improvements after integration:

| Metric | Before /holistic | After /holistic | Target |
|--------|------------------|-----------------|--------|
| First PR score | 75-85 | 85-95 | >90 |
| Code duplication | High | Low | Minimal |
| Review feedback on patterns | Common | Rare | <10% |
| Auto-merge rate | 40% | 70% | >80% |
| Retry rate | 60% | 30% | <20% |

## Troubleshooting

### Issue: Agent skips /holistic step

**Cause:** Agent might not recognize it as a command

**Fix:** Ensure `.claude/commands/holistic.md` is in the target repo and properly formatted

### Issue: /holistic returns "no patterns found"

**Cause:** May be genuinely new functionality OR search needs improvement

**Fix:**
- Review the search patterns in the holistic command
- Check if the codebase has established patterns documented
- May be OK - some tasks are truly novel

### Issue: Agent finds patterns but doesn't use them

**Cause:** Prompt might not emphasize reuse strongly enough

**Fix:** Strengthen the "Reuse Over Reinvent" principle in core principles section

## Advanced: Specialized Holistic Queries

For different types of issues, you can customize the holistic query:

```typescript
// In prompts.ts
function getHolisticQuery(ticket: Ticket): string {
  // Detect issue type from labels or title
  const isBackend = ticket.labels.includes('backend') || ticket.title.includes('API');
  const isFrontend = ticket.labels.includes('frontend') || ticket.title.includes('UI');
  const isInfra = ticket.labels.includes('infrastructure') || ticket.title.includes('CDK');

  if (isInfra) {
    return `/holistic "CDK infrastructure change: ${ticket.title} - Check for construct ID stability and cross-stack impacts"`;
  } else if (isBackend) {
    return `/holistic "Backend change: ${ticket.title} - Find existing API patterns and Lambda handlers"`;
  } else if (isFrontend) {
    return `/holistic "Frontend change: ${ticket.title} - Find existing components and state management patterns"`;
  }

  return `/holistic "Issue #${ticket.github_issue_number}: ${ticket.title}"`;
}
```

## Summary

**Key Benefits:**
1. **Agents reuse code** instead of recreating it
2. **Higher first-attempt quality** (fewer retries)
3. **Consistent patterns** across all agent work
4. **Fewer breaking changes** (risks identified early)
5. **Better PR reviews** (follows established patterns)

**Integration Effort:**
- Copy 3 files to target repo (~5 minutes)
- Update 2 functions in prompts.ts (~15 minutes)
- Test with sample issue (~10 minutes)
- **Total: ~30 minutes**

**Expected ROI:**
- 20-30% reduction in retry rate
- 10-15 point increase in average first PR score
- 50%+ reduction in "duplicate code" review feedback
- More autonomous agents (less human intervention)
