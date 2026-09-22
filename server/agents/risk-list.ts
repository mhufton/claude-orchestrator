import { join } from 'path';

/**
 * The risk-path list belongs to the target repo, not the orchestrator — see
 * router.ts R2. This module only reads and matches it; creating
 * `.claude/risk-paths.yaml` in a target repo is a separate change.
 *
 * Expected shape:
 *   paths:
 *     - glob: "apps/lambda-handlers/payment-api/**"
 *       tier: blast
 *     - glob: "apps/cdk-infrastructure/**"
 *       tier: blast
 */
export interface RiskPathEntry {
  glob: string;
  tier: string;
}

export interface RiskListResult {
  entries: RiskPathEntry[];
  /** Git blob sha of the file as read, so a decision row can be traced back to the
   * exact list version that produced it. Null when the file doesn't exist. */
  sha: string | null;
  /** The file exists but couldn't be parsed — distinct from "not adopted yet" so
   * router.ts can apply a confidence penalty rather than silently reading zero hits. */
  degraded: boolean;
}

const EMPTY: RiskListResult = { entries: [], sha: null, degraded: false };

function isRiskPathEntry(value: unknown): value is RiskPathEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.glob === 'string' && typeof obj.tier === 'string';
}

/**
 * Read `.claude/risk-paths.yaml` from a worktree. A missing or unparsable file is
 * "no hits" per the spec, never a throw — decide() must fail open, not on a target
 * repo that simply hasn't adopted the list yet.
 */
export async function loadRiskList(worktreePath: string): Promise<RiskListResult> {
  const path = join(worktreePath, '.claude', 'risk-paths.yaml');
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return EMPTY;
  }

  let entries: RiskPathEntry[] = [];
  try {
    const text = await file.text();
    const parsed = Bun.YAML.parse(text) as { paths?: unknown } | null;
    if (parsed && Array.isArray(parsed.paths)) {
      entries = parsed.paths.filter(isRiskPathEntry);
    }
  } catch (error) {
    console.warn(`[risk-list] Could not parse ${path}:`, error instanceof Error ? error.message : error);
    const sha = await readBlobSha(worktreePath);
    return { entries: [], sha, degraded: true };
  }

  const sha = await readBlobSha(worktreePath);
  return { entries, sha, degraded: false };
}

async function readBlobSha(worktreePath: string): Promise<string | null> {
  try {
    const { $ } = await import('bun');
    const result = await $`git rev-parse HEAD:.claude/risk-paths.yaml`.cwd(worktreePath).quiet();
    return result.text().trim() || null;
  } catch {
    return null;
  }
}

/** `*` matches within one path segment; `**` matches across segments, including none. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\*\*|\*|[.^$+?()[\]{}|\\]/g, (token) => {
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return `\\${token}`;
  });

  return new RegExp(`^${pattern}$`);
}

/**
 * Which risk-list entries match a candidate path, at the given tier.
 * Only 'blast' tier feeds R2 — other tiers are recorded in features but do not gate.
 */
export function matchRiskPaths(entries: RiskPathEntry[], candidatePaths: string[], tier: string): RiskPathEntry[] {
  const hits: RiskPathEntry[] = [];
  for (const entry of entries) {
    if (entry.tier !== tier) continue;
    const re = globToRegExp(entry.glob);
    if (candidatePaths.some(p => re.test(p))) {
      hits.push(entry);
    }
  }
  return hits;
}

/**
 * File-path-shaped tokens mentioned in free text (issue title/body): backtick-quoted
 * paths, and bare paths with a '/' and a file extension. This is the only source of
 * "what this ticket touches" available before any code has been written — decide()
 * cannot diff a PR that doesn't exist yet.
 */
export function extractCandidatePaths(text: string | null): string[] {
  if (!text) return [];
  const paths = new Set<string>();

  for (const match of text.matchAll(/`([^`\s]+\/[^`\s]+\.[a-zA-Z0-9]+)`/g)) {
    paths.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![`\w])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+)(?![`\w])/g)) {
    paths.add(match[1]);
  }

  return [...paths];
}
