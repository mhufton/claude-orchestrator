import { describe, test, expect } from 'bun:test';
import { categorizeError, getCategoryDescription, shouldFlagForHuman } from './error-types';

describe('categorizeError', () => {
  describe('CI Failures', () => {
    test('categorizes build failures with 10s cooldown and immediate escalation', () => {
      const result = categorizeError({
        ciFailures: [
          { name: 'Build', output: 'syntax error in file.ts' }
        ],
        attemptCount: 1
      });

      expect(result.category).toBe('ci_build_failure');
      expect(result.severity).toBe('fixable');
      expect(result.suggestedCooldown).toBe(10000); // 10s
      expect(result.escalateModel).toBe(true); // Escalate immediately
    });

    test('categorizes lint failures with 10s cooldown', () => {
      const result = categorizeError({
        ciFailures: [
          { name: 'Lint', output: 'ESLint found 3 errors' }
        ],
        attemptCount: 1
      });

      expect(result.category).toBe('ci_lint_failure');
      expect(result.suggestedCooldown).toBe(10000); // 10s
      expect(result.escalateModel).toBe(true); // Escalate immediately
    });

    test('categorizes timeout with 1min cooldown and escalation', () => {
      const result = categorizeError({
        ciFailures: [
          { name: 'Tests', output: 'operation timed out after 30m' }
        ],
        attemptCount: 1
      });

      expect(result.category).toBe('ci_timeout');
      expect(result.severity).toBe('transient');
      expect(result.suggestedCooldown).toBe(60000); // 1min
      expect(result.escalateModel).toBe(true); // Always escalate
    });

    test('categorizes test failures with 30s cooldown', () => {
      const result = categorizeError({
        ciFailures: [
          { name: 'Jest Tests', output: 'Expected 5 to be 6' }
        ],
        attemptCount: 1
      });

      expect(result.category).toBe('ci_test_failure');
      expect(result.suggestedCooldown).toBe(30000); // 30s
      expect(result.escalateModel).toBe(false); // Don't escalate on first attempt
    });

    test('escalates test failures on second attempt', () => {
      const result = categorizeError({
        ciFailures: [
          { name: 'Jest Tests', output: 'Expected 5 to be 6' }
        ],
        attemptCount: 2
      });

      expect(result.category).toBe('ci_test_failure');
      expect(result.escalateModel).toBe(true); // Escalate after second attempt
    });
  });

  describe('Merge Conflicts', () => {
    test('categorizes merge conflicts with 10s cooldown and immediate escalation', () => {
      const result = categorizeError({
        hasMergeConflict: true,
        attemptCount: 1
      });

      expect(result.category).toBe('merge_conflict');
      expect(result.severity).toBe('fixable');
      expect(result.suggestedCooldown).toBe(10000); // 10s
      expect(result.escalateModel).toBe(true); // Escalate immediately
    });
  });

  describe('Review Score', () => {
    test('categorizes low review score with 30s cooldown', () => {
      const result = categorizeError({
        reviewScore: 75,
        attemptCount: 1
      });

      expect(result.category).toBe('review_score_low');
      expect(result.severity).toBe('fixable');
      expect(result.suggestedCooldown).toBe(30000); // 30s
      expect(result.escalateModel).toBe(false); // Don't escalate on first attempt
    });

    test('escalates low review score on second attempt', () => {
      const result = categorizeError({
        reviewScore: 85,
        attemptCount: 2
      });

      expect(result.category).toBe('review_score_low');
      expect(result.escalateModel).toBe(true); // Escalate after second attempt
    });

    test('does not categorize as low score when score is high', () => {
      const result = categorizeError({
        reviewScore: 95,
        attemptCount: 1
      });

      expect(result.category).not.toBe('review_score_low');
      expect(result.category).toBe('unknown');
    });
  });

  describe('Agent Process Failures', () => {
    test('categorizes dependency errors', () => {
      const result = categorizeError({
        agentExitCode: 1,
        recentErrors: ['Cannot find module "express"', 'ENOENT: no such file'],
        attemptCount: 1
      });

      expect(result.category).toBe('dependency_error');
      expect(result.severity).toBe('fixable');
      expect(result.suggestedCooldown).toBe(30000);
      expect(result.escalateModel).toBe(false); // Don't escalate on first attempt
    });

    test('categorizes permission errors as critical', () => {
      const result = categorizeError({
        agentExitCode: 1,
        recentErrors: ['EACCES: permission denied, mkdir "/root/test"'],
        attemptCount: 1
      });

      expect(result.category).toBe('permission_error');
      expect(result.severity).toBe('critical');
      expect(result.escalateModel).toBe(true); // Escalate immediately - needs different approach
    });

    test('categorizes agent timeout', () => {
      const result = categorizeError({
        agentExitCode: 124,
        recentErrors: ['Command timed out after 60s'],
        attemptCount: 1
      });

      expect(result.category).toBe('agent_timeout');
      expect(result.severity).toBe('transient');
      expect(result.suggestedCooldown).toBe(60000); // 1min
      expect(result.escalateModel).toBe(true); // Escalate immediately
    });

    test('categorizes agent crash', () => {
      const result = categorizeError({
        agentExitCode: 1,
        recentErrors: ['Segmentation fault'],
        attemptCount: 1
      });

      expect(result.category).toBe('agent_crash');
      expect(result.severity).toBe('critical');
      expect(result.escalateModel).toBe(false); // Don't escalate on first attempt
    });

    test('escalates agent crash on second attempt', () => {
      const result = categorizeError({
        agentExitCode: 1,
        recentErrors: ['Segmentation fault'],
        attemptCount: 2
      });

      expect(result.category).toBe('agent_crash');
      expect(result.escalateModel).toBe(true); // Escalate after second attempt
    });
  });

  describe('Priority and Fallback', () => {
    test('prioritizes merge conflicts over CI failures', () => {
      const result = categorizeError({
        hasMergeConflict: true,
        ciFailures: [{ name: 'Tests', output: 'Failed' }],
        attemptCount: 1
      });

      expect(result.category).toBe('merge_conflict'); // Merge conflict takes priority
    });

    test('prioritizes CI failures over review score', () => {
      const result = categorizeError({
        ciFailures: [{ name: 'Build', output: 'Failed' }],
        reviewScore: 75,
        attemptCount: 1
      });

      expect(result.category).toBe('ci_build_failure'); // CI failure takes priority
    });

    test('falls back to unknown category', () => {
      const result = categorizeError({
        attemptCount: 1
      });

      expect(result.category).toBe('unknown');
      expect(result.severity).toBe('fixable');
      expect(result.suggestedCooldown).toBe(30000); // Conservative default
      expect(result.escalateModel).toBe(false);
    });

    test('escalates unknown errors on second attempt', () => {
      const result = categorizeError({
        attemptCount: 2
      });

      expect(result.category).toBe('unknown');
      expect(result.escalateModel).toBe(true);
    });
  });
});

