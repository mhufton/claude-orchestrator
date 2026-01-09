import { spawn, type Subprocess } from 'bun';
import { join, dirname } from 'path';
import * as db from '../db';
import { getWorktreePath } from '../worktrees/manager';
import { buildAgentPrompt } from './prompts';
import { broadcastAgentOutput, broadcastTicketUpdated, broadcastAgentTodos, broadcastChatMessagesDelivered, broadcastAgentContext, broadcastSlotStatus, type AgentTodo } from '../ws/handler';
import { getPRsForBranch, getPRsForBranchPrefix, getPRsForIssue, getIssue, getPR } from '../github/client';
import { getRetryContext } from '../github/pr-watcher';
import { diagnoseWorktree, isStuck, runRecovery, forceResetWorktree } from '../worktrees/recovery';
import { tryAcquireRespawnLock } from './respawn-coordinator';
import type { Ticket } from '../state/types';

// Path to orchestrator bin directory (for queue-run and other tools)
const ORCHESTRATOR_BIN = join(dirname(dirname(import.meta.dir)), 'bin');

// Track current todos for each ticket
const ticketTodos = new Map<number, AgentTodo[]>();

// Track current context for each ticket (what the agent is working on)
export interface AgentContext {
  retryReason: string | null;
  previousScore: number | null;
  ciFailures: string[];
  inlineComments: string[];
  hasMergeConflicts: boolean;
  userMessages: string[];
  summary: string; // Human-readable summary
}
const ticketContexts = new Map<number, AgentContext>();

export function getTicketContext(ticketId: number): AgentContext | undefined {
  return ticketContexts.get(ticketId);
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

  // Direct tool_use format
  if (obj.type === 'tool_use' && obj.name === 'TodoWrite') {
    const input = obj.input as { todos?: AgentTodo[] } | undefined;
    if (input?.todos && Array.isArray(input.todos)) {
      return input.todos;
    }
  }

  return null;
}

// Track running agents and their session IDs for continuing conversations
const runningAgents = new Map<number, Subprocess>();
const agentSessionIds = new Map<number, string>();

// Spawn lock: prevents race conditions where multiple systems try to spawn the same agent
// This is a synchronous check - if spawn is in progress, skip
const spawningAgents = new Set<number>();

export interface AgentResult {
  success: boolean;
  exitCode: number | null;
  prCreated: boolean;
  prNumber: number | null;
}

/**
 * Determine which model to use based on labels and attempt count
 * - use-opus label: always use opus
 * - use-sonnet label: always use sonnet
 * - No label: sonnet for attempt 1, opus for 2+ (escalate early to avoid loops)
 */
function selectModel(ticket: Ticket): 'opus' | 'sonnet' {
  // Parse labels from JSON string
  let labels: string[] = [];
  try {
    labels = JSON.parse(ticket.labels || '[]');
  } catch {
    labels = [];
  }

  // Check for explicit model labels
  if (labels.includes('use-opus')) {
    console.log(`[model] Using opus for #${ticket.github_issue_number} (use-opus label)`);
    return 'opus';
  }
  if (labels.includes('use-sonnet')) {
    console.log(`[model] Using sonnet for #${ticket.github_issue_number} (use-sonnet label)`);
    return 'sonnet';
  }

  // Default: sonnet for attempts 1-2, opus for 3+ to balance cost vs capability
  // Sonnet with rich retry context can solve most issues - only escalate if truly stuck
  if (ticket.attempt_count >= 3) {
    console.log(`[model] Using opus for #${ticket.github_issue_number} (attempt ${ticket.attempt_count} >= 3, escalating after sonnet retries)`);
    return 'opus';
  }

  console.log(`[model] Using sonnet for #${ticket.github_issue_number} (attempt ${ticket.attempt_count})`);
  return 'sonnet';
}

/**
 * Continue an agent conversation with a user message
 * This is called when the agent finishes and there are pending chat messages
 */
