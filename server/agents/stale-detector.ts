import * as db from '../db';
import { logStateTransition } from '../db';
import { broadcastTicketUpdated } from '../ws/handler';
import { isAgentRunning, spawnAgent } from './spawner';
import { tryAcquireRespawnLock } from './respawn-coordinator';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes for "stalled" detection
const QUEUE_WAIT_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes max queue wait before flagging
const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
// No limit on auto-restart attempts - truly self-healing
// The attempt_count is still tracked for visibility but doesn't block restarts

// Check if a slot has a command waiting in the queue
function getQueueStatusForSlot(slot: number): { waiting: boolean; position: number; waitingMs: number } | null {
  const status = db.getCommandQueueStatus();

  // Find any waiting or running command for this slot
  const slotCommands = status.queue.filter(cmd => cmd.slot === slot);
  if (slotCommands.length === 0) return null;

  const waitingCmd = slotCommands.find(cmd => cmd.status === 'waiting');
  if (!waitingCmd) return null;

  // Calculate position in queue (how many ahead of this one)
  const position = status.queue.filter(cmd =>
    cmd.status === 'waiting' &&
    new Date(cmd.requested_at).getTime() < new Date(waitingCmd.requested_at).getTime()
  ).length;

  // How long has it been waiting?
  const waitingMs = Date.now() - new Date(waitingCmd.requested_at).getTime();

  return { waiting: true, position, waitingMs };
}

export function startStaleAgentDetector(intervalMs: number = CHECK_INTERVAL_MS): void {
  setInterval(() => {
    checkForStaleAgents();
  }, intervalMs);

  // Also run immediately on start
  checkForStaleAgents();
}

