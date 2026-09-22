import { dirname, join } from 'path';
import type { RouterMode } from './state/types';

// PRs target main; the dev branch was retired with the single-branch pipeline.
export const BASE_BRANCH = process.env.BASE_BRANCH || 'main';

export interface Config {
  github: {
    token: string;
    owner: string;
    repo: string;
    claudeReadyLabel: string;
  };
  server: {
    port: number;
  };
  paths: {
    repoPath: string;
    worktreeDir: string;
  };
  intervals: {
    issueSync: number;
    prWatch: number;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function loadConfig(): Config {
  return {
    github: {
      token: requireEnv('GITHUB_TOKEN'),
      owner: requireEnv('GITHUB_OWNER'),
      repo: requireEnv('GITHUB_REPO'),
      claudeReadyLabel: optionalEnv('CLAUDE_READY_LABEL', 'claude-ready'),
    },
    server: {
      port: parseInt(optionalEnv('PORT', '3456'), 10),
    },
    paths: {
      repoPath: requireEnv('REPO_PATH'),
      worktreeDir: optionalEnv('WORKTREE_DIR', './worktrees'),
    },
    intervals: {
      issueSync: parseInt(optionalEnv('ISSUE_SYNC_INTERVAL', '60000'), 10),
      prWatch: parseInt(optionalEnv('PR_WATCH_INTERVAL', '30000'), 10),  // 30s for PR checks
    },
  };
}

// Review-bot score gate. Lives here, not in pr-watcher, so the agent prompt can
// state the real bar without importing the watcher (prompts <- spawner <- watcher).
export const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD || '98', 10);

// Auto-attempts before a ticket is parked for a human. Read by pr-watcher (circuit
// breaker) and spawner (self-heal) — two copies of this cap can silently disagree.
export const MAX_AUTO_ATTEMPTS = parseInt(process.env.MAX_AUTO_ATTEMPTS || '3', 10);

// Model per retry attempt (index = attempt_count - 1). A retry re-runs the same
// ticket with more capability rather than the same model that already failed it.
// Shorter than MAX_AUTO_ATTEMPTS on purpose — spawner clamps to the last rung.
export const MODEL_ESCALATION_LADDER: readonly ('opus' | 'sonnet')[] = ['sonnet', 'opus'];

// Hard turn cap for implementation agent spawns (spawner.ts), unbounded before this.
// 331 historical `result` rows top out at 198 turns (p95 120, p99 184) — 250 clears
// the observed tail with headroom without leaving a runaway fan-out unbounded.
export const MAX_IMPLEMENTATION_TURNS = parseInt(process.env.MAX_IMPLEMENTATION_TURNS || '250', 10);

// bun:sqlite resolves a relative path against process.cwd(), so launching the server
// from any other directory than the repo root silently opens/creates a different,
// empty database (see the zero-byte server/orchestrator.db fossil this replaces).
// import.meta.dir is server/, so the repo root is one level up.
export const DB_PATH: string =
  process.env.ORCHESTRATOR_DB || join(dirname(import.meta.dir), 'orchestrator.db');

// Kill switch for the dispatch router (agents/router.ts). 'shadow' runs decide() and
// records its output on every dispatch without changing what gets spawned — the diff
// between shadow decisions and actual outcomes is the evidence 'enforce' needs before
// it gates anything for real. Defaults to shadow, not off, so that evidence accrues
// from the moment this ships.
export const ROUTER_MODE: RouterMode = (() => {
  const raw = process.env.ROUTER_MODE;
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return 'shadow';
})();

// Absolute path required: Bun.spawn throws ENOENT rather than falling back to PATH,
// and a dangling path fails silently (see the /opt/homebrew hardcode this replaces).
export const CLAUDE_BIN: string = (() => {
  const candidates = [
    process.env.CLAUDE_BIN,
    Bun.which('claude'),
    `${process.env.HOME}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    try {
      if (Bun.spawnSync([path, '--version']).success) return path;
    } catch {
      // next candidate
    }
  }
  throw new Error(
    `Could not find a working \`claude\` binary. Tried: ${candidates.join(', ')}. Set CLAUDE_BIN.`
  );
})();
