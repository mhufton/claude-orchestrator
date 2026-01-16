import { describe, test, expect } from 'bun:test';
import { calculateBackoffDelay } from './spawner';

describe('calculateBackoffDelay', () => {
  describe('Default parameters (baseDelay=5000ms, backoffFactor=2, maxDelay=120000ms)', () => {
    test('calculates correct delay for attempt 1', () => {
      const delay = calculateBackoffDelay(1);
      expect(delay).toBe(5000); // 5s * 2^0 = 5s
    });

    test('calculates correct delay for attempt 2', () => {
      const delay = calculateBackoffDelay(2);
      expect(delay).toBe(10000); // 5s * 2^1 = 10s
    });

    test('calculates correct delay for attempt 3', () => {
      const delay = calculateBackoffDelay(3);
      expect(delay).toBe(20000); // 5s * 2^2 = 20s
    });

    test('calculates correct delay for attempt 4', () => {
      const delay = calculateBackoffDelay(4);
      expect(delay).toBe(40000); // 5s * 2^3 = 40s
    });

    test('calculates correct delay for attempt 5', () => {
      const delay = calculateBackoffDelay(5);
      expect(delay).toBe(80000); // 5s * 2^4 = 80s
    });

    test('caps delay at maxDelay for attempt 6', () => {
      const delay = calculateBackoffDelay(6);
      expect(delay).toBe(120000); // 5s * 2^5 = 160s, but capped at 120s
    });

    test('caps delay at maxDelay for attempt 7', () => {
      const delay = calculateBackoffDelay(7);
      expect(delay).toBe(120000); // Would be 320s, but capped at 120s
    });
  });

  describe('Custom baseDelay parameter', () => {
    test('uses 10s base delay from error categorization (merge conflict)', () => {
      const delay = calculateBackoffDelay(1, 10000); // 10s for merge conflicts
      expect(delay).toBe(10000); // 10s * 2^0 = 10s
    });

    test('applies exponential backoff with 10s base delay', () => {
      expect(calculateBackoffDelay(1, 10000)).toBe(10000);  // 10s
      expect(calculateBackoffDelay(2, 10000)).toBe(20000);  // 20s
      expect(calculateBackoffDelay(3, 10000)).toBe(40000);  // 40s
      expect(calculateBackoffDelay(4, 10000)).toBe(80000);  // 80s
      expect(calculateBackoffDelay(5, 10000)).toBe(120000); // 160s capped at 120s
    });

    test('uses 30s base delay from error categorization (test failure)', () => {
      const delay = calculateBackoffDelay(1, 30000); // 30s for test failures
      expect(delay).toBe(30000); // 30s * 2^0 = 30s
    });

    test('applies exponential backoff with 30s base delay', () => {
      expect(calculateBackoffDelay(1, 30000)).toBe(30000);  // 30s
      expect(calculateBackoffDelay(2, 30000)).toBe(60000);  // 60s (1min)
      expect(calculateBackoffDelay(3, 30000)).toBe(120000); // 120s (2min, at max)
      expect(calculateBackoffDelay(4, 30000)).toBe(120000); // Would be 240s, but capped
    });

    test('uses 60s base delay from error categorization (timeout)', () => {
      const delay = calculateBackoffDelay(1, 60000); // 60s for timeouts
      expect(delay).toBe(60000); // 60s * 2^0 = 60s
    });

    test('applies exponential backoff with 60s base delay', () => {
      expect(calculateBackoffDelay(1, 60000)).toBe(60000);  // 60s (1min)
      expect(calculateBackoffDelay(2, 60000)).toBe(120000); // 120s (2min, at max)
      expect(calculateBackoffDelay(3, 60000)).toBe(120000); // Would be 240s, but capped
    });
  });

  describe('Custom backoffFactor parameter', () => {
    test('uses factor of 1.5 for slower growth', () => {
      expect(calculateBackoffDelay(1, 5000, 1.5)).toBe(5000);   // 5s * 1.5^0 = 5s
      expect(calculateBackoffDelay(2, 5000, 1.5)).toBe(7500);   // 5s * 1.5^1 = 7.5s
      expect(calculateBackoffDelay(3, 5000, 1.5)).toBe(11250);  // 5s * 1.5^2 = 11.25s
      expect(calculateBackoffDelay(4, 5000, 1.5)).toBe(16875);  // 5s * 1.5^3 = 16.875s
    });

    test('uses factor of 3 for faster growth', () => {
      expect(calculateBackoffDelay(1, 5000, 3)).toBe(5000);  // 5s * 3^0 = 5s
      expect(calculateBackoffDelay(2, 5000, 3)).toBe(15000); // 5s * 3^1 = 15s
      expect(calculateBackoffDelay(3, 5000, 3)).toBe(45000); // 5s * 3^2 = 45s
      expect(calculateBackoffDelay(4, 5000, 3)).toBe(120000); // 5s * 3^3 = 135s, capped at 120s
    });
  });

  describe('Custom maxDelay parameter', () => {
    test('caps at 60s instead of default 120s', () => {
      expect(calculateBackoffDelay(5, 5000, 2, 60000)).toBe(60000); // 80s capped at 60s
      expect(calculateBackoffDelay(6, 5000, 2, 60000)).toBe(60000); // 160s capped at 60s
    });

    test('caps at 300s for longer maximum backoff', () => {
      expect(calculateBackoffDelay(6, 5000, 2, 300000)).toBe(160000); // 160s (not capped)
      expect(calculateBackoffDelay(7, 5000, 2, 300000)).toBe(300000); // 320s capped at 300s
    });
  });

  describe('Edge cases', () => {
    test('handles attempt count of 0 as 1', () => {
      const delay = calculateBackoffDelay(0);
      expect(delay).toBe(5000); // Normalized to attempt 1
    });

    test('handles negative attempt count as 1', () => {
      const delay = calculateBackoffDelay(-5);
      expect(delay).toBe(5000); // Normalized to attempt 1
    });

    test('handles very large attempt counts', () => {
      const delay = calculateBackoffDelay(100);
      expect(delay).toBe(120000); // Should be capped at maxDelay
    });

    test('handles base delay of 0', () => {
      const delay = calculateBackoffDelay(3, 0);
      expect(delay).toBe(0); // 0 * 2^2 = 0
    });

    test('handles backoff factor of 1 (no growth)', () => {
      expect(calculateBackoffDelay(1, 10000, 1)).toBe(10000); // 10s * 1^0 = 10s
      expect(calculateBackoffDelay(5, 10000, 1)).toBe(10000); // 10s * 1^4 = 10s
    });
  });

  describe('Integration with error categorization', () => {
    test('simulates merge conflict retry (10s base, quick escalation)', () => {
      const baseDelay = 10000; // from categorizeError for merge_conflict
      expect(calculateBackoffDelay(1, baseDelay)).toBe(10000);  // First attempt: 10s
      expect(calculateBackoffDelay(2, baseDelay)).toBe(20000);  // Second attempt: 20s
      expect(calculateBackoffDelay(3, baseDelay)).toBe(40000);  // Third attempt: 40s
    });

    test('simulates test failure retry (30s base, moderate escalation)', () => {
      const baseDelay = 30000; // from categorizeError for ci_test_failure
      expect(calculateBackoffDelay(1, baseDelay)).toBe(30000);  // First attempt: 30s
      expect(calculateBackoffDelay(2, baseDelay)).toBe(60000);  // Second attempt: 60s
      expect(calculateBackoffDelay(3, baseDelay)).toBe(120000); // Third attempt: 120s (capped)
    });

    test('simulates timeout retry (60s base, immediate max)', () => {
      const baseDelay = 60000; // from categorizeError for ci_timeout or agent_timeout
      expect(calculateBackoffDelay(1, baseDelay)).toBe(60000);  // First attempt: 60s
      expect(calculateBackoffDelay(2, baseDelay)).toBe(120000); // Second attempt: 120s (capped)
    });

    test('simulates unknown error with default 30s base', () => {
      const baseDelay = 30000; // from categorizeError for unknown category
      expect(calculateBackoffDelay(1, baseDelay)).toBe(30000);  // First attempt: 30s
      expect(calculateBackoffDelay(2, baseDelay)).toBe(60000);  // Second attempt: 60s
    });
  });

  describe('Comparison with old fixed delays', () => {
    test('old system: attempt 1 = 2s, new system with 5s base = 5s', () => {
      const oldDelay = 2000;
      const newDelay = calculateBackoffDelay(1, 5000);
      expect(newDelay).toBeGreaterThan(oldDelay); // New: 5s vs Old: 2s
    });

    test('old system: attempt 2 = 30s, new system with 5s base = 10s', () => {
      const oldDelay = 30000;
      const newDelay = calculateBackoffDelay(2, 5000);
      expect(newDelay).toBeLessThan(oldDelay); // New: 10s vs Old: 30s
    });

    test('old system: attempt 3 = 120s, new system with 5s base = 20s', () => {
      const oldDelay = 120000;
      const newDelay = calculateBackoffDelay(3, 5000);
      expect(newDelay).toBeLessThan(oldDelay); // New: 20s vs Old: 120s
    });

    test('new system is more predictable and exponential vs old fixed array', () => {
      // Old system: [2s, 30s, 120s] - irregular jumps
      // New system with 5s base: [5s, 10s, 20s, 40s, 80s, 120s] - smooth exponential growth
      const delays = [1, 2, 3, 4, 5, 6].map(attempt => calculateBackoffDelay(attempt, 5000));
      expect(delays).toEqual([5000, 10000, 20000, 40000, 80000, 120000]);
    });
  });
});