async function continueAgentConversation(
  ticket: Ticket,
  sessionId: string,
  userMessage: string,
  worktreePath: string,
  model: 'opus' | 'sonnet'
): Promise<void> {
  console.log(`[agent] Continuing conversation for ticket #${ticket.github_issue_number} with user message`);

  const proc = spawn([
    '/opt/homebrew/bin/claude',  // Full path required - Bun spawn doesn't use env.PATH
    '--print',
    '--verbose',
    '--model', model,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--resume', sessionId,
    '-p', userMessage
  ], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PWD: worktreePath,
      PATH: `${ORCHESTRATOR_BIN}:${process.env.PATH}`,
      WORKTREE_SLOT: String(ticket.worktree_slot),
      ORCHESTRATOR_URL: `http://localhost:${process.env.PORT || 3456}`
    }
  });

  runningAgents.set(ticket.id, proc);

  // Auto-clear needs_attention since agent is now running
  if (ticket.needs_attention) {
    console.log(`[agent] Auto-clearing needs_attention for #${ticket.github_issue_number} (batch agent started)`);
    db.updateTicket(ticket.id, {
      needs_attention: 0,
      attention_reason: null
    });
    broadcastTicketUpdated(ticket.id, {
      needs_attention: 0,
      attention_reason: null
    });
  }

  // Stream stdout (same as main agent)
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

          db.insertLog(ticket.id, event.type || 'unknown', JSON.stringify(event));
          broadcastAgentOutput(ticket.id, {
            type: event.type || 'unknown',
            content: event
          });

          const todos = extractTodosFromEvent(event);
          if (todos) {
            ticketTodos.set(ticket.id, todos);
            broadcastAgentTodos(ticket.id, todos);
            db.saveTodosForTicket(ticket.id, ticket.attempt_count || 1, todos.map(t => ({
              content: t.content,
              status: t.status
            })));
          }
        } catch {
          db.insertLog(ticket.id, 'text', line);
          broadcastAgentOutput(ticket.id, { type: 'text', content: line });
        }
      }
    }
  } catch (error) {
    console.error('Error reading continued agent stdout:', error);
  }

  const exitCode = await proc.exited;
  runningAgents.delete(ticket.id);

  console.log(`[agent] Continued conversation for ticket #${ticket.github_issue_number} exited with code ${exitCode}`);

  // Check for more pending messages (recursive)
  const morePendingMessages = db.getPendingChatMessages(ticket.id);
  if (morePendingMessages.length > 0) {
    console.log(`[agent] Found ${morePendingMessages.length} more pending message(s), continuing again...`);
    const combinedMessage = morePendingMessages.map(m => m.content).join('\n\n');
    db.markChatMessagesDelivered(ticket.id);
    broadcastChatMessagesDelivered(ticket.id);
    await continueAgentConversation(ticket, sessionId, combinedMessage, worktreePath, model);
  }
}

