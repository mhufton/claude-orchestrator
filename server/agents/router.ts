/**
 * The dispatch router: a readiness gate plus a phase selector, model choice as a
 * secondary output driven mainly by risk. See docs/dispatch-router-spec.md (the
 * build spec) for the measured background — model choice alone does not move
 * outcomes, readiness does, by roughly 2x.
 *
 * decide() is pure: it reads only the ticket row, its dispatch history, and files
 * on disk (the risk-path list). No network calls, no writes. Every rule reads only
 * `features`, never the ticket directly, so the recorded features are exactly what
 * decided — see buildFeatures().
 */
import * as db from '../db';
import { MODEL_ESCALATION_LADDER, SCORE_THRESHOLD } from '../config';
import { selectModel } from './spawner';
import { loadRiskList, matchRiskPaths, extractCandidatePaths } from './risk-list';
import type { Ticket, Dispatch } from '../state/types';

export type Phase = 'refine' | 'implement' | 'respond';
export type Model = 'sonnet' | 'opus';

/** Bumped whenever the rule table changes, so a decision row can be read against
 * the rule set that actually produced it. */
export const ROUTER_VERSION = '1.0.0';

const DECIDE_BUDGET_MS = 2000;

/** Error categories error-types.ts assigns to infrastructure failures rather than
 * genuine quality problems with the change itself — R5's "crash/timeout/lint class". */
const INFRA_ERROR_CATEGORIES = new Set(['agent_crash', 'agent_timeout', 'ci_timeout', 'ci_lint_failure']);

export interface DecisionFeatures {
  attemptCount: number;
  labels: string[];
  retryReason: string | null;
  errorCategory: string | null;
  ciStatus: string | null;
  currentScore: number | null;
  scoreThreshold: number;
  unresolvedThreadCount: number;
  hasIssueReview: boolean;
  reviewVerdict: string | null;
  hasScopeHeading: boolean;
  hasAcceptanceHeading: boolean;
  hasTouchpointsHeading: boolean;
  riskHits: string[];
  section8Declared: boolean;
  previousModel: Model | null;
  alreadyRefined: boolean;
}

export interface Decision {
  phase: Phase;
  model: Model;
  confidence: number;
  reason: string;
  rule: string;
  fallback: boolean;
  features: DecisionFeatures;
  routerVersion: string;
}

