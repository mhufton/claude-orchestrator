/**
 * The single definition of "what is stopping this PR from merging".
 *
 * Both watchers (single-ticket and batch) ask this module, so the rules — CI, the
 * check-stability window, the score gate, unreplied comments, and evidence-based
 * thread resolution — cannot drift between the two paths. Callers own the state
 * side effects (DB writes, respawns, queueing); this module owns the rules.
 */

import * as github from './client';
import { parseReviewScore } from './score-parser';
import { resolveAddressedThreads, type ThreadResolutionResult } from './thread-resolver';
import { SCORE_THRESHOLD } from '../config';
import type { ReviewScore } from './score-parser';

// New checks can still be created just after the last one finishes; merging inside
// that window merges a PR whose CI is not actually complete.
export const MIN_CHECK_STABILITY_MS = 30000;

export type CIStatusLabel = 'running' | 'passing' | 'failing' | 'unknown';

export interface CheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export type MergeBlockerReport =
  /** CI status could not be read — do nothing this pass. */
  | { status: 'ci_unknown'; reason: string; checks: CheckSummary[] }
  /** Checks still running. */
  | { status: 'ci_pending'; reason: string; checks: CheckSummary[] }
  /** Checks finished too recently to trust. */
  | { status: 'ci_unstable'; reason: string; checks: CheckSummary[] }
  /** Rules applied. `issues` empty means nothing blocks the merge. */
  | {
      status: 'evaluated';
      issues: string[];
      hasCIFailures: boolean;
      hasBlockingComments: boolean;
      ciFailureNames: string[];
      score: ReviewScore | null;
      threadOutcome: ThreadResolutionResult;
      checks: CheckSummary[];
    };

/**
 * Apply every merge-blocking rule to one PR, resolving the review threads the
 * evidence backs on the way through.
 */
export async function evaluateMergeBlockers(prNumber: number, headSha: string): Promise<MergeBlockerReport> {
  let checkStatus;
  try {
    checkStatus = await github.getCheckStatus(headSha);
  } catch (error) {
    console.warn('Could not fetch check status:', error instanceof Error ? error.message : error);
    return { status: 'ci_unknown', reason: 'Cannot verify CI status - waiting', checks: [] };
  }

  const checks = checkStatus.checks || [];

  if (checkStatus.pending) {
    return { status: 'ci_pending', reason: 'CI checks pending', checks };
  }

  if (checkStatus.checksCompletedAt) {
    const sinceCompletion = Date.now() - checkStatus.checksCompletedAt.getTime();
    if (sinceCompletion < MIN_CHECK_STABILITY_MS) {
      const remainingSec = Math.round((MIN_CHECK_STABILITY_MS - sinceCompletion) / 1000);
      return {
        status: 'ci_unstable',
        reason: `Waiting for check stability (${remainingSec}s remaining)`,
        checks,
      };
    }
  }

  const issues: string[] = [];

  const hasCIFailures = !checkStatus.allPassed;
  const ciFailureNames = checkStatus.failures.map(f => f.name);
  if (hasCIFailures) {
    issues.push(`CI failures: ${ciFailureNames.join(', ')}`);
  }

  const score = await parseReviewScore(prNumber);
  const unrepliedComments = await github.getUnrepliedBotComments(prNumber);

  // Resolve server-side, on evidence, BEFORE counting what still blocks. The agent
  // following prose instructions was the only thing closing threads, and it does not
  // do it reliably; an unclosed thread is a permanent 405 under
  // `required_conversation_resolution`. Nothing is resolved without a reply from us
  // AND a post-review commit touching the file — see thread-resolver.ts.
  const threadOutcome = await resolveAddressedThreads(prNumber);
  const unresolvedThreads = threadOutcome.stillOpen;

  if (score && score.total < SCORE_THRESHOLD) {
    issues.push(`Review score ${score.total}/100 (needs >= ${SCORE_THRESHOLD})`);
  }

  // Open review threads ALWAYS block, at any score. A high score does not mean the
  // reviewer judged them unimportant — 2026-09-18 saw real defects sitting in open
  // threads at 95, 97 and 99, including a README asserting a property the code did
  // not have.
  //
  // Two DIFFERENT questions, both asked, because branch protection asks the second:
  //   unreplied  — a bot comment nobody answered (REST; misses human threads).
  //   unresolved — a thread nobody marked resolved (GraphQL). This is what
  //                `required_conversation_resolution` actually gates on, and a
  //                thread stays unresolved after a reply AND after the code under
  //                it changes. Merging with one open returns 405, so a PR that
  //                looks ready on replies alone stalls the queue forever.
  let hasBlockingComments = false;

  if (unrepliedComments.length > 0) {
    hasBlockingComments = true;
    issues.push(`${unrepliedComments.length} unreplied review comments`);
  }

  if (unresolvedThreads.length > 0) {
    hasBlockingComments = true;
    const outdated = unresolvedThreads.filter(t => t.isOutdated).length;
    const unbacked = threadOutcome.unbackedClaims.length;
    const unverifiable = threadOutcome.unverifiable.length;
    issues.push(
      `${unresolvedThreads.length} unresolved review threads` +
        (outdated > 0 ? ` (${outdated} outdated — resolving still required)` : '') +
        (unbacked > 0 ? ` (${unbacked} claimed addressed with no post-review commit touching the file)` : '') +
        (unverifiable > 0 ? ` (${unverifiable} unverifiable)` : ''),
    );
  }

  return {
    status: 'evaluated',
    issues,
    hasCIFailures,
    hasBlockingComments,
    ciFailureNames,
    score,
    threadOutcome,
    checks,
  };
}
