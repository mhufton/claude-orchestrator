import { describe, test, expect, beforeAll } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import { initDatabase, createTicket, updateTicket, saveIssueReview } from '../db';
import { decide } from './router';
import type { Ticket, Dispatch, DispatchPhase } from '../state/types';

const READY_BODY = `## Scope\nDo the thing.\n\n## Acceptance\nIt works.\n\n## Touchpoints\napps/foo/**`;

let nextIssue = 9001;

function makeTicket(overrides: Partial<Ticket> & { skipReadyReview?: boolean } = {}): Ticket {
  const issueNumber = nextIssue++;
  const { skipReadyReview, ...ticketOverrides } = overrides;

  const created = createTicket({
    github_issue_number: issueNumber,
    github_issue_url: `https://github.com/mhufton/claude-orchestrator/issues/${issueNumber}`,
    title: ticketOverrides.title ?? `Test ticket ${issueNumber}`,
    body: (ticketOverrides.body !== undefined ? ticketOverrides.body : READY_BODY) ?? undefined,
    labels: ticketOverrides.labels,
  });

  const rest: Partial<Ticket> = { ...ticketOverrides };
  delete rest.title;
  delete rest.body;
  delete rest.labels;
  rest.attempt_count = rest.attempt_count ?? 1;

  const updated = updateTicket(created.id, rest)!;

  // The safe default: a 'ready' triage verdict on file, so R6 doesn't fire in tests
  // that aren't specifically exercising the readiness gate.
  if (!skipReadyReview) {
    saveIssueReview({ ticket_id: updated.id, verdict: 'ready', gaps: '[]', recommendations: null, changes_made: null });
  }

  return updated;
}

function dispatchFixture(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 1, ticket_id: 1, batch_id: null, attempt_number: 1,
    phase: 'implement' as DispatchPhase, model: 'sonnet', rule: 'R7.default',
    confidence: 0.6, reason: null, fallback: 0, mode: 'shadow', features: '{}',
    router_version: '1.0.0', risk_list_sha: null, dispatched_at: '2026-09-20T10:00:00Z',
    head_sha_before: 'sha0', finished_at: '2026-09-20T10:05:00Z', exit_code: 0,
    head_sha_after: 'sha1', pr_number: null, score: null, score_comment_id: null,
    scored_at: null, cost_usd: null, input_tokens: null, output_tokens: null,
    num_turns: null, duration_ms: null, outcome: null,
    ...overrides,
  };
}

let emptyWorktree: string;
let riskWorktree: string;
let degradedWorktree: string;

beforeAll(() => {
  const dbPath = join(tmpdir(), `router-test-${Date.now()}-${Math.random()}.db`);
  initDatabase(dbPath);

  emptyWorktree = mkdtempSync(join(tmpdir(), 'router-empty-'));

  riskWorktree = mkdtempSync(join(tmpdir(), 'router-risk-'));
  mkdirSync(join(riskWorktree, '.claude'), { recursive: true });
  writeFileSync(
    join(riskWorktree, '.claude', 'risk-paths.yaml'),
    'paths:\n  - glob: "apps/payment-api/**"\n    tier: blast\n  - glob: "docs/**"\n    tier: low\n'
  );

  degradedWorktree = mkdtempSync(join(tmpdir(), 'router-degraded-'));
  mkdirSync(join(degradedWorktree, '.claude'), { recursive: true });
  writeFileSync(join(degradedWorktree, '.claude', 'risk-paths.yaml'), ': this is not : valid : yaml : [[[');
});

describe('decide() — R0 fail open', () => {
  test('a broken worktreePath throws inside decide(), which falls open rather than rejecting', async () => {
    const ticket = makeTicket({ attempt_count: 3, labels: '["use-opus"]' });
    // path.join on a non-string throws a TypeError — a realistic shape of bug for
    // decide() to survive without ever propagating into the caller.
    const decision = await decide(ticket, [], 12345 as unknown as string);

    expect(decision.rule).toBe('R0.fail_open');
    expect(decision.fallback).toBe(true);
    expect(decision.phase).toBe('implement');
    expect(decision.confidence).toBe(0);
    // The fallback calls the untouched selectModel(ticket) — a completely separate
    // code path from decide()'s own R1 — and that path also honors use-opus.
    expect(decision.model).toBe('opus');
  });
});