function safeParseLabels(labels: string | null): string[] {
  try {
    const parsed = JSON.parse(labels || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Normalizes a dispatch row's `model` back to the rule-facing union — completeDispatch
 * may have overwritten it with the CLI's raw reported id (e.g. "claude-opus-4-1-..."). */
function normalizeModel(raw: string | null | undefined): Model | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

const HEADING_PATTERNS: Record<'scope' | 'acceptance' | 'touchpoints', RegExp> = {
  scope: /^#{1,4}[ \t]*.*\bscope\b/im,
  acceptance: /^#{1,4}[ \t]*.*\bacceptance\b/im,
  touchpoints: /^#{1,4}[ \t]*.*\btouchpoints?\b/im,
};

/**
 * A non-N/A answer under a §8 (concurrency/idempotency) heading is a self-declared
 * write path — written for the change at hand, so unlike a glob list it cannot go
 * stale. Feeds R2 alongside the risk-path file.
 */
function hasSection8Declaration(body: string | null): boolean {
  if (!body) return false;
  const match = body.match(/^#{1,4}[ \t]*.*(§8|section\s*8|8[.)]\s*concurrency).*$/im);
  if (!match || match.index === undefined) return false;

  const rest = body.slice(match.index + match[0].length);
  const end = rest.search(/^#{1,4}[ \t]/m);
  const section = (end === -1 ? rest : rest.slice(0, end)).trim();

  if (!section) return false;
  return !/^n\/?a\.?$/i.test(section);
}

async function buildFeatures(ticket: Ticket, history: Dispatch[], worktreePath: string): Promise<{ features: DecisionFeatures; degraded: boolean; riskListSha: string | null }> {
  const riskList = await loadRiskList(worktreePath);
  const candidatePaths = [
    ...extractCandidatePaths(ticket.title),
    ...extractCandidatePaths(ticket.body),
  ];
  const pathHits = matchRiskPaths(riskList.entries, candidatePaths, 'blast');
  const section8Declared = hasSection8Declaration(ticket.body);

  const latestReview = db.getLatestReviewForTicket(ticket.id);
  const body = ticket.body || '';

  const features: DecisionFeatures = {
    attemptCount: ticket.attempt_count,
    labels: safeParseLabels(ticket.labels),
    retryReason: ticket.retry_reason,
    errorCategory: ticket.error_category,
    ciStatus: ticket.ci_status,
    currentScore: ticket.current_score,
    scoreThreshold: SCORE_THRESHOLD,
    unresolvedThreadCount: ticket.unresolved_thread_count ?? 0,
    // bun:sqlite's .get() returns null for no match, not undefined — loose check
    // catches both rather than reading a missing review as present.
    hasIssueReview: latestReview != null,
    reviewVerdict: latestReview?.verdict ?? null,
    hasScopeHeading: HEADING_PATTERNS.scope.test(body),
    hasAcceptanceHeading: HEADING_PATTERNS.acceptance.test(body),
    hasTouchpointsHeading: HEADING_PATTERNS.touchpoints.test(body),
    riskHits: pathHits.map(h => h.glob),
    section8Declared,
    previousModel: normalizeModel(history[0]?.model),
    alreadyRefined: history.some(d => d.phase === 'refine'),
  };

  return { features, degraded: riskList.degraded, riskListSha: riskList.sha };
}

function ladderRung(attemptCount: number): Model {
  const index = Math.max(0, Math.min(attemptCount - 1, MODEL_ESCALATION_LADDER.length - 1));
  return MODEL_ESCALATION_LADDER[index];
}

type RuleResult = Omit<Decision, 'features' | 'routerVersion' | 'fallback'>;

function applyRules(features: DecisionFeatures): RuleResult {
  // R1: human override. The label is written by haiku triage, not a human — see
  // the spec's R1 caveat — so it wins on phase/model like the others but at
  // reduced confidence rather than being treated as an instruction.
  if (features.labels.includes('use-opus')) {
    return { phase: 'implement', model: 'opus', confidence: 0.5, reason: 'use-opus label present', rule: 'R1.human_override' };
  }
  if (features.labels.includes('use-sonnet')) {
    return { phase: 'implement', model: 'sonnet', confidence: 0.5, reason: 'use-sonnet label present', rule: 'R1.human_override' };
  }

  // R2: risk floor.
  if (features.riskHits.length > 0 || features.section8Declared) {
    const why = features.riskHits.length > 0
      ? `risk-path hit: ${features.riskHits.join(', ')}`
      : 'self-declared write path in §8';
    return { phase: 'implement', model: 'opus', confidence: 0.9, reason: why, rule: 'R2.risk_floor' };
  }

  // R3: respond-only.
  const noCIFailures = features.ciStatus !== 'failing';
  const noMergeConflict = features.retryReason !== 'resolving_merge_conflict';
  const nearThreshold = features.currentScore !== null
    && features.currentScore < features.scoreThreshold
    && features.scoreThreshold - features.currentScore <= 5;
  if (features.attemptCount >= 2 && noCIFailures && noMergeConflict && (features.unresolvedThreadCount > 0 || nearThreshold)) {
    const why = features.unresolvedThreadCount > 0
      ? `${features.unresolvedThreadCount} unresolved review thread(s), no CI/merge blockers`
      : `score ${features.currentScore} within 5 of threshold ${features.scoreThreshold}`;
    return {
      phase: 'respond',
      model: features.previousModel ?? ladderRung(features.attemptCount),
      confidence: 0.8,
      reason: why,
      rule: 'R3.respond_only',
    };
  }

  // R4: reason-aware ladder — a genuine quality signal, not an infra hiccup.
  const isInfraRetry = features.retryReason === 'agent_interrupted' || (features.errorCategory !== null && INFRA_ERROR_CATEGORIES.has(features.errorCategory));
  if (features.attemptCount >= 2 && features.retryReason !== null && !isInfraRetry) {
    return {
      phase: 'implement',
      model: ladderRung(features.attemptCount),
      confidence: 0.7,
      reason: `retry reason "${features.retryReason}" is a quality signal, escalating per ladder`,
      rule: 'R4.reason_aware_ladder',
    };
  }

  // R5: hold on infra retry — same model, don't pay for opus on a stale-detector
  // restart or a lint hiccup.
  if (isInfraRetry) {
    return {
      phase: 'implement',
      model: features.previousModel ?? ladderRung(features.attemptCount),
      confidence: 0.7,
      reason: features.retryReason === 'agent_interrupted'
        ? 'agent_interrupted retry — holding model'
        : `error category "${features.errorCategory}" is infrastructure, not quality — holding model`,
      rule: 'R5.hold_on_infra_retry',
    };
  }

  // R6: readiness gate.
  const noHeadings = !features.hasScopeHeading && !features.hasAcceptanceHeading && !features.hasTouchpointsHeading;
  if (features.attemptCount === 1 && !features.alreadyRefined && (features.reviewVerdict === 'needs_revision' || !features.hasIssueReview || noHeadings)) {
    const why = features.reviewVerdict === 'needs_revision'
      ? 'triage verdict was needs_revision'
      : !features.hasIssueReview
        ? 'no issue_reviews row — never triaged'
        : 'none of the Scope/Acceptance/Touchpoints headings are present';
    return { phase: 'refine', model: 'opus', confidence: 0.8, reason: why, rule: 'R6.readiness_gate' };
  }

  // R7: default — current ladder behaviour.
  return {
    phase: 'implement',
    model: ladderRung(features.attemptCount),
    confidence: 0.6,
    reason: 'no rule matched, default ladder behaviour',
    rule: 'R7.default',
  };
}

function failOpen(ticket: Ticket, error: unknown): Decision {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[router] decide() failed for #${ticket.github_issue_number}, falling open:`, message);
  return {
    phase: 'implement',
    model: selectModel(ticket),
    confidence: 0,
    reason: `decide() failed: ${message}`,
    rule: 'R0.fail_open',
    fallback: true,
    features: {} as DecisionFeatures,
    routerVersion: ROUTER_VERSION,
  };
}

async function decideInner(ticket: Ticket, history: Dispatch[], worktreePath: string): Promise<Decision> {
  const { features, degraded } = await buildFeatures(ticket, history, worktreePath);
  const result = applyRules(features);

  return {
    ...result,
    // A degraded (present but unparsable) risk list is a data-quality problem, not
    // grounds to throw — R0 is for decide() itself breaking, not for a target repo's
    // malformed yaml. Penalize confidence instead.
    confidence: degraded ? result.confidence * 0.5 : result.confidence,
    fallback: false,
    features,
    routerVersion: ROUTER_VERSION,
  };
}

/**
 * Decide the phase and model for one dispatch. Fails open to R0 (current
 * selectModel() ladder, `implement`) on any throw or on exceeding the 2s budget —
 * a broken router must show up as a count, not a silent hang or a blocked spawn.
 */
export async function decide(ticket: Ticket, history: Dispatch[], worktreePath: string): Promise<Decision> {
  const budget = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`decide() exceeded ${DECIDE_BUDGET_MS}ms budget`)), DECIDE_BUDGET_MS);
  });

  try {
    return await Promise.race([decideInner(ticket, history, worktreePath), budget]);
  } catch (error) {
    return failOpen(ticket, error);
  }
}

/** Convenience for spawner.ts: the risk-list blob sha for the decision row, read the
 * same way decide() reads it. Kept separate so a caller that only needs the sha (for
 * recording) doesn't have to re-run the full rule set. */
export async function currentRiskListSha(worktreePath: string): Promise<string | null> {
  const { sha } = await loadRiskList(worktreePath);
  return sha;
}