export async function spawnAgent(ticket: Ticket): Promise<AgentResult> {
  const slot = ticket.worktree_slot;
  if (!slot) {
    throw new Error('Ticket has no worktree slot assigned');
  }

  // SPAWN LOCK: Prevent race conditions where multiple systems spawn the same agent
  // This happens when stale-detector, spawner self-heal, and pr-watcher all detect
  // "agent not running" at the same time
  if (spawningAgents.has(ticket.id)) {
    console.log(`[spawn-lock] Spawn already in progress for ticket #${ticket.github_issue_number}, skipping`);
    return {
      success: false,
      exitCode: null,
      prCreated: false,
      prNumber: null
    };
  }

  // Also check if agent is already running
  if (runningAgents.has(ticket.id)) {
    console.log(`[spawn-lock] Agent already running for ticket #${ticket.github_issue_number}, skipping`);
    return {
      success: false,
      exitCode: null,
      prCreated: false,
      prNumber: null
    };
  }

  // Acquire spawn lock
  spawningAgents.add(ticket.id);
  console.log(`[spawn-lock] Acquired lock for ticket #${ticket.github_issue_number}`);

  try {
  // Pre-spawn checks: Don't spawn if issue is already resolved
  try {
    const issue = await getIssue(ticket.github_issue_number);

    // Check 1: Issue already closed
    if (issue.state === 'closed') {
      console.log(`[agent] Issue #${ticket.github_issue_number} is already closed on GitHub - moving to done`);

      db.updateTicket(ticket.id, {
        state: 'done',
        worktree_slot: null,
        needs_attention: 0,
        attention_reason: null
      });

      broadcastTicketUpdated(ticket.id, {
        state: 'done',
        worktree_slot: null,
        needs_attention: 0,
        attention_reason: null
      });

      broadcastSlotStatus();

      return {
        success: true,
        exitCode: 0,
        prCreated: false,
        prNumber: null
      };
    }

    // Check 2: Issue has skip labels (wontfix, invalid, duplicate)
    const skipLabels = ['wontfix', 'won\'t fix', 'invalid', 'duplicate'];
    const issueLabels = issue.labels.map(l => l.name.toLowerCase());
    const hasSkipLabel = skipLabels.some(skip => issueLabels.includes(skip));

    if (hasSkipLabel) {
      console.log(`[agent] Issue #${ticket.github_issue_number} has skip label - moving to done`);

      db.updateTicket(ticket.id, {
        state: 'done',
        worktree_slot: null,
        needs_attention: 0,
        attention_reason: null
      });

      broadcastTicketUpdated(ticket.id, {
        state: 'done',
        worktree_slot: null,
        needs_attention: 0,
        attention_reason: null
      });

      broadcastSlotStatus();

      return {
        success: true,
        exitCode: 0,
        prCreated: false,
        prNumber: null
      };
    }
  } catch (err) {
    console.warn(`[agent] Could not check issue state for #${ticket.github_issue_number}:`, err);
    // Continue with spawn - don't block on this check
  }

  // Check 3: PR already merged
  if (ticket.pr_number) {
    try {
      const pr = await getPR(ticket.pr_number);
      if (pr.merged) {
        console.log(`[agent] PR #${ticket.pr_number} for issue #${ticket.github_issue_number} is already merged - moving to done`);

        db.updateTicket(ticket.id, {
          state: 'done',
          worktree_slot: null,
          needs_attention: 0,
          attention_reason: null
        });

        broadcastTicketUpdated(ticket.id, {
          state: 'done',
          worktree_slot: null,
          needs_attention: 0,
          attention_reason: null
        });

        broadcastSlotStatus();

        return {
          success: true,
          exitCode: 0,
          prCreated: true,
          prNumber: ticket.pr_number
        };
      }
    } catch (err) {
      console.warn(`[agent] Could not check PR state for #${ticket.pr_number}:`, err);
      // Continue with spawn - don't block on this check
    }
  }

  const worktreePath = getWorktreePath(slot);

  // Check if worktree is in a stuck state (mid-rebase, conflicts, etc.)
  const worktreeState = await diagnoseWorktree(slot);

  // Check if worktree doesn't exist - this is a critical error state
  if (!worktreeState.exists) {
    console.error(`[agent] Worktree slot ${slot} for ticket #${ticket.github_issue_number} does not exist! Attempting to create...`);

    // Try to create the worktree
    const branchName = ticket.branch_name || `claude/${ticket.github_issue_number}`;
    try {
      const { createWorktree } = await import('../worktrees/manager');
      await createWorktree(slot, branchName);
      console.log(`[agent] Successfully created worktree for slot ${slot}`);

      // Update ticket with branch name if it wasn't set
      if (!ticket.branch_name) {
        db.updateTicket(ticket.id, { branch_name: branchName });
      }
    } catch (createError) {
      console.error(`[agent] Failed to create worktree for slot ${slot}:`, createError);

      // Release the slot and move ticket back to backlog
      db.updateTicket(ticket.id, {
        state: 'backlog',
        worktree_slot: null,
        needs_attention: 1,
        attention_reason: `Worktree creation failed: ${createError instanceof Error ? createError.message : 'Unknown error'}`
      });

      broadcastTicketUpdated(ticket.id, {
        state: 'backlog',
        worktree_slot: null,
        needs_attention: 1,
        attention_reason: `Worktree creation failed: ${createError instanceof Error ? createError.message : 'Unknown error'}`
      });

      broadcastSlotStatus();

      return {
        success: false,
        exitCode: 1,
        prCreated: false,
        prNumber: null
      };
    }
  }

  if (isStuck(worktreeState)) {
    console.log(`[agent] Worktree for ticket #${ticket.github_issue_number} is stuck, running Opus recovery...`);

    // Broadcast recovery status
    broadcastAgentOutput(ticket.id, {
      type: 'recovery',
      content: `Worktree stuck (${worktreeState.isMidRebase ? 'mid-rebase' : worktreeState.isMidMerge ? 'mid-merge' : 'conflict markers'}), running Opus-powered recovery...`
    });

    const recoveryResult = await runRecovery(
      slot,
      ticket.id,
      ticket.title,
      ticket.github_issue_number,
      (chunk) => {
        broadcastAgentOutput(ticket.id, {
          type: 'recovery_output',
          content: chunk
        });
      }
    );

    if (!recoveryResult.success) {
      console.log(`[agent] Opus recovery failed, attempting force reset...`);

      broadcastAgentOutput(ticket.id, {
        type: 'recovery',
        content: 'Opus recovery failed, force resetting worktree to clean state...'
      });

      const resetSuccess = await forceResetWorktree(slot);

      if (!resetSuccess) {
        // Flag for human attention
        db.updateTicket(ticket.id, {
          needs_attention: 1,
          attention_reason: 'Worktree stuck and recovery failed - manual intervention needed'
        });
        broadcastTicketUpdated(ticket.id, {
          needs_attention: 1,
          attention_reason: 'Worktree stuck and recovery failed - manual intervention needed'
        });

        return {
          success: false,
          exitCode: 1,
          prCreated: false,
          prNumber: null
        };
      }

      broadcastAgentOutput(ticket.id, {
        type: 'recovery',
        content: 'Force reset complete. Worktree is now clean.'
      });
    } else {
      broadcastAgentOutput(ticket.id, {
        type: 'recovery',
        content: 'Recovery successful. Continuing with normal agent work.'
      });
    }
  }

  // Get retry context if this is not the first attempt
  let context;
  if (ticket.attempt_count > 1) {
    // attempt_count is incremented before spawn, so > 1 means it's a retry
    context = await getRetryContext(ticket);

    // Log what context we're giving the agent
    console.log(`[agent] Retry context for ticket #${ticket.github_issue_number}:`);
    console.log(`  - CI failures: ${context.ciFailures.length}`);
    console.log(`  - Inline comments: ${context.inlineComments.length}`);
    console.log(`  - Merge conflicts: ${context.hasMergeConflicts}`);
    console.log(`  - Previous score: ${context.previousScore}`);
    console.log(`  - User messages: ${context.userMessages.length}`);
    console.log(`  - Recent errors: ${context.recentErrors.length}`);
    console.log(`  - Files modified: ${context.filesModified.length}`);
    if (context.ciFailures.length > 0) {
      console.log(`  - CI failure details: ${context.ciFailures[0].slice(0, 200)}...`);
    }
    if (context.recentErrors.length > 0) {
      console.log(`  - Recent error: ${context.recentErrors[0].slice(0, 150)}...`);
    }
    if (context.agentIntent) {
      console.log(`  - Agent intent: ${context.agentIntent.slice(0, 100)}...`);
    }

    // Build and broadcast agent context for UI
    const issues: string[] = [];
    if (context.hasMergeConflicts) issues.push('Merge conflicts');
    if (context.ciFailures.length > 0) issues.push(`${context.ciFailures.length} CI failure(s)`);
    if (context.inlineComments.length > 0) issues.push(`${context.inlineComments.length} review comment(s)`);
    if (context.userMessages.length > 0) issues.push(`${context.userMessages.length} user message(s)`);

    const agentContext: AgentContext = {
      retryReason: ticket.retry_reason,
      previousScore: context.previousScore,
      ciFailures: context.ciFailures,
      inlineComments: context.inlineComments,
      hasMergeConflicts: context.hasMergeConflicts,
      userMessages: context.userMessages,
      summary: issues.length > 0
        ? `Working on: ${issues.join(', ')}`
        : 'Retrying previous work'
    };

    // Store and broadcast context
    ticketContexts.set(ticket.id, agentContext);
    broadcastAgentContext(ticket.id, agentContext);
  } else {
    // Clear any previous context for fresh starts
    ticketContexts.delete(ticket.id);
  }

  const prompt = buildAgentPrompt(ticket, context);

  // Select model based on labels and attempt count
  const model = selectModel(ticket);

  console.log(`Spawning agent for ticket #${ticket.github_issue_number} in slot ${slot}`);
  console.log(`Worktree: ${worktreePath}`);
  console.log(`Model: ${model}`);

  const proc = spawn([
    '/opt/homebrew/bin/claude',  // Full path required - Bun spawn doesn't use env.PATH
    '--print',
    '--verbose',
    '--model', model,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',  // Allow autonomous file operations
    '-p', prompt
  ], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PWD: worktreePath,
      PATH: `${ORCHESTRATOR_BIN}:${process.env.PATH}`,
      WORKTREE_SLOT: String(ticket.worktree_slot),
      ORCHESTRATOR_URL: `http://localhost:${process.env.PORT || 3456}`
    }
  });

  runningAgents.set(ticket.id, proc);

  // Auto-clear needs_attention since agent is now running
  if (ticket.needs_attention) {
    console.log(`[agent] Auto-clearing needs_attention for #${ticket.github_issue_number} (agent started)`);
    db.updateTicket(ticket.id, {
      needs_attention: 0,
      attention_reason: null
    });
    broadcastTicketUpdated(ticket.id, {
      needs_attention: 0,
      attention_reason: null
    });
  }

  // Stream stdout
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

          // Extract session ID from init event
          if (event.type === 'system' && event.sessionId) {
            agentSessionIds.set(ticket.id, event.sessionId);
            console.log(`[agent] Session ID for ticket ${ticket.id}: ${event.sessionId}`);
          }

          // Log to database
          db.insertLog(ticket.id, event.type || 'unknown', JSON.stringify(event));

          // Broadcast to connected clients with full structured event
          broadcastAgentOutput(ticket.id, {
            type: event.type || 'unknown',
            content: event  // Send full event for rich rendering
          });

          // Check for TodoWrite calls and broadcast them
          const todos = extractTodosFromEvent(event);
          if (todos) {
            ticketTodos.set(ticket.id, todos);
            broadcastAgentTodos(ticket.id, todos);
            // Persist to database
            db.saveTodosForTicket(ticket.id, ticket.attempt_count || 1, todos.map(t => ({
              content: t.content,
              status: t.status
            })));
          }
        } catch {
          // Not JSON, treat as plain text
          db.insertLog(ticket.id, 'text', line);
          broadcastAgentOutput(ticket.id, { type: 'text', content: line });
        }
      }
    }
  } catch (error) {
    console.error('Error reading agent stdout:', error);
  }

  // Wait for process to complete
  const exitCode = await proc.exited;
  runningAgents.delete(ticket.id);

  console.log(`Agent for ticket #${ticket.github_issue_number} exited with code ${exitCode}`);

  // Capture handoff notes from the worktree if they exist
  const handoffPath = `${worktreePath}/.claude-handoff.md`;
  try {
    const handoffFile = Bun.file(handoffPath);
    if (await handoffFile.exists()) {
      const handoffContent = await handoffFile.text();
      if (handoffContent.trim()) {
        db.updateTicket(ticket.id, { handoff_notes: handoffContent });
        console.log(`[agent] Captured handoff notes for ticket #${ticket.github_issue_number} (${handoffContent.length} chars)`);

        // Clean up the file so it's not committed
        await Bun.write(handoffPath, '');
        const { $ } = await import('bun');
        await $`cd ${worktreePath} && git checkout -- .claude-handoff.md 2>/dev/null || rm -f .claude-handoff.md`.quiet();
      }
    }
  } catch (err) {
    console.warn(`[agent] Could not capture handoff notes for ticket #${ticket.github_issue_number}:`, err);
  }

  // Check for pending chat messages and continue if any
  const sessionId = agentSessionIds.get(ticket.id);
  if (sessionId) {
    const pendingMessages = db.getPendingChatMessages(ticket.id);
    if (pendingMessages.length > 0) {
      console.log(`[agent] Found ${pendingMessages.length} pending chat message(s) for ticket ${ticket.id}, continuing conversation...`);

      // Combine pending messages into one
      const combinedMessage = pendingMessages.map(m => m.content).join('\n\n');

      // Mark messages as delivered and broadcast to UI
      db.markChatMessagesDelivered(ticket.id);
      broadcastChatMessagesDelivered(ticket.id);

      // Continue the conversation with the user's messages
      await continueAgentConversation(ticket, sessionId, combinedMessage, worktreePath, model);
    }
  }

  // Check if a PR was created
  const { prCreated, prNumber, actualBranch } = await checkForPR(ticket);

  if (prCreated && prNumber) {
    const updates: Record<string, unknown> = {
      state: 'in_review',
      pr_number: prNumber,
      pr_url: `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/${prNumber}`,
      needs_attention: 0,
      attention_reason: null
    };

    // Update branch_name if agent used a different branch than expected
    if (actualBranch && actualBranch !== ticket.branch_name) {
      updates.branch_name = actualBranch;
      console.log(`[agent] Updated branch_name from "${ticket.branch_name}" to "${actualBranch}"`);
    }

    db.updateTicket(ticket.id, updates);

    broadcastTicketUpdated(ticket.id, {
      state: 'in_review',
      pr_number: prNumber,
      pr_url: `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/${prNumber}`,
      needs_attention: 0,
      attention_reason: null,
      ...(actualBranch ? { branch_name: actualBranch } : {})
    });
  } else {
    // Agent finished but no PR
    const MAX_AUTO_ATTEMPTS = 3; // Unified with pr-watcher.ts

    if (exitCode !== 0 && ticket.attempt_count < MAX_AUTO_ATTEMPTS) {
      // Non-zero exit code - auto-respawn (self-healing)
      // Check if another component already triggered a respawn
      if (!tryAcquireRespawnLock(ticket.id, 'spawner:self-heal')) {
        console.log(`[self-heal] Skipping respawn for ticket #${ticket.github_issue_number} - respawn already in progress`);
        return {
          success: false,
          exitCode,
          prCreated: false,
          prNumber: null
        };
      }

      const nextAttempt = ticket.attempt_count + 1;

      // Exponential backoff: attempt 1 = 2s, attempt 2 = 30s, attempt 3 = 2min
      const backoffDelays = [2000, 30000, 120000];
      const delayMs = backoffDelays[Math.min(ticket.attempt_count, backoffDelays.length - 1)];
      const delayDesc = delayMs >= 60000 ? `${delayMs / 60000}min` : `${delayMs / 1000}s`;

      console.log(`[self-heal] Agent for ticket #${ticket.github_issue_number} exited with code ${exitCode}, respawning in ${delayDesc} (attempt ${nextAttempt}/${MAX_AUTO_ATTEMPTS})`);

      db.updateTicket(ticket.id, {
        attempt_count: nextAttempt,
        retry_reason: 'fixing_ci'
      });

      broadcastTicketUpdated(ticket.id, {
        attempt_count: nextAttempt,
        retry_reason: 'fixing_ci'
      });

      // Auto-respawn after backoff delay
      setTimeout(() => {
        const updatedTicket = db.getTicketById(ticket.id);
        if (updatedTicket && updatedTicket.state === 'in_progress') {
          spawnAgent(updatedTicket).catch(err => {
            console.error(`[self-heal] Failed to respawn agent for ticket ${ticket.id}:`, err);
          });
        }
      }, delayMs);
    } else {
      // Either exitCode 0 with no PR, or max attempts reached - flag for attention
      const reason = exitCode === 0
        ? 'Agent completed without creating a PR'
        : `Agent failed after ${ticket.attempt_count} attempts (exit code ${exitCode})`;

      db.updateTicket(ticket.id, {
        needs_attention: 1,
        attention_reason: reason
      });

      broadcastTicketUpdated(ticket.id, {
        needs_attention: 1,
        attention_reason: reason
      });

      console.log(`Ticket #${ticket.github_issue_number} flagged for attention: ${reason}`);
    }
  }

  return {
    success: exitCode === 0,
    exitCode,
    prCreated,
    prNumber
  };
  } finally {
    // Release spawn lock
    spawningAgents.delete(ticket.id);
    console.log(`[spawn-lock] Released lock for ticket #${ticket.github_issue_number}`);
  }
}

