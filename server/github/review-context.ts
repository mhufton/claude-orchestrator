/**
 * Everything a retry prompt needs to know about a PR, derived from GitHub alone.
 *
 * Shared by the single-ticket retry context and the batch retry context: a batch PR
 * fails review for exactly the same reasons a ticket PR does, and a second copy of
 * this would drift.
 */

import * as github from './client';
import { evaluateReviewThreads } from './thread-resolver';
import type { UnresolvedThreadContext } from '../state/types';

export interface PRReviewContext {
  ciFailures: string[];
  inlineComments: string[];
  botComments: string[];
  unresolvedThreads: UnresolvedThreadContext[];
  hasMergeConflicts: boolean;
  repoOwner: string;
  repoName: string;
}

const BOT_USERNAMES = ['github-actions', 'github-actions[bot]', 'codecov', 'codecov[bot]', 'sonarcloud', 'sonarcloud[bot]'];

export async function getPRReviewContext(prNumber: number): Promise<PRReviewContext> {
  const { owner, repo } = github.getRepoInfo();
  const empty: PRReviewContext = {
    ciFailures: [],
    inlineComments: [],
    botComments: [],
    unresolvedThreads: [],
    hasMergeConflicts: false,
    repoOwner: owner,
    repoName: repo,
  };

  try {
    const pr = await github.getPR(prNumber);
    const prFeedback = await github.getPRFeedback(prNumber, pr.head.sha);

    // CI failures with actionable details (truncated to save tokens)
    const ciFailures = prFeedback.checkFailures.map(f => {
      const output = f.output.summary || f.output.text || '';
      const url = f.html_url || f.details_url || '';
      let info = `**${f.name}** FAILED`;
      if (output && output !== 'No details') {
        const truncatedOutput = output.length > 300 ? output.slice(0, 300) + '...' : output;
        info += `: ${truncatedOutput}`;
      }
      if (url) {
        info += `\n   Run: \`gh run view --job ${f.id} --log-failed\` for full logs`;
      }
      return info;
    });

    // Which threads are STILL open decides which comments are worth showing. The old
    // behaviour handed the agent the five OLDEST comments on the PR — resolved threads,
    // outdated threads and its own earlier replies — while the blocking ones scrolled
    // off the end.
    let threadVerdicts: Awaited<ReturnType<typeof evaluateReviewThreads>> | null = null;
    try {
      threadVerdicts = await evaluateReviewThreads(prNumber);
    } catch (threadErr) {
      // GraphQL unavailable: fall through to the unfiltered list rather than
      // telling the agent there is nothing to address.
      console.warn('Could not list unresolved review threads:', threadErr instanceof Error ? threadErr.message : threadErr);
    }

    const openThreadIds = threadVerdicts ? new Set(threadVerdicts.flatMap(v => v.commentIds)) : null;

    const inlineComments = prFeedback.reviewComments
      .filter(c => c.in_reply_to_id == null)  // top-level comments only; replies are ours
      .filter(c => (openThreadIds ? openThreadIds.has(c.id) : true))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(c => `[Comment ID: ${c.id}] ${c.path}${c.line ? `:${c.line}` : ''} (@${c.user.login}): ${c.body}`);

    const botComments = prFeedback.issueComments
      .filter(c => BOT_USERNAMES.some(bot => c.user.login.toLowerCase().includes(bot.replace('[bot]', ''))))
      .map(c => `@${c.user.login}: ${c.body.slice(0, 500)}${c.body.length > 500 ? '...' : ''}`);

    return {
      ciFailures,
      inlineComments,
      botComments,
      unresolvedThreads: (threadVerdicts ?? []).map(v => ({
        threadId: v.threadId,
        path: v.path,
        line: v.line,
        isOutdated: v.isOutdated,
        firstComment: v.firstComment,
        agentReplied: v.agentReplied,
        codeChangedAfterReview: v.codeChangedAfterReview,
        decision: v.decision,
        reason: v.reason,
      })),
      hasMergeConflicts: pr.mergeable === false,
      repoOwner: owner,
      repoName: repo,
    };
  } catch (err) {
    console.warn('Error getting PR feedback:', err);
    return empty;
  }
}
