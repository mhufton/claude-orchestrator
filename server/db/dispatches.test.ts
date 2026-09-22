import { describe, test, expect, beforeAll } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initDatabase,
  createTicket,
  insertDispatch,
  getDispatchById,
  completeDispatch,
  getDispatchByTicketAndSha,
  recordDispatchScore,
  insertLog,
  getLogsForTicket,
  getRecentLogsByType,
} from './index';

function makeTicket(issueNumber: number) {
  return createTicket({
    github_issue_number: issueNumber,
    github_issue_url: `https://github.com/mhufton/claude-orchestrator/issues/${issueNumber}`,
    title: `Test ticket ${issueNumber}`,
  });
}

describe('dispatch recording', () => {
  beforeAll(() => {
    const dbPath = join(tmpdir(), `dispatch-router-test-${Date.now()}-${Math.random()}.db`);
    initDatabase(dbPath);
  });

  test('initDatabase rejects a relative path', () => {
    expect(() => initDatabase('./orchestrator.db')).toThrow();
  });

  test('insertDispatch records one row per spawn, keyed by its own id', () => {
    const ticket = makeTicket(1001);
    const dispatch = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 1,
      phase: 'implement',
      model: 'sonnet',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
      head_sha_before: 'abc123',
    });

    expect(dispatch.ticket_id).toBe(ticket.id);
    expect(dispatch.attempt_number).toBe(1);
    expect(dispatch.phase).toBe('implement');
    expect(dispatch.model).toBe('sonnet');
    expect(dispatch.mode).toBe('off');
    expect(dispatch.head_sha_before).toBe('abc123');
    expect(dispatch.head_sha_after).toBeNull();
    expect(dispatch.outcome).toBeNull();

    expect(getDispatchById(dispatch.id)?.id).toBe(dispatch.id);
  });

  test('completeDispatch fills in exit outcome fields', () => {
    const ticket = makeTicket(1002);
    const dispatch = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 1,
      phase: 'implement',
      model: 'sonnet',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
      head_sha_before: 'sha-before',
    });

    completeDispatch(dispatch.id, {
      exit_code: 0,
      head_sha_after: 'sha-after',
      cost_usd: 0.42,
      input_tokens: 100,
      output_tokens: 200,
      num_turns: 5,
      duration_ms: 12345,
      model: 'claude-sonnet-4-5',
    });

    const completed = getDispatchById(dispatch.id)!;
    expect(completed.exit_code).toBe(0);
    expect(completed.head_sha_after).toBe('sha-after');
    expect(completed.cost_usd).toBe(0.42);
    expect(completed.input_tokens).toBe(100);
    expect(completed.output_tokens).toBe(200);
    expect(completed.num_turns).toBe(5);
    expect(completed.duration_ms).toBe(12345);
    expect(completed.model).toBe('claude-sonnet-4-5');
    expect(completed.finished_at).not.toBeNull();
  });

  test('a null head_sha_after (nothing pushed) is preserved, not coerced', () => {
    const ticket = makeTicket(1003);
    const dispatch = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 1,
      phase: 'implement',
      model: 'opus',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
      head_sha_before: 'sha-1',
    });

    completeDispatch(dispatch.id, { exit_code: 1, head_sha_after: null });

    expect(getDispatchById(dispatch.id)?.head_sha_after).toBeNull();
  });

  test('getDispatchByTicketAndSha finds the attempt that produced a given commit', () => {
    const ticket = makeTicket(1004);
    const older = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 1,
      phase: 'implement',
      model: 'sonnet',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
    });
    completeDispatch(older.id, { exit_code: 0, head_sha_after: 'sha-old' });

    const newer = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 2,
      phase: 'implement',
      model: 'opus',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
    });
    completeDispatch(newer.id, { exit_code: 0, head_sha_after: 'sha-new' });

    expect(getDispatchByTicketAndSha(ticket.id, 'sha-new')?.id).toBe(newer.id);
    expect(getDispatchByTicketAndSha(ticket.id, 'sha-old')?.id).toBe(older.id);
    // bun:sqlite's .get() returns null (not undefined) for no match, same as
    // every other getXById in this file — matching runtime behavior, not the
    // (slightly optimistic) `| undefined` return type.
    expect(getDispatchByTicketAndSha(ticket.id, 'sha-missing')).toBeNull();
  });

  test('recordDispatchScore attributes a score to a specific attempt, not the ticket', () => {
    const ticket = makeTicket(1005);
    const dispatch = insertDispatch({
      ticket_id: ticket.id,
      attempt_number: 1,
      phase: 'implement',
      model: 'sonnet',
      rule: 'STATIC',
      mode: 'off',
      features: '{}',
    });

    recordDispatchScore(dispatch.id, 95, 5555);

    const scored = getDispatchById(dispatch.id)!;
    expect(scored.score).toBe(95);
    expect(scored.score_comment_id).toBe(5555);
    expect(scored.outcome).toBe('scored');
    expect(scored.scored_at).not.toBeNull();
  });

  test('attempt_number is recorded but is not unique per ticket (not a key)', () => {
    const ticket = makeTicket(1006);
    const first = insertDispatch({
      ticket_id: ticket.id, attempt_number: 1, phase: 'implement',
      model: 'sonnet', rule: 'STATIC', mode: 'off', features: '{}',
    });
    const second = insertDispatch({
      ticket_id: ticket.id, attempt_number: 1, phase: 'implement',
      model: 'sonnet', rule: 'STATIC', mode: 'off', features: '{}',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.attempt_number).toBe(second.attempt_number);
  });
});

