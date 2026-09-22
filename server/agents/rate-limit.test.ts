import { describe, test, expect } from 'bun:test';
import { checkRateLimitEvent, getRateLimitSnapshot } from './spawner';

describe('checkRateLimitEvent', () => {
  test('records a snapshot from a well-formed rate_limit_event', () => {
    checkRateLimitEvent(1, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        unifiedWindows: {
          five_hour: { utilization: 0.51 },
          seven_day: { utilization: 0.72 },
        },
      },
    });

    const snapshot = getRateLimitSnapshot();
    expect(snapshot?.status).toBe('allowed');
    expect(snapshot?.rateLimitType).toBe('five_hour');
    expect(snapshot?.utilization.five_hour).toBe(0.51);
    expect(snapshot?.utilization.seven_day).toBe(0.72);
  });

  test('a threshold-crossing event still updates the snapshot', () => {
    checkRateLimitEvent(1, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        surpassedThreshold: 0.75,
        unifiedWindows: { seven_day: { utilization: 0.79 } },
      },
    });

    expect(getRateLimitSnapshot()?.status).toBe('allowed_warning');
  });

  test('ignores non-rate-limit events', () => {
    checkRateLimitEvent(1, { type: 'assistant', rate_limit_info: { status: 'allowed_warning' } });
    // Previous test's snapshot (allowed_warning) must be untouched, not overwritten
    // by an event whose type doesn't match.
    expect(getRateLimitSnapshot()?.status).toBe('allowed_warning');
  });

  test('ignores an event with no rate_limit_info', () => {
    const before = getRateLimitSnapshot();
    checkRateLimitEvent(1, { type: 'rate_limit_event' });
    expect(getRateLimitSnapshot()).toEqual(before);
  });
});