describe('decide() — R1 human override', () => {
  test('use-opus label wins, low confidence', async () => {
    const ticket = makeTicket({ labels: '["use-opus"]' });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R1.human_override');
    expect(decision.phase).toBe('implement');
    expect(decision.model).toBe('opus');
    expect(decision.confidence).toBeLessThanOrEqual(0.5);
  });

  test('use-sonnet label wins', async () => {
    const ticket = makeTicket({ labels: '["use-sonnet"]' });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R1.human_override');
    expect(decision.model).toBe('sonnet');
  });
});

describe('decide() — R2 risk floor', () => {
  test('a risk-path glob hit at tier blast forces opus', async () => {
    const ticket = makeTicket({ body: `${READY_BODY}\n\nTouches \`apps/payment-api/src/index.ts\`.` });
    const decision = await decide(ticket, [], riskWorktree);
    expect(decision.rule).toBe('R2.risk_floor');
    expect(decision.model).toBe('opus');
    expect(decision.features.riskHits.length).toBeGreaterThan(0);
  });

  test('a hit at a non-blast tier does not fire R2', async () => {
    const ticket = makeTicket({ body: `${READY_BODY}\n\nTouches \`docs/readme.md\`.` });
    const decision = await decide(ticket, [], riskWorktree);
    expect(decision.rule).not.toBe('R2.risk_floor');
  });

  test('a non-N/A §8 answer is a self-declared risk hit', async () => {
    const ticket = makeTicket({
      body: `${READY_BODY}\n\n## §8 Concurrency/Idempotency\nWrites to the shared credit ledger under a row lock.\n`,
    });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R2.risk_floor');
    expect(decision.features.section8Declared).toBe(true);
  });

  test('an N/A §8 answer is not a risk hit', async () => {
    const ticket = makeTicket({ body: `${READY_BODY}\n\n## §8 Concurrency/Idempotency\nN/A\n` });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).not.toBe('R2.risk_floor');
  });

  test('a present-but-unparsable risk list degrades confidence rather than throwing', async () => {
    const ticket = makeTicket();
    const decision = await decide(ticket, [], degradedWorktree);
    expect(decision.fallback).toBe(false);
    expect(decision.rule).toBe('R7.default');
    expect(decision.confidence).toBeLessThan(0.6);
  });
});

describe('decide() — R3 respond-only', () => {
  test('unresolved threads, no CI/merge blockers, attempt >= 2 -> respond at the same model', async () => {
    const ticket = makeTicket({ attempt_count: 2, ci_status: 'passing', unresolved_thread_count: 2 });
    const history = [dispatchFixture({ model: 'opus' })];
    const decision = await decide(ticket, history, emptyWorktree);
    expect(decision.rule).toBe('R3.respond_only');
    expect(decision.phase).toBe('respond');
    expect(decision.model).toBe('opus');
  });

  test('score within 5 of threshold also qualifies', async () => {
    const ticket = makeTicket({ attempt_count: 2, ci_status: 'passing', current_score: 95 });
    const history = [dispatchFixture({ model: 'sonnet' })];
    const decision = await decide(ticket, history, emptyWorktree);
    expect(decision.rule).toBe('R3.respond_only');
  });

  test('CI failing disqualifies R3 even with unresolved threads', async () => {
    const ticket = makeTicket({ attempt_count: 2, ci_status: 'failing', unresolved_thread_count: 2, retry_reason: 'fixing_ci' });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).not.toBe('R3.respond_only');
  });

  test('a merge conflict disqualifies R3', async () => {
    const ticket = makeTicket({ attempt_count: 2, ci_status: 'passing', unresolved_thread_count: 2, retry_reason: 'resolving_merge_conflict' });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).not.toBe('R3.respond_only');
  });

  test('attempt 1 cannot hit R3', async () => {
    const ticket = makeTicket({ attempt_count: 1, ci_status: 'passing', unresolved_thread_count: 2 });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).not.toBe('R3.respond_only');
  });
});

describe('decide() — R4 reason-aware ladder', () => {
  test('a genuine quality retry reason escalates per the ladder', async () => {
    const ticket = makeTicket({ attempt_count: 2, retry_reason: 'addressing_pr_comments' });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).toBe('R4.reason_aware_ladder');
    expect(decision.phase).toBe('implement');
    expect(decision.model).toBe('opus'); // MODEL_ESCALATION_LADDER[1]
  });

  test('improving_score is also a quality signal', async () => {
    const ticket = makeTicket({ attempt_count: 2, retry_reason: 'improving_score' });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).toBe('R4.reason_aware_ladder');
  });
});