async function checkForPR(ticket: Ticket): Promise<{ prCreated: boolean; prNumber: number | null; actualBranch?: string }> {
  // First, try by exact branch name (fastest)
  if (ticket.branch_name) {
    try {
      const prs = await getPRsForBranch(ticket.branch_name);

      if (prs.length > 0) {
        const pr = prs[0];
        console.log(`[checkForPR] Found PR #${pr.number} by branch name: ${ticket.branch_name}`);
        return { prCreated: true, prNumber: pr.number, actualBranch: pr.head.ref };
      }
    } catch (error) {
      console.error('Error checking for PR by branch:', error);
    }
  }

  // Second: search by branch prefix (agent might have added suffix like claude/1443-description)
  const branchPrefix = `claude/${ticket.github_issue_number}`;
  try {
    const prs = await getPRsForBranchPrefix(branchPrefix);

    if (prs.length > 0) {
      const pr = prs[0];
      console.log(`[checkForPR] Found PR #${pr.number} by branch prefix: ${branchPrefix}* (actual: ${pr.head.ref})`);
      return { prCreated: true, prNumber: pr.number, actualBranch: pr.head.ref };
    }
  } catch (error) {
    console.error('Error checking for PR by branch prefix:', error);
  }

  // Third fallback: search by issue number in PR body
  try {
    const prs = await getPRsForIssue(ticket.github_issue_number);

    if (prs.length > 0) {
      const pr = prs[0];
      console.log(`[checkForPR] Found PR #${pr.number} by issue reference: #${ticket.github_issue_number}`);
      return { prCreated: true, prNumber: pr.number, actualBranch: pr.head.ref };
    }
  } catch (error) {
    console.error('Error checking for PR by issue:', error);
  }

  console.log(`[checkForPR] No PR found for ticket #${ticket.github_issue_number}`);
  return { prCreated: false, prNumber: null };
}

