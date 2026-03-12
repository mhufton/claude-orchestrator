/**
 * Error Categorization System
 *
 * Categorizes agent/PR failures to enable smarter retry logic with:
 * - Appropriate cooldown timing based on error type
 * - Model escalation decisions based on severity
 * - Better debugging and metrics
 */

export type ErrorCategory =
  // CI Failures
  | 'ci_test_failure'
  | 'ci_build_failure'
  | 'ci_lint_failure'
  | 'ci_timeout'
  // Process Failures
  | 'agent_timeout'
  | 'agent_crash'
  // Environmental Issues
  | 'dependency_error'
  | 'permission_error'
  // Quality Gates
  | 'review_score_low'
  | 'merge_conflict'
  // Fallback
  | 'unknown';

export type Severity = 'transient' | 'fixable' | 'critical';

export interface CategorizedError {
  category: ErrorCategory;
  severity: Severity;
  suggestedCooldown: number; // milliseconds
  escalateModel: boolean; // should we use a stronger model?
  description: string;
}

/**
 * Categorize an error based on various signals from the system
 */
export function categorizeError(context: {
  // CI check failures (from GitHub)
  ciFailures?: Array<{ name: string; output?: string }>;

  // PR review score
  reviewScore?: number | null;

  // Merge conflict detection
  hasMergeConflict?: boolean;

  // Agent exit code
  agentExitCode?: number | null;

  // Recent errors from agent logs
  recentErrors?: string[];

  // Attempt count for escalation decisions
  attemptCount?: number;
}): CategorizedError {
  const attemptCount = context.attemptCount || 1;

  // PRIORITY 1: Merge conflicts (critical, needs immediate attention)
  if (context.hasMergeConflict) {
    return {
      category: 'merge_conflict',
      severity: 'fixable',
      suggestedCooldown: 10000, // 10s - quick turnaround
      escalateModel: attemptCount >= 1, // Escalate immediately
      description: 'Merge conflicts detected'
    };
  }

  // PRIORITY 2: CI Failures (most common, needs detailed categorization)
  if (context.ciFailures && context.ciFailures.length > 0) {
    // Analyze CI failure types
    const failureNames = context.ciFailures.map(f => f.name.toLowerCase()).join(' ');
    const failureOutputs = context.ciFailures
      .map(f => (f.output || '').toLowerCase())
      .join(' ');

    // Check for timeout
    if (failureNames.includes('timeout') || failureOutputs.includes('timeout') ||
        failureOutputs.includes('timed out')) {
      return {
        category: 'ci_timeout',
        severity: 'transient',
        suggestedCooldown: 60000, // 1min - allow system recovery
        escalateModel: true, // Always escalate on timeout
        description: 'CI checks timed out'
      };
    }

    // Check for build failures (syntax, type errors, compilation)
    if (failureNames.includes('build') || failureNames.includes('compile') ||
        failureOutputs.includes('syntax error') || failureOutputs.includes('type error') ||
        failureOutputs.includes('compilation failed')) {
      return {
        category: 'ci_build_failure',
        severity: 'fixable',
        suggestedCooldown: 10000, // 10s - quick turnaround for syntax fixes
        escalateModel: attemptCount >= 1, // Escalate immediately
        description: 'Build/compilation failed'
      };
    }

    // Check for lint failures
    if (failureNames.includes('lint') || failureNames.includes('eslint') ||
        failureOutputs.includes('lint')) {
      return {
        category: 'ci_lint_failure',
        severity: 'fixable',
        suggestedCooldown: 10000, // 10s - quick fix
        escalateModel: attemptCount >= 1, // Escalate immediately
        description: 'Linting errors'
      };
    }

    // Default to test failure for other CI issues
    return {
      category: 'ci_test_failure',
      severity: 'fixable',
      suggestedCooldown: 30000, // 30s - standard retry
      escalateModel: attemptCount >= 2, // Escalate after second attempt
      description: 'Tests failed'
    };
  }

  // PRIORITY 3: Review score too low
  if (context.reviewScore !== undefined && context.reviewScore !== null && context.reviewScore < 90) {
    return {
      category: 'review_score_low',
      severity: 'fixable',
      suggestedCooldown: 30000, // 30s
      escalateModel: attemptCount >= 2, // Escalate after second attempt
      description: `Review score ${context.reviewScore}/100 below threshold`
    };
  }

  // PRIORITY 4: Agent process failures
  if (context.agentExitCode !== undefined && context.agentExitCode !== null && context.agentExitCode !== 0) {
    // Analyze recent errors for more context
    const recentErrorsText = (context.recentErrors || []).join(' ').toLowerCase();

    // Check for dependency issues
    if (recentErrorsText.includes('enoent') || recentErrorsText.includes('cannot find module') ||
        recentErrorsText.includes('module not found') || recentErrorsText.includes('npm') ||
        recentErrorsText.includes('package')) {
      return {
        category: 'dependency_error',
        severity: 'fixable',
        suggestedCooldown: 30000, // 30s
        escalateModel: attemptCount >= 2,
        description: 'Dependency or module errors'
      };
    }

    // Check for permission errors
    if (recentErrorsText.includes('permission denied') || recentErrorsText.includes('eacces') ||
        recentErrorsText.includes('eperm')) {
      return {
        category: 'permission_error',
        severity: 'critical',
        suggestedCooldown: 30000, // 30s
        escalateModel: true, // Escalate immediately - needs different approach
        description: 'Permission errors detected'
      };
    }

    // Check for timeout indicators in errors
    if (recentErrorsText.includes('timeout') || recentErrorsText.includes('timed out')) {
      return {
        category: 'agent_timeout',
        severity: 'transient',
        suggestedCooldown: 60000, // 1min
        escalateModel: true, // Escalate immediately
        description: 'Agent process timed out'
      };
    }

    // Default to agent crash
    return {
      category: 'agent_crash',
      severity: 'critical',
      suggestedCooldown: 30000, // 30s
      escalateModel: attemptCount >= 2,
      description: `Agent exited with code ${context.agentExitCode}`
    };
  }

  // FALLBACK: Unknown error
  return {
    category: 'unknown',
    severity: 'fixable',
    suggestedCooldown: 30000, // 30s - conservative default
    escalateModel: attemptCount >= 2, // Escalate after a couple attempts
    description: 'Unknown error - requires investigation'
  };
}

/**
 * Get a human-readable description of an error category
 */
export function getCategoryDescription(category: ErrorCategory): string {
  const descriptions: Record<ErrorCategory, string> = {
    ci_test_failure: 'Tests failing in CI',
    ci_build_failure: 'Build/compilation errors',
    ci_lint_failure: 'Linting errors',
    ci_timeout: 'CI checks timed out',
    agent_timeout: 'Agent process timed out',
    agent_crash: 'Agent process crashed',
    dependency_error: 'Dependency/module errors',
    permission_error: 'Permission denied errors',
    review_score_low: 'Review score below threshold',
    merge_conflict: 'Merge conflicts with base branch',
    unknown: 'Unknown error type'
  };

  return descriptions[category];
}

/**
 * Determine if we should flag for human attention based on category and attempts
 */
export function shouldFlagForHuman(category: ErrorCategory, attemptCount: number): boolean {
  // Critical issues should flag sooner
  if (category === 'permission_error') {
    return attemptCount >= 2;
  }

  // Most issues get 3 attempts
  return attemptCount >= 3;
}
