/**
 * Server-side resolution of PR review threads, on evidence only.
 *
 * `required_conversation_resolution` gates the merge on RESOLUTION, not on replies,
 * so an unattended run that only ever replies dead-ends on a 405 forever. Resolving
 * from the server (rather than hoping the spawned agent follows prose) is the only
 * way that loop closes.
 *
 * "On evidence" is the load-bearing half. A thread is resolved only when the agent
 * replied AND a commit dated at or after the LAST reviewer comment in that thread
 * touched the file the thread sits on. Work that landed before the review cannot be
 * evidence that the review's finding was addressed, and "the PR diff contains this
 * path" proves nothing at all — a review thread's path is in the PR diff by
 * construction. Anything unverifiable stays open: this gate fails closed.
 */

import * as github from './client';
import type { ThreadDecision } from '../state/types';

export type { ThreadDecision };

export interface ThreadVerdict {
  threadId: string;
  path: string | null;
  line: number | null;
  isOutdated: boolean;
  firstComment: string;
  lastAuthor: string;
  /** Last word in the thread is ours, i.e. the agent answered it. */
  agentReplied: boolean;
  /** A commit at or after the last reviewer comment touched this thread's file. */
  codeChangedAfterReview: boolean;
  /** Timestamp the evidence window starts from (last reviewer comment). */
  reviewCommentAt: string | null;
  /** Commits found inside that window. */
  commitsSinceReview: number;
  decision: ThreadDecision;
  reason: string;
  /** REST comment ids in this thread, for joining against pulls.listReviewComments. */
  commentIds: number[];
}

export interface ThreadResolutionResult {
  verdicts: ThreadVerdict[];
  /** Threads this pass actually resolved. */
  resolved: ThreadVerdict[];
  /** Threads still blocking the merge afterwards. */
  stillOpen: ThreadVerdict[];
  /** Agent said "fixed" but no post-review commit touches the file — named back at it on retry. */
  unbackedClaims: ThreadVerdict[];
  /** Evidence could not be read; never resolved, always reported. */
  unverifiable: ThreadVerdict[];
}

// A thread whose last comment is one of these is waiting on us, not on the reviewer.
const REVIEW_BOT_LOGINS = ['github-actions[bot]', 'github-actions', 'claude[bot]', 'claude-bot'];

function isOurs(login: string, selfLogin: string | null): boolean {
  if (selfLogin) return login.toLowerCase() === selfLogin.toLowerCase();
  // Degraded mode (getAuthenticated failed): anyone who is not a known review bot is
  // taken as our side of the conversation. Still requires post-review commits to resolve.
  const lower = login.toLowerCase();
  return lower !== 'unknown' && !REVIEW_BOT_LOGINS.includes(lower) && !lower.endsWith('[bot]');
}

/**
 * When the reviewer last spoke in this thread. The LAST one, not the first: a thread
 * gets re-raised across review rounds, and the old round's timestamp would accept work
 * that predates the current complaint.
 */
function lastReviewCommentAt(thread: github.UnresolvedThread, selfLogin: string | null): string | null {
  for (let i = thread.comments.length - 1; i >= 0; i--) {
    const c = thread.comments[i];
    if (!isOurs(c.author, selfLogin)) return c.createdAt;
  }
  return thread.comments[0]?.createdAt ?? null;
}

/** Union of files touched by commits in the evidence window, or null if unreadable. */
type CommitEvidence = (since: string) => Promise<{ files: Set<string>; commitCount: number } | null>;

function buildEvidenceReader(commits: github.PRCommit[] | null): CommitEvidence {
  const fileCache = new Map<string, string[]>();

  return async (since: string) => {
    if (!commits) return null;

    const sinceMs = Date.parse(since);
    // `>=`: committer clocks are not reliable to the second, so a commit stamped
    // exactly at the comment counts as after it.
    const inWindow = commits.filter(c => c.date !== null && Date.parse(c.date) >= sinceMs);

    const files = new Set<string>();
    for (const commit of inWindow) {
      let commitFiles = fileCache.get(commit.sha);
      if (!commitFiles) {
        try {
          commitFiles = await github.getCommitFiles(commit.sha);
        } catch (error) {
          console.warn(`[thread-resolver] Could not read files for ${commit.sha.slice(0, 7)}:`, error instanceof Error ? error.message : error);
          return null;  // fail closed — a transient error must never resolve a thread
        }
        fileCache.set(commit.sha, commitFiles);
      }
      commitFiles.forEach(f => files.add(f));
    }

    return { files, commitCount: inWindow.length };
  };
}

/**
 * Judge every unresolved thread without changing anything.
 * Used by the retry-prompt builder, which must describe the thread state, not alter it.
 */
