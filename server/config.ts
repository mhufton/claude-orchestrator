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
      prWatch: parseInt(optionalEnv('PR_WATCH_INTERVAL', '15000'), 10),  // 15s for faster PR feedback
    },
  };
}
