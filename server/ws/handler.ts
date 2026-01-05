import type { ServerWebSocket } from 'bun';
import * as db from '../db';
import { startTicket, stopTicket, retryTicket, archiveTicket } from '../state/machine';
import { getPR, getPRComments, getPRReviewComments, getCheckStatus, addLabelToIssue, getBranchHeadSha } from '../github/client';
import { syncIssues } from '../github/issues';
import { loadConfig } from '../config';
import { chat as dispatcherChat, stopDispatcher } from '../agents/dispatcher';
import { parseReviewScore } from '../github/score-parser';
import { getAllTicketTodos, stopAgent, spawnAgent, isAgentRunning } from '../agents/spawner';
import { runBatchReview } from '../agents/reviewer';
import { startAutoPlay, stopAutoPlay, isAutoPlayActive } from '../autoplay/loop';
import { getWorktreePath } from '../worktrees/manager';
import type { Ticket, WorktreeSlot, TicketState } from '../state/types';

// Track connected clients
const clients = new Set<ServerWebSocket<unknown>>();

export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

export function addClient(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);
}

export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
}

export function broadcast(message: ServerMessage): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    try {
      client.send(data);
    } catch {
      clients.delete(client);
    }
  }
}

export function sendToClient(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    clients.delete(ws);
  }
}

