import { describe, test, expect } from 'bun:test';
import { buildAgentPrompt, buildBatchAgentPrompt, buildInvestigationSteps } from './prompts.holistic';
import type { Batch, ReviewContext, Ticket } from '../state/types';

const ticket = {
  id: 1, github_issue_number: 10, title: 'A', body: 'x',
  attempt_count: 2, pr_number: 99, handoff_notes: null,
} as unknown as Ticket;

const batch = {
  id: 7, area_key: 'server/github', attempt_count: 2, pr_number: 99, current_score: 94,
} as unknown as Batch;

const context: ReviewContext = {
  previousScore: 94,
  reviewFeedback: 'findings',
  ciFailures: [],
  inlineComments: ['[Comment ID: 5] a.ts:1 (@github-actions[bot]): fix this'],
  repoOwner: 'acme',
  repoName: 'widgets',
  userMessages: [],
  unresolvedThreads: [{
    threadId: 'T9', path: 'a.ts', line: 1, isOutdated: false, firstComment: 'fix this',
    agentReplied: true, codeChangedAfterReview: false,
    decision: 'unbacked_claim', reason: 'nothing was pushed since the review comment',
  }],
};

/** The block both retry prompts must render identically. */
function threadBlock(prompt: string): string {
  const start = prompt.indexOf('REVIEW THREAD(S) ARE OPEN');
  const end = prompt.indexOf('The run is then parked for review');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

describe('retry prompts', () => {
  test('ticket and batch retries render the same open-thread block', () => {
    const ticketPrompt = buildAgentPrompt(ticket, context);
    const batchPrompt = buildBatchAgentPrompt(batch, [ticket], context);
    expect(threadBlock(batchPrompt)).toBe(threadBlock(ticketPrompt));
  });

  test('both print real repo identity, never OWNER/REPO/PR placeholders', () => {
    for (const prompt of [buildAgentPrompt(ticket, context), buildBatchAgentPrompt(batch, [ticket], context)]) {
      expect(prompt).toContain('repos/acme/widgets/pulls/99/comments/COMMENT_ID/replies');
      expect(prompt).not.toContain('owner:"OWNER"');
      expect(prompt).not.toContain('number:PR');
    }
  });

  test('batch retry lists every issue the PR must still close', () => {
    const second = { ...ticket, id: 2, github_issue_number: 11, title: 'B' } as Ticket;
    const prompt = buildBatchAgentPrompt(batch, [ticket, second], context);
    expect(prompt).toContain('#10: A');
    expect(prompt).toContain('#11: B');
    expect(prompt).toContain('Attempt #2');
  });

  test('a batch with no PR still gets the greenfield prompt', () => {
    const fresh = { ...batch, pr_number: null } as Batch;
    const prompt = buildBatchAgentPrompt(fresh, [ticket], context);
    expect(prompt).toContain('HOLISTIC ANALYSIS FOR BATCH');
    expect(prompt).not.toContain('WHAT YOU MUST DO NOW');
  });

  test('the score step states the real gate, not a hardcoded 90', () => {
    const steps = buildInvestigationSteps(context, 99).join('\n');
    expect(steps).toContain('the merge gate is 98/100');
  });
});
