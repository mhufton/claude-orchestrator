import { $ } from 'bun';
import { existsSync } from 'fs';
import { getWorktreePath } from './manager';
import { spawn } from 'bun';

export interface WorktreeState {
  slot: number;
  path: string;
  exists: boolean;
  branch: string | null;
  isClean: boolean;
  isMidRebase: boolean;
  isMidMerge: boolean;
  isMidCherryPick: boolean;
  hasConflictMarkers: boolean;
  conflictFiles: string[];
  uncommittedChanges: string[];
  behindDev: number;
  aheadOfDev: number;
  lastCommit: string | null;
}

/**
 * Diagnose the state of a worktree to detect stuck/problematic states
 */
export async function diagnoseWorktree(slot: number): Promise<WorktreeState> {
  const path = getWorktreePath(slot);

  const state: WorktreeState = {
    slot,
    path,
    exists: existsSync(path),
    branch: null,
    isClean: true,
    isMidRebase: false,
    isMidMerge: false,
    isMidCherryPick: false,
    hasConflictMarkers: false,
    conflictFiles: [],
    uncommittedChanges: [],
    behindDev: 0,
    aheadOfDev: 0,
    lastCommit: null
  };

  if (!state.exists) {
    return state;
  }

  try {
    // Get current branch
    const branchResult = await $`git -C ${path} branch --show-current`.quiet();
    state.branch = branchResult.text().trim() || null;

    // Check for mid-rebase
    state.isMidRebase = existsSync(`${path}/.git/rebase-merge`) ||
                        existsSync(`${path}/.git/rebase-apply`);

    // Check for mid-merge
    state.isMidMerge = existsSync(`${path}/.git/MERGE_HEAD`);

    // Check for mid-cherry-pick
    state.isMidCherryPick = existsSync(`${path}/.git/CHERRY_PICK_HEAD`);

    // Get uncommitted changes
    const statusResult = await $`git -C ${path} status --porcelain`.quiet();
    const statusLines = statusResult.text().trim().split('\n').filter(l => l);
    state.uncommittedChanges = statusLines;
    state.isClean = statusLines.length === 0;

    // Check for conflict markers in tracked files
    try {
      const conflictCheck = await $`git -C ${path} grep -l "^<<<<<<< " -- ":(exclude)*.lock"`.quiet();
      const conflictFiles = conflictCheck.text().trim().split('\n').filter(f => f);
      if (conflictFiles.length > 0) {
        state.hasConflictMarkers = true;
        state.conflictFiles = conflictFiles;
      }
    } catch {
      // No conflict markers found (grep returns non-zero)
    }

    // Check how far behind/ahead of dev
    try {
      await $`git -C ${path} fetch origin dev`.quiet();

      const behindResult = await $`git -C ${path} rev-list --count HEAD..origin/dev`.quiet();
      state.behindDev = parseInt(behindResult.text().trim()) || 0;

      const aheadResult = await $`git -C ${path} rev-list --count origin/dev..HEAD`.quiet();
      state.aheadOfDev = parseInt(aheadResult.text().trim()) || 0;
    } catch {
      // Can't determine ahead/behind
    }

    // Get last commit message
    try {
      const logResult = await $`git -C ${path} log -1 --oneline`.quiet();
      state.lastCommit = logResult.text().trim();
    } catch {
      // No commits
    }

  } catch (error) {
    console.error(`Error diagnosing worktree at ${path}:`, error);
  }

  return state;
}

/**
 * Check if a worktree is in a stuck state that needs recovery
 */
export function isStuck(state: WorktreeState): boolean {
  return state.isMidRebase ||
         state.isMidMerge ||
         state.isMidCherryPick ||
         state.hasConflictMarkers;
}

/**
 * Build a recovery prompt for Opus to analyze and fix the stuck state
 */
function buildRecoveryPrompt(state: WorktreeState, ticketTitle: string, issueNumber: number): string {
  const stuckReasons: string[] = [];

  if (state.isMidRebase) stuckReasons.push('Mid-rebase (rebase was started but not completed)');
  if (state.isMidMerge) stuckReasons.push('Mid-merge (merge was started but not completed)');
  if (state.isMidCherryPick) stuckReasons.push('Mid-cherry-pick (cherry-pick was started but not completed)');
  if (state.hasConflictMarkers) stuckReasons.push(`Unresolved conflict markers in: ${state.conflictFiles.join(', ')}`);

  return `You are recovering a stuck git worktree for issue #${issueNumber}: ${ticketTitle}

## Current State

**Branch:** ${state.branch || 'unknown'}
**Working Directory:** ${state.path}
**Behind dev:** ${state.behindDev} commits
**Ahead of dev:** ${state.aheadOfDev} commits
**Last Commit:** ${state.lastCommit || 'none'}

## Problems Detected

${stuckReasons.map(r => `- ${r}`).join('\n')}

${state.uncommittedChanges.length > 0 ? `
## Uncommitted Changes
\`\`\`
${state.uncommittedChanges.join('\n')}
\`\`\`
` : ''}

