# /holistic Quick Start for Orchestrator

> **TL;DR**: Add `/holistic` to agent prompts → Agents find existing patterns → Higher quality PRs → Fewer retries → More auto-merges

## 5-Minute Setup

### 1. Copy Files to Target Repo

```bash
cd /path/to/your/target/repo

# Create directories
mkdir -p .claude/commands .claude/checklists

# Copy holistic command (required)
cp /Users/mikeh/raw/.claude/commands/holistic.md .claude/commands/

# Copy checklist (required)
cp /Users/mikeh/raw/.claude/checklists/impact-analysis.md .claude/checklists/

# Commit
git add .claude/
git commit -m "Add holistic analysis for agents"
git push origin dev
```

### 2. Update Agent Prompt

In `orchestrator/server/agents/prompts.ts`, add BEFORE implementation step:

```typescript
const basePrompt = `You are working on GitHub issue #${ticket.github_issue_number}

## Issue Title
${ticket.title}

## Issue Description
${ticket.body || 'No description provided.'}

## STEP 0: HOLISTIC ANALYSIS (CRITICAL - Run First!)

Before implementing ANYTHING, understand what already exists:

\`/holistic "Issue #${ticket.github_issue_number}: ${ticket.title}"\`

This finds:
✅ Existing code you can reuse (DON'T REINVENT THE WHEEL)
✅ Patterns to follow (BE CONSISTENT)
✅ Dependencies that will be affected (AVOID BREAKING CHANGES)
✅ Risks to watch out for (PREVENT ISSUES)

**Act on the findings:**
- If holistic finds similar code → EXTEND IT (don't recreate)
- If holistic shows patterns → FOLLOW THEM (don't invent new)
- If holistic identifies risks → ADDRESS THEM (don't ignore)

## STEP 1: IMPLEMENTATION

[... rest of your existing prompt ...]
`;
```

### 3. Test It

```bash
# Create test issue
gh issue create --title "Test: Add logging to API endpoint" --label "claude-ready"

# Watch agent in dashboard
# Should see: Agent runs /holistic → Finds existing logger → Uses it
```

## What Changes

### Before /holistic
```
Agent: "I'll create a new email notification system..."
[200 lines of duplicate code]
Review: "We already have EmailService. Score: 72/100"
→ Retry required
```

### After /holistic
```
Agent: "/holistic finds existing EmailService at server/notifications/"
Agent: "I'll extend EmailService.sendPaymentFailure()..."
[30 lines extending existing code]
Review: "Follows existing patterns perfectly. Score: 94/100"
→ Auto-merged ✓
```

## Expected Improvements

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| First PR score | 75 | 90 | >90 |
| Retry rate | 60% | 20% | <20% |
| Auto-merge rate | 40% | 80% | >80% |
| Duplicate code | High | Low | Minimal |

## Debugging

**Agent skips /holistic:**
- Check `.claude/commands/holistic.md` exists in target repo
- Verify it's in the agent prompt before implementation

**Holistic finds nothing:**
- May be genuinely new (OK!)
- Or search needs tuning (check holistic.md patterns)

**Agent ignores findings:**
- Strengthen "Reuse Over Reinvent" in core principles
- Make extension vs creation more explicit in prompt

## Full Documentation

- **Setup Guide**: `docs/holistic-integration.md`
- **Workflow Example**: `docs/holistic-workflow-example.md`
- **Source Files**: `/Users/mikeh/raw/.claude/`

## Support

Questions? Check the workflow example showing a complete agent session with holistic analysis.

---

**Bottom Line**: 5 minutes of setup → 50%+ reduction in retries → More autonomous agents