export function stopAgent(ticketId: number): boolean {
  const proc = runningAgents.get(ticketId);

  if (!proc) {
    return false;
  }

  try {
    proc.kill();
    runningAgents.delete(ticketId);
    return true;
  } catch (error) {
    console.error('Error stopping agent:', error);
    return false;
  }
}


export function isAgentRunning(ticketId: number): boolean {
  const proc = runningAgents.get(ticketId);
  if (!proc) return false;

  // Check if the process is actually still alive
  // Bun's Subprocess has exitCode property - null while running, number when done
  try {
    if (proc.exitCode !== null) {
      // Process has exited but wasn't cleaned up - fix the stale entry
      console.log(`[isAgentRunning] Cleaning up stale process entry for ticket ${ticketId} (exitCode: ${proc.exitCode})`);
      runningAgents.delete(ticketId);
      return false;
    }

    // Double-check: verify PID actually exists at OS level
    // proc.exitCode can be null even after process dies if we haven't awaited proc.exited
    const pid = proc.pid;
    if (pid) {
      try {
        // process.kill(pid, 0) throws if process doesn't exist
        process.kill(pid, 0);
      } catch {
        // Process doesn't exist - clean up stale entry
        console.log(`[isAgentRunning] PID ${pid} no longer exists for ticket ${ticketId}, cleaning up`);
        runningAgents.delete(ticketId);
        return false;
      }
    }

    return true;
  } catch {
    // If we can't check, assume it's dead and clean up
    console.log(`[isAgentRunning] Error checking process for ticket ${ticketId}, assuming dead`);
    runningAgents.delete(ticketId);
    return false;
  }
}

