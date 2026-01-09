/**
 * Lane detection for merge queue
 *
 * Lanes allow parallel merges for independent code areas.
 * Files that touch different parts of the codebase can merge concurrently.
 */

import * as github from '../github/client';

// Lane definitions - file path prefixes that belong to each lane
const LANE_PREFIXES: Record<string, string[]> = {
  frontend: ['web/', 'client/', 'src/components/', 'src/pages/'],
  backend: ['server/', 'api/'],
  infra: ['cdk/', 'terraform/', '.github/', 'docker/'],
  docs: ['docs/']
};

// File extension mappings for additional lane detection
const EXTENSION_LANES: Record<string, string> = {
  '.tsx': 'frontend',
  '.jsx': 'frontend',
  '.css': 'frontend',
  '.scss': 'frontend',
  '.md': 'docs'
};

/**
 * Simple pattern matching for file paths
 */
function matchesPattern(file: string, pattern: string): boolean {
  // Handle glob-style patterns
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return file.startsWith(prefix);
  }
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3);
    return file.includes(suffix) || file.endsWith(suffix);
  }
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return file.endsWith(ext);
  }
  // Direct prefix match
  return file.startsWith(pattern);
}

/**
 * Detect which lane a file belongs to
 */
function getLaneForFile(file: string): string {
  // Check prefix patterns first
  for (const [lane, prefixes] of Object.entries(LANE_PREFIXES)) {
    for (const prefix of prefixes) {
      if (file.startsWith(prefix)) {
        return lane;
      }
    }
  }

  // Check extension mappings
  for (const [ext, lane] of Object.entries(EXTENSION_LANES)) {
    if (file.endsWith(ext)) {
      return lane;
    }
  }

  return 'default';
}

/**
 * Detect which lane a PR belongs to based on changed files.
 * Returns 'default' if files span multiple areas or don't match any pattern.
 */
export function detectLaneFromFiles(changedFiles: string[]): string {
  if (changedFiles.length === 0) return 'default';

  const laneCounts: Record<string, number> = {};

  for (const file of changedFiles) {
    const lane = getLaneForFile(file);
    laneCounts[lane] = (laneCounts[lane] || 0) + 1;
  }

  // Find the lane with the most matches
  const entries = Object.entries(laneCounts);
  if (entries.length === 0) return 'default';

  // If multiple lanes have files, use 'default' to be safe (can't merge in parallel)
  const nonDefaultLanes = entries.filter(([lane]) => lane !== 'default');
  if (nonDefaultLanes.length > 1) {
    return 'default';
  }

  // If only one lane (excluding default), use that
  if (nonDefaultLanes.length === 1 && !laneCounts['default']) {
    return nonDefaultLanes[0][0];
  }

  // Default lane
  return 'default';
}

/**
 * Get changed files for a PR and detect its lane
 */
export async function detectLaneForPR(prNumber: number): Promise<string> {
  try {
    const files = await github.getPRFiles(prNumber);
    return detectLaneFromFiles(files.map((f: { filename: string }) => f.filename));
  } catch (err) {
    console.warn(`[lanes] Failed to get files for PR #${prNumber}:`, err);
    return 'default';
  }
}

/**
 * Get all configured lanes
 */
export function getConfiguredLanes(): string[] {
  return ['default', ...Object.keys(LANE_PREFIXES)];
}