describe('agent_logs text truncation (4KB cap)', () => {
  test('a long text row is truncated with a marker', () => {
    const ticket = makeTicket(2001);
    const long = 'x'.repeat(10_000);
    insertLog(ticket.id, 'text', long);

    const [row] = getLogsForTicket(ticket.id, 1);
    expect(row.content.length).toBeLessThan(long.length);
    expect(row.content).toContain('[truncated');
  });

  test('a short text row is stored verbatim', () => {
    const ticket = makeTicket(2002);
    insertLog(ticket.id, 'text', 'short line');

    const [row] = getLogsForTicket(ticket.id, 1);
    expect(row.content).toBe('short line');
  });

  test('non-text rows are never truncated, even when long', () => {
    const ticket = makeTicket(2003);
    const longJson = JSON.stringify({ data: 'y'.repeat(10_000) });
    insertLog(ticket.id, 'assistant', longJson);

    const [row] = getLogsForTicket(ticket.id, 1);
    expect(row.content).toBe(longJson);
  });
});

describe('getRecentLogsByType', () => {
  test('filters out other row types so they cannot crowd out the signal', () => {
    const ticket = makeTicket(2004);
    insertLog(ticket.id, 'assistant', JSON.stringify({ type: 'assistant' }));
    insertLog(ticket.id, 'stderr', 'ENOENT: no such file');
    insertLog(ticket.id, 'assistant', JSON.stringify({ type: 'assistant' }));
    insertLog(ticket.id, 'stderr', 'permission denied');

    const rows = getRecentLogsByType(ticket.id, 'stderr', 10);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.type === 'stderr')).toBe(true);
  });

  test('returns most-recent-first, capped at limit', () => {
    const ticket = makeTicket(2005);
    for (let i = 0; i < 5; i++) {
      insertLog(ticket.id, 'stderr', `line ${i}`);
    }

    const rows = getRecentLogsByType(ticket.id, 'stderr', 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].content).toBe('line 4');
    expect(rows[1].content).toBe('line 3');
  });

  test('empty when no rows of that type exist', () => {
    const ticket = makeTicket(2006);
    insertLog(ticket.id, 'text', 'not stderr');

    expect(getRecentLogsByType(ticket.id, 'stderr', 10)).toHaveLength(0);
  });
});