async function checkForStaleAgents(): Promise<void> {
  const inProgressTickets = db.getTicketsByState('in_progress');

  if (inProgressTickets.length > 0) {
    console.log(`[stale-detector] Checking ${inProgressTickets.length} in_progress tickets: ${inProgressTickets.map(t => `#${t.github_issue_number}`).join(', ')}`);
  }

  for (const ticket of inProgressTickets) {
    // Check if agent process is still tracked as running
    const processRunning = isAgentRunning(ticket.id);
    console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: processRunning=${processRunning}, attempts=${ticket.attempt_count}, needs_attention=${ticket.needs_attention}`);

    // Only skip if explicitly marked as needing HUMAN intervention (stuck after many attempts)
    // CI failures, merge conflicts, etc. are work the agent should TRY to fix
    if (ticket.needs_attention && ticket.attention_reason) {
      const reason = ticket.attention_reason.toLowerCase();
      // Only skip if it's explicitly marked as stuck/failed after max attempts
      const needsHumanIntervention = reason.includes('stuck after') ||
                                     reason.includes('failed after') ||
                                     reason.includes('needs manual');
      if (needsHumanIntervention) {
        console.log(`[stale-detector] Ticket #${ticket.github_issue_number} needs human intervention: ${ticket.attention_reason}`);
        continue; // Skip - truly stuck
      }
    }

    // FIRST: If process is NOT running, respawn (self-healing for crashes)
    if (!processRunning) {
      // Check if another component (pr-watcher, spawner) already triggered a respawn
      if (!tryAcquireRespawnLock(ticket.id, 'stale-detector')) {
        console.log(`[stale-detector] Skipping ticket #${ticket.github_issue_number} - respawn already in progress`);
        continue;
      }

      // SMART CHECK: Don't flag as stuck if there's work happening
      // - CI is running or passing → work is progressing
      // - PR exists → agent did its job, waiting for review/merge
      const hasActiveCI = ticket.ci_status === 'running' || ticket.ci_status === 'passing';
      const hasPR = ticket.pr_number !== null;

      if (hasActiveCI || hasPR) {
        console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: Agent not running but work in progress (CI: ${ticket.ci_status}, PR: ${ticket.pr_number ? '#' + ticket.pr_number : 'none'})`);
        // Don't increment attempts or flag - just let pr-watcher handle it
        continue;
      }

      // Limit auto-restarts to prevent infinite loops on genuinely stuck tickets
      const MAX_AUTO_RESTARTS = 3;
      if (ticket.attempt_count >= MAX_AUTO_RESTARTS) {
        // Only flag if NO work is happening
        console.log(`[stale-detector] Ticket #${ticket.github_issue_number} hit ${MAX_AUTO_RESTARTS} attempts with no PR, flagging for review`);
        db.updateTicket(ticket.id, {
          needs_attention: 1,
          attention_reason: `Stuck after ${ticket.attempt_count} attempts with no PR - needs manual review`
        });
        broadcastTicketUpdated(ticket.id, {
          needs_attention: 1,
          attention_reason: `Stuck after ${ticket.attempt_count} attempts with no PR - needs manual review`
        });
        continue;
      }

      // Exponential backoff: attempt 1 = 2s, attempt 2 = 30s, attempt 3 = 2min
      const backoffDelays = [2000, 30000, 120000];
      const delayMs = backoffDelays[Math.min(ticket.attempt_count, backoffDelays.length - 1)];
      const delayDesc = delayMs >= 60000 ? `${delayMs / 60000}min` : `${delayMs / 1000}s`;

      const newAttemptCount = ticket.attempt_count + 1;
      console.log(`[stale-detector] Agent for ticket #${ticket.github_issue_number} not running, respawning in ${delayDesc} (attempt ${newAttemptCount}/${MAX_AUTO_RESTARTS})`);

      // Log state transition for debugging
      logStateTransition(
        ticket.id,
        ticket.github_issue_number,
        'attempt_count',
        ticket.attempt_count,
        newAttemptCount,
        'stale-detector',
        'agent process not running'
      );

      db.updateTicket(ticket.id, {
        attempt_count: newAttemptCount,
        retry_reason: 'agent_interrupted',
        needs_attention: 0,
        attention_reason: null
      });

      broadcastTicketUpdated(ticket.id, {
        attempt_count: newAttemptCount,
        retry_reason: 'agent_interrupted',
        needs_attention: 0,
        attention_reason: null
      });

      // Respawn the agent after backoff delay
      const ticketId = ticket.id;
      setTimeout(async () => {
        try {
          const updatedTicket = db.getTicketById(ticketId);
          if (updatedTicket && updatedTicket.state === 'in_progress') {
            await spawnAgent(updatedTicket);
          }
        } catch (err) {
          console.error(`[stale-detector] Failed to respawn agent for ticket ${ticketId}:`, err);
        }
      }, delayMs);
      continue; // Done with this ticket
    }

    // SECOND: Process IS running - check if it's stalled (no activity for too long)
    const logs = db.getLogsForTicket(ticket.id, 1);
    const lastLog = logs[0];

    if (!lastLog) {
      // No logs yet but process is running - might be just starting, give it time
      continue;
    }

    const lastActivity = new Date(lastLog.timestamp).getTime();
    const now = Date.now();
    const inactiveMs = now - lastActivity;

    if (inactiveMs > STALE_THRESHOLD_MS) {
      const inactiveMinutes = Math.round(inactiveMs / 60000);

      // Check if this agent is waiting in the command queue
      if (ticket.worktree_slot) {
        const queueStatus = getQueueStatusForSlot(ticket.worktree_slot);

        if (queueStatus?.waiting) {
          // Agent is waiting in queue - this is expected, not a stall
          const queueMinutes = Math.round(queueStatus.waitingMs / 60000);

          // Only flag if waiting excessively long (likely stuck)
          if (queueStatus.waitingMs > QUEUE_WAIT_THRESHOLD_MS) {
            const reason = `Agent waiting in queue for ${queueMinutes} minutes (position ${queueStatus.position + 1}) - may be stuck`;
            console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: ${reason}`);

            db.updateTicket(ticket.id, {
              needs_attention: 1,
              attention_reason: reason
            });

            broadcastTicketUpdated(ticket.id, {
              needs_attention: 1,
              attention_reason: reason
            });
          } else {
            // Normal queue wait - just log it, don't flag
            console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: Waiting in queue (position ${queueStatus.position + 1}, ${queueMinutes}min) - not flagging as stalled`);
          }
          continue; // Skip normal stale handling
        }
      }

      // Not waiting in queue - this is a real stall
      const reason = `Agent appears stalled - no activity for ${inactiveMinutes} minutes`;

      console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: ${reason}`);

      db.updateTicket(ticket.id, {
        needs_attention: 1,
        attention_reason: reason
      });

      broadcastTicketUpdated(ticket.id, {
        needs_attention: 1,
        attention_reason: reason
      });
    }
  }
}
