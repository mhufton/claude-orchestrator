import { spawn, type Subprocess } from 'bun';
import { join, dirname } from 'path';
import * as db from '../db';
import { getWorktreePath } from '../worktrees/manager';
import { buildBatchAgentPrompt } from './prompts';
import { broadcastAgentOutput, broadcastAgentTodos, broadcastSlotStatus, type AgentTodo } from '../ws/handler';
import { moveBatchToReview, failBatch } from '../state/machine';
import { getPRsForBranch, getPRsForBranchPrefix, getPRsForMultipleIssues } from '../github/client';
import type { Batch, Ticket } from '../state/types';

// Path to orchestrator bin directory (for queue-run and other tools)
const ORCHESTRATOR_BIN = join(dirname(dirname(import.meta.dir)), 'bin');

// Track running batch agents
const runningBatchAgents = new Map<number, Subprocess>();

// Spawn lock for batches
const spawningBatches = new Set<number>();

export interface BatchAgentResult {
  success: boolean;
  exitCode: number | null;
  prCreated: boolean;
  prNumber: number | null;
}

/**
 * Extract TodoWrite calls from a parsed event
 */
function extractTodosFromEvent(event: unknown): AgentTodo[] | null {
  if (typeof event !== 'object' || event === null) return null;

  const obj = event as Record<string, unknown>;

  // Check for message.content array (Claude CLI format)
  const message = obj.message as { content?: Array<{ type: string; name?: string; input?: unknown }> } | undefined;
  if (message?.content && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const input = block.input as { todos?: AgentTodo[] } | undefined;
        if (input?.todos && Array.isArray(input.todos)) {
          return input.todos;
        }
      }
    }
  }

  return null;
}

/**
 * Select model for batch agent
 * Uses opus if any ticket has use-opus label, otherwise sonnet
 */
function selectBatchModel(tickets: Ticket[]): 'opus' | 'sonnet' {
  for (const ticket of tickets) {
    try {
      const labels: string[] = JSON.parse(ticket.labels || '[]');
      if (labels.includes('use-opus')) {
        console.log(`[batch-model] Using opus (ticket #${ticket.github_issue_number} has use-opus label)`);
        return 'opus';
      }
    } catch {
      // Ignore parse errors
    }
  }

  console.log('[batch-model] Using sonnet (default for batches)');
  return 'sonnet';
}

/**
 * Spawn an agent to work on a batch of tickets
 */