## Your Task

**CRITICAL: You must recover this worktree to a working state.**

### Step 1: Assess the Situation
Run these commands to understand what's happening:
\`\`\`bash
git status
git log --oneline -5
git diff HEAD
\`\`\`

### Step 2: Choose Recovery Strategy

**Option A: Complete the in-progress operation** (if changes are valuable)
- If mid-rebase: resolve conflicts, \`git add .\`, \`git rebase --continue\`
- If mid-merge: resolve conflicts, \`git add .\`, \`git commit\`
- Ensure NO conflict markers remain: \`git grep "^<<<<<<< "\`

**Option B: Abort and retry clean** (if state is too messy)
- \`git rebase --abort\` or \`git merge --abort\`
- \`git checkout -- .\` to discard local changes
- \`git clean -fd\` to remove untracked files
- Then start fresh: \`git fetch origin dev && git rebase origin/dev\`

**Option C: Hard reset** (last resort - loses uncommitted work)
- Save any important changes first (copy files if needed)
- \`git fetch origin dev\`
- \`git reset --hard origin/dev\`
- Re-apply changes manually if needed

### Step 3: Verify Recovery
After recovery, verify:
1. \`git status\` shows clean state (no conflicts)
2. \`git grep "^<<<<<<< "\` returns nothing (no conflict markers)
3. \`npm test\` passes
4. \`npm run lint\` passes
5. \`npm run build\` passes

### Step 4: Continue Original Work
Once recovered, continue working on the original issue:
- Issue #${issueNumber}: ${ticketTitle}
- Make your changes
- Commit, push, create PR targeting \`dev\`

## Important Notes

- PRs must target \`dev\` branch, NOT \`main\`
- Always verify no conflict markers before committing
- Run tests/lint/build before pushing
- NEVER leave conflict markers in committed code
`;
}

/**
 * Run Opus-powered recovery for a stuck worktree
 */
export async function runRecovery(
  slot: number,
  ticketId: number,
  ticketTitle: string,
  issueNumber: number,
  onOutput?: (chunk: string) => void
): Promise<{ success: boolean; output: string }> {
  const state = await diagnoseWorktree(slot);

  if (!state.exists) {
    return { success: false, output: 'Worktree does not exist' };
  }

  if (!isStuck(state)) {
    return { success: true, output: 'Worktree is not stuck - no recovery needed' };
  }

  console.log(`[recovery] Starting Opus-powered recovery for slot ${slot}`);
  console.log(`[recovery] Stuck state:`, {
    isMidRebase: state.isMidRebase,
    isMidMerge: state.isMidMerge,
    hasConflictMarkers: state.hasConflictMarkers,
    conflictFiles: state.conflictFiles
  });

  const prompt = buildRecoveryPrompt(state, ticketTitle, issueNumber);

  const proc = spawn([
    'claude',
    '-p', prompt,
    '--model', 'sonnet',  // Sonnet handles git recovery fine, Opus overkill
    '--output-format', 'text',
    '--max-turns', '30',  // Allow more turns for complex recovery
    '--dangerously-skip-permissions'
  ], {
    cwd: state.path,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PWD: state.path
    }
  });

  let output = '';
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      output += chunk;
      if (onOutput) onOutput(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const exitCode = await proc.exited;

  // Verify recovery was successful
  const postState = await diagnoseWorktree(slot);
  const recovered = !isStuck(postState);

  console.log(`[recovery] Recovery ${recovered ? 'succeeded' : 'failed'} for slot ${slot}`);

  return {
    success: recovered && exitCode === 0,
    output
  };
}

/**
 * Force reset a worktree to clean state from dev
 * Use as last resort when recovery fails
 */
export async function forceResetWorktree(slot: number): Promise<boolean> {
  const path = getWorktreePath(slot);

  if (!existsSync(path)) {
    return false;
  }

  try {
    console.log(`[recovery] Force resetting worktree at ${path}`);

    // Abort any in-progress operations
    try { await $`git -C ${path} rebase --abort`.quiet(); } catch {}
    try { await $`git -C ${path} merge --abort`.quiet(); } catch {}
    try { await $`git -C ${path} cherry-pick --abort`.quiet(); } catch {}

    // Discard all changes
    await $`git -C ${path} checkout -- .`.quiet();
    await $`git -C ${path} clean -fd`.quiet();

    // Fetch and reset to dev
    await $`git -C ${path} fetch origin dev`.quiet();
    await $`git -C ${path} reset --hard origin/dev`.quiet();

    console.log(`[recovery] Force reset complete for slot ${slot}`);
    return true;
  } catch (error) {
    console.error(`[recovery] Force reset failed for slot ${slot}:`, error);
    return false;
  }
}