describe('decide() — R5 hold on infra retry', () => {
  test('agent_interrupted holds the previous model instead of escalating', async () => {
    const ticket = makeTicket({ attempt_count: 2, retry_reason: 'agent_interrupted' });
    const history = [dispatchFixture({ model: 'sonnet' })];
    const decision = await decide(ticket, history, emptyWorktree);
    expect(decision.rule).toBe('R5.hold_on_infra_retry');
    expect(decision.model).toBe('sonnet');
  });

  test('a crash/timeout/lint error category holds even with a "quality" retry reason', async () => {
    const ticket = makeTicket({ attempt_count: 2, retry_reason: 'fixing_ci', error_category: 'agent_crash' });
    const history = [dispatchFixture({ model: 'opus' })];
    const decision = await decide(ticket, history, emptyWorktree);
    expect(decision.rule).toBe('R5.hold_on_infra_retry');
    expect(decision.model).toBe('opus');
  });

  test('ci_lint_failure is an infra class, not a quality signal', async () => {
    const ticket = makeTicket({ attempt_count: 2, retry_reason: 'fixing_ci', error_category: 'ci_lint_failure' });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).toBe('R5.hold_on_infra_retry');
  });
});

describe('decide() — R6 readiness gate', () => {
  test('a needs_revision verdict on the first attempt routes to refine', async () => {
    const ticket = makeTicket({ attempt_count: 1, skipReadyReview: true });
    saveIssueReview({ ticket_id: ticket.id, verdict: 'needs_revision', gaps: '["scope"]', recommendations: null, changes_made: null });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R6.readiness_gate');
    expect(decision.phase).toBe('refine');
    expect(decision.model).toBe('opus');
  });

  test('no issue_reviews row at all routes to refine', async () => {
    const ticket = makeTicket({ attempt_count: 1, skipReadyReview: true });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R6.readiness_gate');
    expect(decision.features.hasIssueReview).toBe(false);
  });

  test('none of Scope/Acceptance/Touchpoints present routes to refine', async () => {
    const ticket = makeTicket({ attempt_count: 1, body: 'Just fix the thing, no structure here.' });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R6.readiness_gate');
  });

  test('missing only one of the three headings does not fire R6', async () => {
    const ticket = makeTicket({ attempt_count: 1, body: '## Scope\nDo it.\n\n## Acceptance\nWorks.\n' });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).not.toBe('R6.readiness_gate');
  });

  test('a ready verdict with full headings does not fire R6', async () => {
    const ticket = makeTicket({ attempt_count: 1 });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).not.toBe('R6.readiness_gate');
  });

  test('a ticket already refined once does not refine again (hand back)', async () => {
    const ticket = makeTicket({ attempt_count: 1, skipReadyReview: true });
    const history = [dispatchFixture({ phase: 'refine', rule: 'R6.readiness_gate' })];
    const decision = await decide(ticket, history, emptyWorktree);
    expect(decision.rule).not.toBe('R6.readiness_gate');
    expect(decision.phase).not.toBe('refine');
  });

  test('R6 does not fire past the first attempt even when unready', async () => {
    const ticket = makeTicket({ attempt_count: 2, skipReadyReview: true });
    const decision = await decide(ticket, [dispatchFixture()], emptyWorktree);
    expect(decision.rule).not.toBe('R6.readiness_gate');
  });
});

describe('decide() — R7 default and rule precedence', () => {
  test('a fully ready, first-attempt ticket falls through to the default ladder', async () => {
    const ticket = makeTicket({ attempt_count: 1 });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.rule).toBe('R7.default');
    expect(decision.phase).toBe('implement');
    expect(decision.model).toBe('sonnet'); // MODEL_ESCALATION_LADDER[0]
  });

  test('R2 (risk) wins over R6 (readiness) when both conditions hold', async () => {
    const ticket = makeTicket({
      attempt_count: 1,
      skipReadyReview: true,
      body: `Touches \`apps/payment-api/src/index.ts\`.`,
    });
    const decision = await decide(ticket, [], riskWorktree);
    expect(decision.rule).toBe('R2.risk_floor');
  });

  test('every decision carries the router version and full features for the recorded row', async () => {
    const ticket = makeTicket({ attempt_count: 1 });
    const decision = await decide(ticket, [], emptyWorktree);
    expect(decision.routerVersion).toBeTruthy();
    expect(decision.features.attemptCount).toBe(1);
    expect(typeof decision.reason).toBe('string');
  });
});