export async function spawnBatchAgent(batch: Batch, tickets: Ticket[]): Promise<BatchAgentResult> {
  const slot = batch.worktree_slot;
  if (!slot) {
    throw new Error('Batch has no worktree slot assigned');
  }

  // Spawn lock
  if (spawningBatches.has(batch.id)) {
    console.log(`[batch-spawn] Spawn already in progress for batch ${batch.id}, skipping`);
    return { success: false, exitCode: null, prCreated: false, prNumber: null };
  }

  if (runningBatchAgents.has(batch.id)) {
    console.log(`[batch-spawn] Agent already running for batch ${batch.id}, skipping`);
    return { success: false, exitCode: null, prCreated: false, prNumber: null };
  }

  spawningBatches.add(batch.id);

  try {
    const worktreePath = getWorktreePath(slot);
    const prompt = buildBatchAgentPrompt(batch, tickets);
    const model = selectBatchModel(tickets);

    console.log(`[batch] Spawning agent for batch ${batch.id} (${tickets.length} tickets) in slot ${slot}`);
    console.log(`[batch] Worktree: ${worktreePath}`);
    console.log(`[batch] Model: ${model}`);

    const proc = spawn([
      '/opt/homebrew/bin/claude',
      '--print',
      '--verbose',
      '--model', model,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '-p', prompt
    ], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PWD: worktreePath,
        PATH: `${ORCHESTRATOR_BIN}:${process.env.PATH}`,
        WORKTREE_SLOT: String(slot),
        ORCHESTRATOR_URL: `http://localhost:${process.env.PORT || 3456}`,
        BATCH_ID: String(batch.id),
        BATCH_ISSUES: tickets.map(t => t.github_issue_number).join(',')
      }
    });

    runningBatchAgents.set(batch.id, proc);

    // Stream stdout to all tickets in batch
    const stdoutReader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const event = JSON.parse(line);

            // Log to database for all tickets in batch
            for (const ticket of tickets) {
              db.insertLog(ticket.id, event.type || 'unknown', JSON.stringify(event));
            }

            // Broadcast to all tickets in batch
            for (const ticket of tickets) {
              broadcastAgentOutput(ticket.id, {
                type: event.type || 'unknown',
                content: event
              });
            }

            // Check for TodoWrite and broadcast to first ticket (representative)
            const todos = extractTodosFromEvent(event);
            if (todos && tickets.length > 0) {
              broadcastAgentTodos(tickets[0].id, todos);
              db.saveTodosForTicket(tickets[0].id, batch.attempt_count || 1, todos.map(t => ({
                content: t.content,
                status: t.status
              })));
            }
          } catch {
            // Not JSON, treat as plain text
            for (const ticket of tickets) {
              db.insertLog(ticket.id, 'text', line);
              broadcastAgentOutput(ticket.id, { type: 'text', content: line });
            }
          }
        }
      }
    } catch (error) {
      console.error('[batch] Error reading agent stdout:', error);
    }

    // Wait for process to complete
    const exitCode = await proc.exited;
    runningBatchAgents.delete(batch.id);

    console.log(`[batch] Agent for batch ${batch.id} exited with code ${exitCode}`);

    // Capture handoff notes
    const handoffPath = `${worktreePath}/.claude-handoff.md`;
    try {
      const handoffFile = Bun.file(handoffPath);
      if (await handoffFile.exists()) {
        const handoffContent = await handoffFile.text();
        if (handoffContent.trim()) {
          // Store handoff notes in first ticket (representative)
          if (tickets.length > 0) {
            db.updateTicket(tickets[0].id, { handoff_notes: handoffContent });
          }
          console.log(`[batch] Captured handoff notes for batch ${batch.id} (${handoffContent.length} chars)`);

          // Clean up the file
          await Bun.write(handoffPath, '');
          const { $ } = await import('bun');
          await $`cd ${worktreePath} && git checkout -- .claude-handoff.md 2>/dev/null || rm -f .claude-handoff.md`.quiet();
        }
      }
    } catch (err) {
      console.warn(`[batch] Could not capture handoff notes for batch ${batch.id}:`, err);
    }

    // Check if a PR was created for this batch
    const { prCreated, prNumber } = await checkForBatchPR(batch, tickets);

    if (prCreated && prNumber) {
      const prUrl = `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/${prNumber}`;
      moveBatchToReview(batch.id, prNumber, prUrl);

      return { success: true, exitCode, prCreated: true, prNumber };
    } else {
      // No PR created
      if (exitCode !== 0) {
        console.log(`[batch] Agent for batch ${batch.id} exited with non-zero code ${exitCode} and no PR created`);
        await failBatch(batch.id, `Agent exited with code ${exitCode} without creating PR`);
      } else {
        console.log(`[batch] Agent for batch ${batch.id} completed but no PR found - flagging for attention`);
        db.updateBatch(batch.id, {
          needs_attention: 1,
          attention_reason: 'Agent completed without creating a PR'
        });
      }

      return { success: false, exitCode, prCreated: false, prNumber: null };
    }
  } finally {
    spawningBatches.delete(batch.id);
  }
}

/**
 * Check if a PR was created for this batch
 */
async function checkForBatchPR(batch: Batch, tickets: Ticket[]): Promise<{ prCreated: boolean; prNumber: number | null }> {
  // Try by batch branch name first
  if (batch.branch_name) {
    try {
      const prs = await getPRsForBranch(batch.branch_name);
      if (prs.length > 0) {
        console.log(`[batch] Found PR #${prs[0].number} by exact branch match`);
        return { prCreated: true, prNumber: prs[0].number };
      }
    } catch (err) {
      console.warn(`[batch] Error checking PRs by branch:`, err);
    }

    // Try prefix match
    try {
      const prs = await getPRsForBranchPrefix(`claude/batch-${batch.id}`);
      if (prs.length > 0) {
        console.log(`[batch] Found PR #${prs[0].number} by branch prefix match`);
        return { prCreated: true, prNumber: prs[0].number };
      }
    } catch (err) {
      console.warn(`[batch] Error checking PRs by prefix:`, err);
    }
  }

  // Fallback: search for PR that closes all issues in the batch
  if (tickets.length > 0) {
    try {
      const issueNumbers = tickets.map(t => t.github_issue_number);
      const prs = await getPRsForMultipleIssues(issueNumbers);
      if (prs.length > 0) {
        console.log(`[batch] Found PR #${prs[0].number} by multi-issue search`);
        return { prCreated: true, prNumber: prs[0].number };
      }
    } catch (err) {
      console.warn(`[batch] Error checking PRs by multi-issue search:`, err);
    }
  }

  return { prCreated: false, prNumber: null };
}

/**
 * Stop a batch agent
 */
export function stopBatchAgent(batchId: number): void {
  const proc = runningBatchAgents.get(batchId);
  if (proc) {
    console.log(`[batch] Stopping agent for batch ${batchId}`);
    proc.kill();
    runningBatchAgents.delete(batchId);
  }
}

/**
 * Check if a batch agent is running
 */
export function isBatchAgentRunning(batchId: number): boolean {
  return runningBatchAgents.has(batchId);
}