export async function handleMessage(ws: ServerWebSocket<unknown>, rawMessage: string): Promise<void> {
  let message: { type: string; [key: string]: unknown };

  try {
    message = JSON.parse(rawMessage);
  } catch {
    sendToClient(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  switch (message.type) {
    case 'start_ticket': {
      const ticketId = message.ticketId as number;
      const forceStart = message.force as boolean;

      // Check if pipeline is paused
      const pipelinePaused = db.getSyncState('pipeline_paused') === 'true';
      if (pipelinePaused && !forceStart) {
        const reason = db.getSyncState('pipeline_pause_reason') || 'Pipeline issue';
        sendToClient(ws, {
          type: 'error',
          message: `Pipeline is paused: ${reason}. Use force-start to override.`
        });
        break;
      }

      console.log(`Starting ticket ${ticketId}${forceStart ? ' (force)' : ''}`);
      const result = await startTicket(ticketId);
      if (!result.success) {
        sendToClient(ws, { type: 'error', message: result.error });
      }
      break;
    }

    case 'stop_ticket': {
      const ticketId = message.ticketId as number;
      console.log(`Stopping ticket ${ticketId}`);
      const result = await stopTicket(ticketId);
      if (!result.success) {
        sendToClient(ws, { type: 'error', message: result.error });
      }
      break;
    }

    case 'retry_ticket': {
      const ticketId = message.ticketId as number;
      const command = message.command as string | undefined;
      console.log(`Retrying ticket ${ticketId}${command ? ` with command: "${command.substring(0, 50)}..."` : ''}`);
      const result = await retryTicket(ticketId, command);
      if (!result.success) {
        sendToClient(ws, { type: 'error', message: result.error });
      }
      break;
    }

    case 'archive_ticket': {
      const ticketId = message.ticketId as number;
      console.log(`Archiving ticket ${ticketId}`);
      const result = await archiveTicket(ticketId);
      if (!result.success) {
        sendToClient(ws, { type: 'error', message: result.error });
      }
      break;
    }

    case 'get_logs': {
      const ticketId = message.ticketId as number;
      const limit = (message.limit as number) || 100;
      const logs = db.getLogsForTicket(ticketId, limit);
      sendToClient(ws, { type: 'logs', ticketId, logs });
      break;
    }

    case 'resolve_attention': {
      const ticketId = message.ticketId as number;
      const action = message.action as string;
      const ticket = db.getTicketById(ticketId);

      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      switch (action) {
        case 'done':
          db.updateTicket(ticketId, {
            state: 'done',
            needs_attention: 0,
            attention_reason: null,
            worktree_slot: null
          });
          broadcastTicketUpdated(ticketId, {
            state: 'done',
            needs_attention: false,
            attention_reason: null,
            worktree_slot: null
          });
          broadcastSlotStatus();
          break;

        case 'backlog':
          db.updateTicket(ticketId, {
            state: 'backlog',
            needs_attention: 0,
            attention_reason: null,
            worktree_slot: null
          });
          broadcastTicketUpdated(ticketId, {
            state: 'backlog',
            needs_attention: false,
            attention_reason: null,
            worktree_slot: null
          });
          broadcastSlotStatus();
          break;

        case 'dismiss':
          db.updateTicket(ticketId, {
            needs_attention: 0,
            attention_reason: null
          });
          broadcastTicketUpdated(ticketId, {
            needs_attention: false,
            attention_reason: null
          });
          break;

        default:
          sendToClient(ws, { type: 'error', message: `Unknown action: ${action}` });
      }
      break;
    }

    case 'get_pr_details': {
      const ticketId = message.ticketId as number;
      const ticket = db.getTicketById(ticketId);

      if (!ticket || !ticket.pr_number) {
        sendToClient(ws, { type: 'error', message: 'No PR found for ticket' });
        break;
      }

      try {
        const pr = await getPR(ticket.pr_number);
        const [comments, reviewComments, score] = await Promise.all([
          getPRComments(ticket.pr_number),
          getPRReviewComments(ticket.pr_number),
          parseReviewScore(ticket.pr_number)
        ]);

        // Check for bot review comments (inline code suggestions = issues found)
        const botReviewComments = reviewComments.filter(c =>
          c.user.login === 'github-actions[bot]'
        );
        const hasReviewIssues = botReviewComments.length > 0;

        // Try to get check status, but don't fail if we can't access it
        let ciStatus: 'pending' | 'success' | 'failure' | 'unknown' = 'unknown';
        try {
          // SAFETY: Verify branch HEAD matches PR head SHA to detect stale check data
          // If new commits were pushed, GitHub API may not have synced yet
          let shaIsFresh = true;
          try {
            const actualBranchSha = await getBranchHeadSha(pr.head.ref);
            if (actualBranchSha !== pr.head.sha) {
              console.log(`PR #${ticket.pr_number}: Branch HEAD (${actualBranchSha.slice(0, 7)}) differs from PR head (${pr.head.sha.slice(0, 7)}) - new commits detected`);
              shaIsFresh = false;
            }
          } catch (branchError) {
            console.warn(`Could not verify branch HEAD for ${pr.head.ref}:`, branchError);
            // Can't verify - be safe and treat as pending
            shaIsFresh = false;
          }

          if (!shaIsFresh) {
            // SHA is stale - new commits were pushed, treat as pending until API syncs
            ciStatus = 'pending';
          } else {
            const checkStatus = await getCheckStatus(pr.head.sha);
            if (checkStatus.pending) {
              ciStatus = 'pending';
            } else if (checkStatus.allPassed) {
              ciStatus = 'success';
            } else if (checkStatus.failures.length > 0) {
              ciStatus = 'failure';
            }
          }
        } catch (checkError) {
          console.warn('Could not fetch check status (token may lack permissions):', checkError instanceof Error ? checkError.message : checkError);
        }

        // Quality score < 90 counts as pipeline failure
        const SCORE_THRESHOLD = 90;
        if (score && score.total < SCORE_THRESHOLD && ciStatus !== 'pending') {
          ciStatus = 'failure';
        }

        // Inline review comments from bot = issues that need fixing
        if (hasReviewIssues && ciStatus !== 'pending') {
          ciStatus = 'failure';
        }

        sendToClient(ws, {
          type: 'pr_details',
          ticketId,
          prDetails: {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.merged ? 'merged' : pr.state,
            html_url: pr.html_url,
            created_at: (pr as unknown as { created_at: string }).created_at,
            updated_at: (pr as unknown as { updated_at: string }).updated_at,
            merged_at: (pr as unknown as { merged_at: string | null }).merged_at,
            reviewScore: score?.total ?? null,
            reviewComments: comments.map(c => ({
              id: c.id,
              author: c.user.login,
              body: c.body,
              created_at: c.created_at
            })),
            ciStatus
          }
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('Error fetching PR details:', errorMsg);
        sendToClient(ws, { type: 'error', message: `Failed to fetch PR details: ${errorMsg}` });
      }
      break;
    }

    case 'force_reset_ticket': {
      const ticketId = message.ticketId as number;
      console.log(`Force resetting ticket ${ticketId}`);
      const ticket = db.getTicketById(ticketId);

      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      // Stop any running agent first
      await stopTicket(ticketId);

      // Clear logs and chat messages for fresh start
      db.clearLogsForTicket(ticketId);
      db.clearChatMessagesForTicket(ticketId);

      // Reset ticket to backlog with cleared state
      db.updateTicket(ticketId, {
        state: 'backlog',
        worktree_slot: null,
        pr_number: null,
        pr_url: null,
        branch_name: null,
        current_score: null,
        attempt_count: 0,
        needs_attention: 0,
        attention_reason: null,
        retry_reason: null
      });

      broadcastTicketUpdated(ticketId, {
        state: 'backlog',
        worktree_slot: null,
        pr_number: null,
        pr_url: null,
        branch_name: null,
        current_score: null,
        attempt_count: 0,
        needs_attention: false,
        attention_reason: null,
        retry_reason: null
      });

      broadcastSlotStatus();
      console.log(`Ticket ${ticketId} force reset to backlog`);
      break;
    }

    case 'get_chat_messages': {
      const ticketId = message.ticketId as number;
      const messages = db.getChatMessagesForTicket(ticketId);
      sendToClient(ws, {
        type: 'chat_messages',
        ticketId,
        messages: messages.map(m => ({
          ...m,
          pending: Boolean(m.pending)
        }))
      });
      break;
    }

    case 'send_chat_message': {
      const ticketId = message.ticketId as number;
      const content = message.content as string;

      if (!content?.trim()) {
        sendToClient(ws, { type: 'error', message: 'Message content is required' });
        break;
      }

      const ticket = db.getTicketById(ticketId);
      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      // Messages are always queued and delivered on next agent restart
      // (Claude CLI --print mode doesn't support mid-conversation stdin input)
      const chatMessage = db.insertChatMessage(ticketId, 'user', content.trim(), true);

      // Broadcast to all clients
      broadcast({
        type: 'chat_message',
        ticketId,
        message: {
          ...chatMessage,
          pending: true
        }
      });

      console.log(`[chat] Message queued for ticket ${ticketId}: "${content.trim().slice(0, 50)}..."`);
      break;
    }

    case 'interrupt_for_message': {
      const ticketId = message.ticketId as number;
      console.log(`Interrupt requested for ticket ${ticketId} to deliver pending messages`);

      const ticket = db.getTicketById(ticketId);
      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      if (ticket.state !== 'in_progress') {
        sendToClient(ws, { type: 'error', message: 'Ticket is not in progress' });
        break;
      }

      // Check if agent is actually running
      if (!isAgentRunning(ticketId)) {
        sendToClient(ws, { type: 'error', message: 'No agent running for this ticket' });
        break;
      }

      // Check if there are pending messages to deliver
      const pendingMessages = db.getPendingChatMessages(ticketId);
      if (pendingMessages.length === 0) {
        sendToClient(ws, { type: 'error', message: 'No pending messages to deliver' });
        break;
      }

      // Stop the current agent
      const stopped = stopAgent(ticketId);
      if (!stopped) {
        sendToClient(ws, { type: 'error', message: 'Failed to stop agent' });
        break;
      }

      console.log(`Agent stopped for ticket ${ticketId}, respawning to deliver ${pendingMessages.length} message(s)`);

      // Increment attempt count to trigger retry context (which includes pending messages)
      db.updateTicket(ticketId, {
        attempt_count: ticket.attempt_count + 1,
        retry_reason: 'addressing_pr_comments' // Reuse this reason for user messages
      });

      broadcastTicketUpdated(ticketId, {
        attempt_count: ticket.attempt_count + 1,
        retry_reason: 'addressing_pr_comments'
      });

      // Respawn the agent - it will pick up pending messages via getRetryContext
      const updatedTicket = db.getTicketById(ticketId);
      if (updatedTicket) {
        spawnAgent(updatedTicket).catch(err => {
          console.error(`Failed to respawn agent for ticket ${ticketId}:`, err);
        });
      }

      // Notify client of success
      sendToClient(ws, { type: 'interrupt_success', ticketId });
      break;
    }

    case 'add_label': {
      const issueNumbers = message.issueNumbers as number[];
      const label = message.label as string;

      if (!issueNumbers || !Array.isArray(issueNumbers) || issueNumbers.length === 0) {
        sendToClient(ws, { type: 'error', message: 'No issue numbers provided' });
        break;
      }

      if (!label) {
        sendToClient(ws, { type: 'error', message: 'No label provided' });
        break;
      }

      console.log(`Adding label "${label}" to issues: ${issueNumbers.join(', ')}`);

      // Add labels in parallel
      const results = await Promise.all(
        issueNumbers.map(async (issueNumber) => {
          const success = await addLabelToIssue(issueNumber, label);
          return { issueNumber, success };
        })
      );

      const succeeded = results.filter(r => r.success).map(r => r.issueNumber);
      const failed = results.filter(r => !r.success).map(r => r.issueNumber);

      if (failed.length > 0) {
        sendToClient(ws, {
          type: 'label_result',
          succeeded,
          failed,
          message: `Added label to ${succeeded.length} issue(s), failed for ${failed.length}`
        });
      } else {
        sendToClient(ws, {
          type: 'label_result',
          succeeded,
          failed: [],
          message: `Added label "${label}" to ${succeeded.length} issue(s)`
        });
      }
      break;
    }

    case 'run_skill': {
      const skill = message.skill as string;
      const args = message.args as string | undefined;

      if (!skill) {
        sendToClient(ws, { type: 'error', message: 'No skill specified' });
        break;
      }

      // Log the skill request - actual execution happens in Claude Code
      console.log(`Skill request: /${skill}${args ? ` ${args}` : ''}`);
      sendToClient(ws, {
        type: 'skill_acknowledged',
        skill,
        args,
        message: `Skill /${skill} acknowledged. Execute in Claude Code terminal.`
      });
      break;
    }

    case 'sync_issues': {
      console.log('Manual issue sync triggered');
      try {
        const config = loadConfig();
        const result = await syncIssues(config.github.claudeReadyLabel);
        sendToClient(ws, {
          type: 'sync_result',
          ...result,
          message: `Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} removed`
        });
      } catch (error) {
        console.error('Manual sync failed:', error);
        sendToClient(ws, {
          type: 'error',
          message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
      break;
    }

    case 'dispatcher_chat': {
      const userMessage = message.message as string;
      const sessionId = message.sessionId as string | undefined;

      if (!userMessage?.trim()) {
        sendToClient(ws, { type: 'error', message: 'Empty message' });
        break;
      }

      console.log(`[WS] Dispatcher chat received: "${userMessage.slice(0, 50)}..."`);
      console.log(`[WS] Session ID: ${sessionId || 'none'}`);

      try {
        console.log('[WS] Calling dispatcherChat...');
        const response = await dispatcherChat(userMessage, sessionId);
        console.log('[WS] Got response from dispatcherChat, length:', response.length);
        console.log('[WS] Sending dispatcher_response to client...');
        sendToClient(ws, {
          type: 'dispatcher_response',
          message: response
        });
        console.log('[WS] dispatcher_response sent');
      } catch (error) {
        console.error('[WS] Dispatcher chat error:', error);
        sendToClient(ws, {
          type: 'dispatcher_response',
          message: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
      break;
    }

    case 'dispatcher_stop': {
      console.log('[WS] Dispatcher stop requested');
      const stopped = stopDispatcher();
      console.log('[WS] Dispatcher stopped:', stopped);
      break;
    }

    case 'pause_pipeline': {
      const reason = (message.reason as string) || 'Pipeline issue';
      console.log(`Pausing pipeline: ${reason}`);

      // Store pause state
      db.setSyncState('pipeline_paused', 'true');
      db.setSyncState('pipeline_pause_reason', reason);
      db.setSyncState('pipeline_paused_at', new Date().toISOString());

      // Stop all running agents
      const inProgressTickets = db.getTicketsByState('in_progress');
      for (const ticket of inProgressTickets) {
        if (isAgentRunning(ticket.id)) {
          console.log(`Stopping agent for ticket ${ticket.id} due to pipeline pause`);
          stopAgent(ticket.id);
        }
      }

      // Broadcast to all clients
      broadcast({
        type: 'pipeline_paused',
        reason,
        pausedAt: new Date().toISOString()
      });

      sendToClient(ws, { type: 'pause_success', reason });
      break;
    }

    case 'resume_pipeline': {
      console.log('Resuming pipeline');

      // Clear pause state
      db.setSyncState('pipeline_paused', 'false');
      db.setSyncState('pipeline_pause_reason', '');

      // Broadcast to all clients
      broadcast({ type: 'pipeline_resumed' });

      sendToClient(ws, { type: 'resume_success' });
      break;
    }

    case 'get_pipeline_status': {
      const paused = db.getSyncState('pipeline_paused') === 'true';
      const reason = db.getSyncState('pipeline_pause_reason') || '';
      const pausedAt = db.getSyncState('pipeline_paused_at') || '';

      sendToClient(ws, {
        type: 'pipeline_status',
        paused,
        reason,
        pausedAt
      });
      break;
    }

    case 'enable_autoplay': {
      console.log('[ws] Enabling auto-play');
      const settings = db.getSettings();
      db.saveSettings({ ...settings, autoPlayEnabled: true });
      startAutoPlay();
      sendToClient(ws, { type: 'autoplay_enabled' });
      break;
    }

    case 'disable_autoplay': {
      console.log('[ws] Disabling auto-play');
      const settings = db.getSettings();
      db.saveSettings({ ...settings, autoPlayEnabled: false });
      stopAutoPlay();
      sendToClient(ws, { type: 'autoplay_disabled' });
      break;
    }

    case 'get_autoplay_status': {
      const settings = db.getSettings();
      sendToClient(ws, {
        type: 'autoplay_status',
        enabled: settings.autoPlayEnabled,
        active: isAutoPlayActive(),
        intervalMs: settings.autoPlayIntervalMs
      });
      break;
    }

    case 'batch_review': {
      const ticketIds = message.ticketIds as number[];
      const issueNumbers = message.issueNumbers as number[];

      if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
        sendToClient(ws, { type: 'error', message: 'No tickets selected for review' });
        break;
      }

      if (!issueNumbers || !Array.isArray(issueNumbers) || issueNumbers.length !== ticketIds.length) {
        sendToClient(ws, { type: 'error', message: 'Invalid issue numbers' });
        break;
      }

      console.log(`Batch review requested for ${ticketIds.length} tickets: issues #${issueNumbers.join(', #')}`);

      // Run the batch review asynchronously (don't await - let it run in background)
      runBatchReview(ticketIds, issueNumbers).catch(error => {
        console.error('Batch review failed:', error);
        broadcast({
          type: 'review_error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      });

      // Immediately acknowledge the request
      sendToClient(ws, {
        type: 'batch_review_started',
        ticketIds,
        issueNumbers
      });
      break;
    }

    case 'get_review': {
      const ticketId = message.ticketId as number;
      const review = db.getLatestReviewForTicket(ticketId);

      if (review) {
        sendToClient(ws, {
          type: 'review_result',
          ticketId,
          review: {
            ...review,
            gaps: JSON.parse(review.gaps || '[]')
          }
        });
      } else {
        sendToClient(ws, {
          type: 'review_result',
          ticketId,
          review: null
        });
      }
      break;
    }

    case 'get_commits': {
      const ticketId = message.ticketId as number;
      const ticket = db.getTicketById(ticketId);

      if (!ticket) {
        sendToClient(ws, { type: 'error', ticketId, message: 'Ticket not found' });
        break;
      }

      // Need worktree slot to find the git repo
      if (!ticket.worktree_slot) {
        sendToClient(ws, {
          type: 'commits',
          ticketId,
          commits: [],
          message: 'No worktree assigned'
        });
        break;
      }

      try {
        const worktreePath = getWorktreePath(ticket.worktree_slot);

        // Get commits with files changed info
        // Format: hash|author|date|subject|files
        const gitLogProc = Bun.spawnSync({
          cmd: [
            'git', 'log',
            '--pretty=format:%h|%an|%ar|%s',
            '--name-status',
            '-20', // Last 20 commits
            'HEAD'
          ],
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe'
        });

        if (gitLogProc.exitCode !== 0) {
          const stderr = gitLogProc.stderr.toString();
          console.error(`git log failed for ticket ${ticketId}:`, stderr);
          sendToClient(ws, {
            type: 'commits',
            ticketId,
            commits: [],
            message: 'Failed to get commits'
          });
          break;
        }

        const output = gitLogProc.stdout.toString().trim();
        const commits: Array<{
          hash: string;
          author: string;
          date: string;
          message: string;
          files: Array<{ status: string; path: string }>;
        }> = [];

        // Parse git log output
        const lines = output.split('\n');
        let currentCommit: typeof commits[0] | null = null;

        for (const line of lines) {
          if (line.includes('|')) {
            // This is a commit line
            if (currentCommit) {
              commits.push(currentCommit);
            }
            const [hash, author, date, ...messageParts] = line.split('|');
            currentCommit = {
              hash,
              author,
              date,
              message: messageParts.join('|'), // In case message has |
              files: []
            };
          } else if (line.trim() && currentCommit) {
            // This is a file status line (e.g., "M\tpath/to/file.ts")
            const match = line.match(/^([AMDRC])\t(.+)$/);
            if (match) {
              const statusMap: Record<string, string> = {
                'A': 'added',
                'M': 'modified',
                'D': 'deleted',
                'R': 'renamed',
                'C': 'copied'
              };
              currentCommit.files.push({
                status: statusMap[match[1]] || match[1],
                path: match[2]
              });
            }
          }
        }

        // Don't forget the last commit
        if (currentCommit) {
          commits.push(currentCommit);
        }

        sendToClient(ws, {
          type: 'commits',
          ticketId,
          commits,
          branchName: ticket.branch_name
        });
      } catch (error) {
        console.error(`Error getting commits for ticket ${ticketId}:`, error);
        sendToClient(ws, {
          type: 'commits',
          ticketId,
          commits: [],
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      break;
    }

    case 'set_priority': {
      const ticketId = message.ticketId as number;
      const priority = message.priority as 'high' | 'medium' | 'low';

      if (!['high', 'medium', 'low'].includes(priority)) {
        sendToClient(ws, { type: 'error', message: 'Invalid priority value' });
        break;
      }

      const ticket = db.getTicketById(ticketId);
      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      db.updateTicket(ticketId, { priority });
      broadcastTicketUpdated(ticketId, { priority });
      console.log(`Set priority for ticket ${ticketId} to ${priority}`);
      break;
    }

    case 'reorder_tickets': {
      const state = message.state as string;
      const ticketIds = message.ticketIds as number[];

      if (!ticketIds || !Array.isArray(ticketIds)) {
        sendToClient(ws, { type: 'error', message: 'Invalid ticket IDs' });
        break;
      }

      db.reorderTicketsInColumn(state as TicketState, ticketIds);
      broadcast({
        type: 'tickets_reordered',
        state,
        ticketIds
      });
      console.log(`Reordered ${ticketIds.length} tickets in ${state} column`);
      break;
    }

    case 'move_ticket': {
      const ticketId = message.ticketId as number;
      const toState = message.toState as string;
      const toIndex = message.toIndex as number | undefined;

      const ticket = db.getTicketById(ticketId);
      if (!ticket) {
        sendToClient(ws, { type: 'error', message: 'Ticket not found' });
        break;
      }

      // Handle state transitions with appropriate actions
      if (toState === 'in_progress' && ticket.state === 'backlog') {
        // Moving to in_progress triggers start
        const result = await startTicket(ticketId);
        if (!result.success) {
          sendToClient(ws, { type: 'error', message: result.error });
        }
      } else if (toState === 'backlog' && ticket.state === 'in_progress') {
        // Moving from in_progress to backlog triggers stop
        const result = await stopTicket(ticketId);
        if (!result.success) {
          sendToClient(ws, { type: 'error', message: result.error });
        }
      } else if (toState === 'backlog' && ticket.state === 'needs_review') {
        // Approving: needs_review -> backlog
        db.updateTicket(ticketId, { state: 'backlog', position: toIndex ?? 0 });
        broadcastTicketUpdated(ticketId, { state: 'backlog', position: toIndex ?? 0 });
      } else if (toState === 'done') {
        // Archive
        const result = await archiveTicket(ticketId);
        if (!result.success) {
          sendToClient(ws, { type: 'error', message: result.error });
        }
      } else {
        // Generic state change
        db.updateTicket(ticketId, { state: toState as TicketState, position: toIndex ?? 0 });
        broadcastTicketUpdated(ticketId, { state: toState, position: toIndex ?? 0 });
      }
      break;
    }

    case 'get_dependencies': {
      const ticketId = message.ticketId as number;
      const deps = db.getDependenciesForTicket(ticketId);
      sendToClient(ws, {
        type: 'dependencies',
        ticketId,
        ...deps
      });
      break;
    }

    case 'update_settings': {
      const settings = message.settings as { maxAgentSlots?: number; maxParallelReviews?: number };
      const updated = db.saveSettings(settings);
      broadcast({
        type: 'settings_updated',
        settings: updated
      });
      // Broadcast updated slot status since maxAgentSlots may have changed
      broadcastSlotStatus();
      console.log('Settings updated:', updated);
      break;
    }

    default:
      sendToClient(ws, { type: 'error', message: `Unknown message type: ${message.type}` });
  }
}

export function sendInitialState(ws: ServerWebSocket<unknown>, config: { owner: string; repo: string; label: string }): void {
  const tickets = db.getAllTickets();
  const slots = db.getSlotStatus();

  // Get recent logs for in-progress tickets
  const agentLogs: Record<number, Array<{ type: string; content: unknown }>> = {};
  for (const ticket of tickets) {
    if (ticket.state === 'in_progress') {
      const logs = db.getLogsForTicket(ticket.id, 200); // Last 200 logs
      agentLogs[ticket.id] = logs.map(log => ({
        type: log.type,
        content: (() => {
          try { return JSON.parse(log.content); }
          catch { return log.content; }
        })()
      }));
    }
  }

  // Get current todos for in-progress tickets
  const ticketTodosMap = getAllTicketTodos();
  const agentTodos: Record<number, AgentTodo[]> = {};
  for (const [ticketId, todos] of ticketTodosMap) {
    agentTodos[ticketId] = todos;
  }

  // Get pipeline pause status
  const pipelinePaused = db.getSyncState('pipeline_paused') === 'true';
  const pipelinePauseReason = db.getSyncState('pipeline_pause_reason') || '';
  const pipelinePausedAt = db.getSyncState('pipeline_paused_at') || '';

  // Get orchestrator settings
  const settings = db.getSettings();

  sendToClient(ws, {
    type: 'init',
    tickets: tickets.map(t => ({
      ...t,
      labels: JSON.parse(t.labels || '[]')
    })),
    slots,
    agentLogs,
    agentTodos,
    config: {
      repoOwner: config.owner,
      repoName: config.repo,
      claudeReadyLabel: config.label
    },
    pipelineStatus: {
      paused: pipelinePaused,
      reason: pipelinePauseReason,
      pausedAt: pipelinePausedAt
    },
    autoplayStatus: {
      enabled: settings.autoPlayEnabled,
      active: isAutoPlayActive(),
      intervalMs: settings.autoPlayIntervalMs
    },
    settings
  });
}

// Helper to broadcast ticket updates
export function broadcastTicketCreated(ticket: Ticket): void {
  broadcast({
    type: 'ticket_created',
    ticket: {
      ...ticket,
      labels: JSON.parse(ticket.labels || '[]')
    }
  });
}

export function broadcastTicketUpdated(ticketId: number, changes: Partial<Ticket>): void {
  broadcast({
    type: 'ticket_updated',
    ticketId,
    changes
  });
}

export function broadcastSlotStatus(): void {
  broadcast({
    type: 'worktree_status',
    slots: db.getSlotStatus()
  });
}

export function broadcastAgentOutput(ticketId: number, event: { type: string; content: string }): void {
  broadcast({
    type: 'agent_output',
    ticketId,
    event: {
      ...event,
      timestamp: new Date().toISOString()
    }
  });
}

export interface AgentContext {
  retryReason: string | null;
  previousScore: number | null;
  ciFailures: string[];
  inlineComments: string[];
  hasMergeConflicts: boolean;
  userMessages: string[];
  summary: string;
}

export function broadcastAgentContext(ticketId: number, context: AgentContext): void {
  broadcast({
    type: 'agent_context',
    ticketId,
    context
  });
}

export interface AgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export function broadcastAgentTodos(ticketId: number, todos: AgentTodo[]): void {
  broadcast({
    type: 'agent_todos',
    ticketId,
    todos
  });
}

export function broadcastChatMessagesDelivered(ticketId: number): void {
  broadcast({
    type: 'chat_messages_delivered',
    ticketId
  });
}
