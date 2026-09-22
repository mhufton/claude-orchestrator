/**
 * The refine phase: R6 (router.ts) routes a not-yet-ready ticket here instead of
 * straight to implementation. It runs the target repo's own `/refine-ticket #N`
 * command against the issue body — not a worktree, since there is no code to
 * change — and hands the ticket back to the gate rather than consuming an attempt.
 */
import { spawn } from 'bun';
import { join, dirname } from 'path';
import * as db from '../db';
import { loadConfig, CLAUDE_BIN } from '../config';
import { releaseSlot } from '../worktrees/pool';
import { broadcastAgentOutput, broadcastTicketUpdated, broadcastSlotStatus } from '../ws/handler';
import type { Ticket } from '../state/types';
import type { AgentResult } from './spawner';

const ORCHESTRATOR_BIN = join(dirname(dirname(import.meta.dir)), 'bin');

export async function runRefinePhase(ticket: Ticket, dispatchId: number): Promise<AgentResult> {
  const repoPath = loadConfig().paths.repoPath;
  const prompt = `/refine-ticket #${ticket.github_issue_number}`;

  console.log(`[refine] Running "${prompt}" for #${ticket.github_issue_number} in ${repoPath} (not a worktree — no code changes expected)`);

  const proc = spawn([
    CLAUDE_BIN,
    '--print',
    '--verbose',
    '--model', 'opus',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    cwd: repoPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PATH: `${ORCHESTRATOR_BIN}:${process.env.PATH}`,
    },
  });

  const stdoutReader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          db.insertLog(ticket.id, event.type || 'unknown', JSON.stringify(event));
          broadcastAgentOutput(ticket.id, { type: event.type || 'unknown', content: event });
        } catch {
          db.insertLog(ticket.id, 'text', line);
          broadcastAgentOutput(ticket.id, { type: 'text', content: line });
        }
      }
    }
  } catch (error) {
    console.error(`[refine] Error reading refine output for #${ticket.github_issue_number}:`, error);
  }

  const exitCode = await proc.exited;
  console.log(`[refine] "/refine-ticket #${ticket.github_issue_number}" exited with code ${exitCode}`);

  db.completeDispatch(dispatchId, {
    exit_code: exitCode,
    head_sha_after: null,
    model: 'opus',
    outcome: exitCode === 0 ? 'no_push' : 'crashed',
  });

  // Hand back to the gate: release the slot this attempt was given, undo the
  // attempt_count increment claimTicketForStart already applied (a refine does not
  // consume attempt_count), and return to backlog so the next cycle re-enters
  // decide() — where alreadyRefined now blocks R6 from firing twice.
  if (ticket.worktree_slot) {
    await releaseSlot(ticket.worktree_slot);
  }

  db.updateTicket(ticket.id, {
    state: 'backlog',
    worktree_slot: null,
    attempt_count: Math.max(0, ticket.attempt_count - 1),
    needs_attention: 0,
    attention_reason: null,
  });

  broadcastTicketUpdated(ticket.id, {
    state: 'backlog',
    worktree_slot: null,
    attempt_count: Math.max(0, ticket.attempt_count - 1),
    needs_attention: 0,
    attention_reason: null,
  });
  broadcastSlotStatus();

  return { success: exitCode === 0, exitCode, prCreated: false, prNumber: null };
}
