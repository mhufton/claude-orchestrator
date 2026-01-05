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

  // Remove existing worktree if present
  if (existsSync(worktreePath)) {
    await removeWorktree(slot);
  }

  // Fetch latest from origin (dev is our working branch, PRs target dev)
  await $`git -C ${repoPath} fetch origin dev`.quiet();

  // Create branch from latest dev
  try {
    // Try to create the branch
    await $`git -C ${repoPath} branch ${branchName} origin/dev`.quiet();
  } catch {
    // Branch might already exist, try to reset it to latest dev
    await $`git -C ${repoPath} branch -f ${branchName} origin/dev`.quiet();
  }

  // Create worktree
  await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();

  console.log(`Created worktree at ${worktreePath} on branch ${branchName}`);
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
