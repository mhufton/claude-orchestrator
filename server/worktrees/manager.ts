import { $ } from 'bun';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';

let repoPath: string;
let worktreeDir: string;

export function initWorktreeManager(mainRepoPath: string, worktreeDirPath: string): void {
  repoPath = resolve(mainRepoPath);
  worktreeDir = resolve(worktreeDirPath);

  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }
}

export function getWorktreePath(slot: number): string {
  return join(worktreeDir, `slot-${slot}`);
}

export async function createWorktree(slot: number, branchName: string): Promise<void> {
  const worktreePath = getWorktreePath(slot);

  // If worktree already exists, reset it instead of recreating (preserves node_modules)
  if (existsSync(worktreePath)) {
    await resetWorktree(slot, branchName);
    return;
  }

  // Fetch latest from origin (dev is our working branch, PRs target dev)
  await $`git -C ${repoPath} fetch origin dev`.quiet();

  // Create branch from latest dev
  try {
    await $`git -C ${repoPath} branch ${branchName} origin/dev`.quiet();
  } catch {
    // Branch might already exist, try to reset it to latest dev
    await $`git -C ${repoPath} branch -f ${branchName} origin/dev`.quiet();
  }

  // Create worktree
  await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();

  console.log(`Created worktree at ${worktreePath} on branch ${branchName}`);
}

/**
 * Reset an existing worktree to start a new branch.
 * Assumes worktree was already cleaned up by cleanupWorktree on slot release.
 * Just creates the new branch from latest dev.
 */
export async function resetWorktree(slot: number, branchName: string): Promise<void> {
  const worktreePath = getWorktreePath(slot);

  if (!existsSync(worktreePath)) {
    // Worktree doesn't exist, create it fresh
    await $`git -C ${repoPath} fetch origin dev`.quiet();
    try {
      await $`git -C ${repoPath} branch ${branchName} origin/dev`.quiet();
    } catch {
      await $`git -C ${repoPath} branch -f ${branchName} origin/dev`.quiet();
    }
    await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();
    console.log(`Created worktree at ${worktreePath} on branch ${branchName}`);
    return;
  }

  // Fetch latest dev
  await $`git -C ${worktreePath} fetch origin dev`.quiet();

  // Create/reset branch to latest dev and switch to it
  // Worktree should already be clean from releaseSlot, but reset --hard as safety
  await $`git -C ${worktreePath} reset --hard`.quiet();
  await $`git -C ${worktreePath} checkout -B ${branchName} origin/dev`.quiet();

  console.log(`Started branch ${branchName} in worktree at ${worktreePath}`);
}

/**
 * Clean up a worktree after a ticket finishes.
 * Resets to dev, cleans untracked files, but preserves node_modules.
 * This leaves the worktree in a clean state ready for the next ticket.
 */
export async function cleanupWorktree(slot: number): Promise<void> {
  const worktreePath = getWorktreePath(slot);

  if (!existsSync(worktreePath)) {
    return; // Nothing to clean
  }

  // Fetch latest dev
  await $`git -C ${worktreePath} fetch origin dev`.quiet();

  // Abort any in-progress operations
  try {
    await $`git -C ${worktreePath} rebase --abort`.quiet();
  } catch { /* no rebase in progress */ }
  try {
    await $`git -C ${worktreePath} merge --abort`.quiet();
  } catch { /* no merge in progress */ }
  try {
    await $`git -C ${worktreePath} cherry-pick --abort`.quiet();
  } catch { /* no cherry-pick in progress */ }

  // Reset any staged/unstaged changes
  await $`git -C ${worktreePath} reset --hard`.quiet();

  // Clean untracked files but KEEP node_modules
  await $`git -C ${worktreePath} clean -fd -e node_modules -e .claude-handoff.md`.quiet();

  // Checkout dev so worktree is on a clean base branch
  await $`git -C ${worktreePath} checkout origin/dev`.quiet();

  console.log(`Cleaned up worktree at ${worktreePath} (on dev, node_modules preserved)`);
}

export async function removeWorktree(slot: number): Promise<void> {
  const worktreePath = getWorktreePath(slot);

  if (!existsSync(worktreePath)) {
    return;
  }

  try {
    // Remove worktree from git
    await $`git -C ${repoPath} worktree remove ${worktreePath} --force`.quiet();
  } catch (error) {
    console.warn(`Failed to remove worktree via git, cleaning up manually:`, error);
    // Force remove directory if git command fails
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Prune worktree records
  await $`git -C ${repoPath} worktree prune`.quiet();

  console.log(`Removed worktree at ${worktreePath}`);
}

export async function cleanupAllWorktrees(): Promise<void> {
  for (let slot = 1; slot <= 3; slot++) {
    try {
      await removeWorktree(slot);
    } catch (error) {
      console.warn(`Failed to cleanup slot ${slot}:`, error);
    }
  }
}

export async function pushWorktreeBranch(slot: number, branchName: string): Promise<void> {
  const worktreePath = getWorktreePath(slot);

  // Push with upstream tracking
  await $`git -C ${worktreePath} push -u origin ${branchName}`.quiet();

  console.log(`Pushed branch ${branchName} to origin`);
}

export async function getWorktreeStatus(slot: number): Promise<{
  exists: boolean;
  branch: string | null;
  hasChanges: boolean;
}> {
  const worktreePath = getWorktreePath(slot);

  if (!existsSync(worktreePath)) {
    return { exists: false, branch: null, hasChanges: false };
  }

  try {
    const branchResult = await $`git -C ${worktreePath} branch --show-current`.quiet();
    const branch = branchResult.text().trim();

    const statusResult = await $`git -C ${worktreePath} status --porcelain`.quiet();
    const hasChanges = statusResult.text().trim().length > 0;

    return { exists: true, branch, hasChanges };
  } catch {
    return { exists: true, branch: null, hasChanges: false };
  }
}
