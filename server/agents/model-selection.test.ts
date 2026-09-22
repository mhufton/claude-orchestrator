import { describe, test, expect } from 'bun:test';
import { selectModel } from './spawner';
import type { Ticket } from '../state/types';

function ticketWith(overrides: Partial<Ticket>): Ticket {
  return {
    id: 1, github_issue_number: 1, labels: '[]',
    attempt_count: 1, should_escalate_model: 0, error_category: null,
    ...overrides,
  } as unknown as Ticket;
}

describe('selectModel (MODEL_ESCALATION_LADDER)', () => {
  test('attempt 1 uses the first rung (sonnet)', () => {
    expect(selectModel(ticketWith({ attempt_count: 1 }))).toBe('sonnet');
  });

  test('attempt 2 escalates to the second rung (opus)', () => {
    expect(selectModel(ticketWith({ attempt_count: 2 }))).toBe('opus');
  });

  test('an attempt past the ladder length repeats the last rung', () => {
    expect(selectModel(ticketWith({ attempt_count: 5 }))).toBe('opus');
  });

  test('use-opus label overrides the ladder', () => {
    expect(selectModel(ticketWith({ attempt_count: 1, labels: '["use-opus"]' }))).toBe('opus');
  });

  test('should_escalate_model flag overrides the ladder', () => {
    expect(selectModel(ticketWith({ attempt_count: 1, should_escalate_model: 1 }))).toBe('opus');
  });
});