describe('getCategoryDescription', () => {
  test('returns descriptions for all categories', () => {
    expect(getCategoryDescription('ci_test_failure')).toBe('Tests failing in CI');
    expect(getCategoryDescription('ci_build_failure')).toBe('Build/compilation errors');
    expect(getCategoryDescription('ci_lint_failure')).toBe('Linting errors');
    expect(getCategoryDescription('ci_timeout')).toBe('CI checks timed out');
    expect(getCategoryDescription('agent_timeout')).toBe('Agent process timed out');
    expect(getCategoryDescription('agent_crash')).toBe('Agent process crashed');
    expect(getCategoryDescription('dependency_error')).toBe('Dependency/module errors');
    expect(getCategoryDescription('permission_error')).toBe('Permission denied errors');
    expect(getCategoryDescription('review_score_low')).toBe('Review score below threshold');
    expect(getCategoryDescription('merge_conflict')).toBe('Merge conflicts with base branch');
    expect(getCategoryDescription('unknown')).toBe('Unknown error type');
  });
});

describe('shouldFlagForHuman', () => {
  test('flags permission errors after 2 attempts', () => {
    expect(shouldFlagForHuman('permission_error', 1)).toBe(false);
    expect(shouldFlagForHuman('permission_error', 2)).toBe(true);
  });

  test('flags most errors after 3 attempts', () => {
    expect(shouldFlagForHuman('ci_test_failure', 2)).toBe(false);
    expect(shouldFlagForHuman('ci_test_failure', 3)).toBe(true);

    expect(shouldFlagForHuman('agent_crash', 2)).toBe(false);
    expect(shouldFlagForHuman('agent_crash', 3)).toBe(true);

    expect(shouldFlagForHuman('merge_conflict', 2)).toBe(false);
    expect(shouldFlagForHuman('merge_conflict', 3)).toBe(true);
  });
});