export async function evaluateReviewThreads(prNumber: number): Promise<ThreadVerdict[]> {
  const threads = await github.getUnresolvedReviewThreads(prNumber);
  if (threads.length === 0) return [];

  const selfLogin = await github.getAuthenticatedLogin();

  let commits: github.PRCommit[] | null = null;
  try {
    commits = await github.getPRCommits(prNumber);
  } catch (error) {
    // Fail closed: without the commit list nothing can be backed, so nothing resolves.
    console.warn(`[thread-resolver] Could not list commits for PR #${prNumber}:`, error instanceof Error ? error.message : error);
  }
  const filesChangedSince = buildEvidenceReader(commits);

  const verdicts: ThreadVerdict[] = [];

  for (const t of threads) {
    const agentReplied = t.replyCount > 0 && isOurs(t.lastAuthor, selfLogin);
    const reviewCommentAt = lastReviewCommentAt(t, selfLogin);

    const base = {
      threadId: t.id,
      path: t.path,
      line: t.line,
      isOutdated: t.isOutdated,
      firstComment: t.firstComment,
      lastAuthor: t.lastAuthor,
      agentReplied,
      reviewCommentAt,
      commentIds: t.commentIds,
    };

    if (!agentReplied) {
      verdicts.push({
        ...base,
        codeChangedAfterReview: false,
        commitsSinceReview: 0,
        decision: 'no_reply',
        reason: t.replyCount === 0 ? 'no reply at all' : `last reply is from @${t.lastAuthor}, not us`,
      });
      continue;
    }

    if (!t.path) {
      verdicts.push({
        ...base,
        codeChangedAfterReview: false,
        commitsSinceReview: 0,
        decision: 'unverifiable',
        reason: 'thread has no file, so no commit can be matched against it',
      });
      continue;
    }

    if (!reviewCommentAt) {
      verdicts.push({
        ...base,
        codeChangedAfterReview: false,
        commitsSinceReview: 0,
        decision: 'unverifiable',
        reason: 'thread has no reviewer comment to date the evidence from',
      });
      continue;
    }

    const evidence = await filesChangedSince(reviewCommentAt);
    if (!evidence) {
      verdicts.push({
        ...base,
        codeChangedAfterReview: false,
        commitsSinceReview: 0,
        decision: 'unverifiable',
        reason: 'commit history could not be read on this pass',
      });
      continue;
    }

    const codeChangedAfterReview = evidence.files.has(t.path);
    verdicts.push({
      ...base,
      codeChangedAfterReview,
      commitsSinceReview: evidence.commitCount,
      decision: codeChangedAfterReview ? 'resolved' : 'unbacked_claim',  // provisional; the mutation happens in resolveAddressedThreads
      reason: codeChangedAfterReview
        ? `replied, and ${evidence.commitCount} commit(s) since the review touched ${t.path}`
        : evidence.commitCount === 0
          ? `replied, but nothing was pushed since the review comment (${reviewCommentAt})`
          : `replied, but none of the ${evidence.commitCount} commit(s) since the review touch ${t.path}`,
    });
  }

  return verdicts;
}

/**
 * Resolve every thread the evidence backs; leave the rest open and report them.
 * Safe to call repeatedly — a resolved thread stops appearing in the unresolved set.
 */
export async function resolveAddressedThreads(prNumber: number): Promise<ThreadResolutionResult> {
  const verdicts = await evaluateReviewThreads(prNumber);

  const resolved: ThreadVerdict[] = [];
  const stillOpen: ThreadVerdict[] = [];

  for (const v of verdicts) {
    const where = `${v.path ?? '(no path)'}${v.line ? `:${v.line}` : ''}`;

    if (v.decision !== 'resolved') {
      stillOpen.push(v);
      console.log(`[thread-resolver] PR #${prNumber} ${where}: LEFT OPEN (${v.decision}) — ${v.reason}`);
      continue;
    }

    const ok = await github.resolveReviewThread(v.threadId);
    if (ok) {
      resolved.push(v);
      console.log(`[thread-resolver] PR #${prNumber} ${where}: RESOLVED — ${v.reason}`);
    } else {
      const failed: ThreadVerdict = { ...v, decision: 'resolve_failed', reason: `${v.reason}; resolve mutation failed` };
      stillOpen.push(failed);
      console.log(`[thread-resolver] PR #${prNumber} ${where}: LEFT OPEN (resolve_failed) — ${failed.reason}`);
    }
  }

  return {
    verdicts,
    resolved,
    stillOpen,
    unbackedClaims: stillOpen.filter(v => v.decision === 'unbacked_claim'),
    unverifiable: stillOpen.filter(v => v.decision === 'unverifiable'),
  };
}
