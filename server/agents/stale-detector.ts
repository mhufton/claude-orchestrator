import * as db from '../db';
import { broadcastTicketUpdated } from '../ws/handler';
import { isAgentRunning, spawnAgent } from './spawner';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes for "stalled" detection
const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
// No limit on auto-restart attempts - truly self-healing
// The attempt_count is still tracked for visibility but doesn't block restarts

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
      // Limit auto-restarts to prevent infinite loops on genuinely stuck tickets
      // Should match MAX_AUTO_ATTEMPTS in pr-watcher.ts
      const MAX_AUTO_RESTARTS = 15;
      if (ticket.attempt_count >= MAX_AUTO_RESTARTS) {
        console.log(`[stale-detector] Ticket #${ticket.github_issue_number} hit ${MAX_AUTO_RESTARTS} attempts, flagging for review`);
        db.updateTicket(ticket.id, {
          needs_attention: 1,
          attention_reason: `Stuck after ${ticket.attempt_count} attempts - needs manual review`
        });
        broadcastTicketUpdated(ticket.id, {
          needs_attention: true,
          attention_reason: `Stuck after ${ticket.attempt_count} attempts - needs manual review`
        });
        continue;
      }

      console.log(`[self-heal] Agent for ticket #${ticket.github_issue_number} not running, auto-respawning (attempt ${ticket.attempt_count + 1})`);

      db.updateTicket(ticket.id, {
        attempt_count: ticket.attempt_count + 1,
        retry_reason: 'agent_interrupted',
        needs_attention: 0,
        attention_reason: null
      });

      broadcastTicketUpdated(ticket.id, {
        attempt_count: ticket.attempt_count + 1,
        retry_reason: 'agent_interrupted',
        needs_attention: false,
        attention_reason: null
      });

      // Respawn the agent
      try {
        const updatedTicket = db.getTicketById(ticket.id);
        if (updatedTicket) {
          await spawnAgent(updatedTicket);
        }
      } catch (err) {
        console.error(`[self-heal] Failed to respawn agent for ticket ${ticket.id}:`, err);
      }
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
      const reason = `Agent appears stalled - no activity for ${inactiveMinutes} minutes`;

      console.log(`[stale-detector] Ticket #${ticket.github_issue_number}: ${reason}`);

      db.updateTicket(ticket.id, {
        needs_attention: 1,
        attention_reason: reason
      });

      broadcastTicketUpdated(ticket.id, {
        needs_attention: true,
        attention_reason: reason
      });
    }
  }
}