export function getRunningAgentCount(): number {
  return runningAgents.size;
}

export function getTicketTodos(ticketId: number): AgentTodo[] | undefined {
  return ticketTodos.get(ticketId);
}

export function getAllTicketTodos(): Map<number, AgentTodo[]> {
  // Merge in-memory todos with database todos
  // In-memory takes precedence (more recent)
  const dbTodos = db.getAllTodosGroupedByTicket();

  for (const [ticketIdStr, todos] of Object.entries(dbTodos)) {
    const ticketId = parseInt(ticketIdStr);
    // Only use DB todos if not in memory
    if (!ticketTodos.has(ticketId)) {
      ticketTodos.set(ticketId, todos.map(t => ({
        content: t.content,
        status: t.status as 'pending' | 'in_progress' | 'completed',
        activeForm: t.content // Use content as activeForm for DB-loaded todos
      })));
    }
  }

  return ticketTodos;
}

export function loadTodosFromDatabase(): void {
  const dbTodos = db.getAllTodosGroupedByTicket();

  for (const [ticketIdStr, todos] of Object.entries(dbTodos)) {
    const ticketId = parseInt(ticketIdStr);
    // Get latest attempt todos only
    const latestAttempt = Math.max(...todos.map(t => t.attempt_number));
    const latestTodos = todos.filter(t => t.attempt_number === latestAttempt);

    ticketTodos.set(ticketId, latestTodos.map(t => ({
      content: t.content,
      status: t.status as 'pending' | 'in_progress' | 'completed',
      activeForm: t.content
    })));
  }

  console.log(`Loaded todos for ${Object.keys(dbTodos).length} tickets from database`);
}

export function stopAllAgents(): void {
  for (const [ticketId, proc] of runningAgents) {
    try {
      proc.kill();
    } catch (error) {
      console.error(`Error stopping agent for ticket ${ticketId}:`, error);
    }
  }
  runningAgents.clear();
}
