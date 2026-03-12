import { loadConfig } from './config';
import {
  initDatabase,
  getAllTickets,
  getSlotStatus,
  enqueueCommand,
  getQueuePosition,
  canStartCommand,
  startCommand,
  completeCommand,
  cancelCommand,
  getCommandQueueStatus,
  cancelStaleCommands,
  cleanupOldQueueEntries,
  getTicketById
} from './db';
import { initGitHubClient } from './github/client';
import { startIssueSyncLoop } from './github/issues';
import { startPRWatchLoop } from './github/pr-watcher';
import { startBranchUpdateLoop } from './github/branch-updater';
import { initWorktreeManager } from './worktrees/manager';
import { stopAllAgents, loadTodosFromDatabase } from './agents/spawner';
import { startStaleAgentDetector } from './agents/stale-detector';
import { stopAllReviews } from './agents/reviewer';
import { initAutoPlay, stopAutoPlay } from './autoplay/loop';
import { startStatusBroadcast, stopStatusBroadcast } from './poll-status';
import { startEpicChecker, stopEpicChecker } from './epics/detector';
import { runStartupCollisionCheck } from './startup/collision-check';
import { startMergeQueueProcessor, stopMergeQueueProcessor } from './merge-queue/processor';
import * as mergeQueue from './merge-queue/manager';
import {
  addClient,
  removeClient,
  handleMessage,
  sendInitialState,
  broadcast
} from './ws/handler';

// Load config (will throw if required env vars missing)
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error('Configuration error:', error);
  console.log('\nMake sure you have a .env file with required variables.');
  console.log('See .env.example for the template.\n');
  process.exit(1);
}

// Initialize database
initDatabase('./orchestrator.db');
console.log('Database initialized');

// Load persisted todos from database
loadTodosFromDatabase();

// Clear any stale review state from previous run
stopAllReviews();
console.log('Cleared stale review state');

// Initialize GitHub client
initGitHubClient(
  config.github.token,
  config.github.owner,
  config.github.repo
);
console.log('GitHub client initialized');

// Initialize worktree manager
initWorktreeManager(config.paths.repoPath, config.paths.worktreeDir);
console.log('Worktree manager initialized');

// Run startup collision check before starting main loops
(async () => {
  console.log('\nRunning startup collision check...');
  const safeToStart = await runStartupCollisionCheck({ autoFix: true, flagRemaining: true });

  if (!safeToStart) {
    console.log('\n⚠️  Some tickets require attention before orchestrator can safely proceed.');
    console.log('   Check the UI or database for tickets flagged with needs_attention=1');
    console.log('   The orchestrator will continue, but those tickets will not auto-respawn.\n');
  }

  // Start GitHub issue sync
  startIssueSyncLoop(config.github.claudeReadyLabel, config.intervals.issueSync);
  console.log(`Issue sync started (every ${config.intervals.issueSync / 1000}s)`);

  // Start PR watcher
  startPRWatchLoop(config.intervals.prWatch);
  console.log(`PR watcher started (every ${config.intervals.prWatch / 1000}s)`);

  // Start proactive branch updater - keeps PR branches in sync with dev
  startBranchUpdateLoop();
  console.log('Branch updater started (60s interval)');

  // Start poll status broadcast (for UI countdowns)
  startStatusBroadcast();
  console.log('Poll status broadcast started');

  // Start stale agent detector - checks every 30s, auto-respawns dead agents immediately
  startStaleAgentDetector();
  console.log('Stale agent detector started (30s check interval, auto-respawn enabled)');

  // Initialize auto-play if it was enabled
  initAutoPlay();

  // Start epic completion checker (checks every 5 minutes)
  startEpicChecker(300000);
  console.log('Epic completion checker started (5 min interval)');

  // Start merge queue processor (checks every 10 seconds)
  startMergeQueueProcessor();
  console.log('Merge queue processor started (10s interval)');

  // Start command queue cleanup (runs every 5 minutes)
  setInterval(() => {
    // Cancel commands that have been running for >30 minutes (likely orphaned)
    const stale = cancelStaleCommands(30);
    if (stale > 0) {
      console.log(`[queue-cleanup] Cancelled ${stale} stale running commands`);
    }

    // Delete old completed/cancelled entries (older than 1 hour)
    const deleted = cleanupOldQueueEntries(1);
    if (deleted > 0) {
      console.log(`[queue-cleanup] Deleted ${deleted} old queue entries`);
    }
  }, 300000); // 5 minutes
  console.log('Command queue cleanup started (5 min interval)');
})();

// Create HTTP + WebSocket server
const server = Bun.serve({
  port: config.server.port,

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS headers for development
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return undefined;
    }

    // API routes
    if (url.pathname === '/api/health') {
      return Response.json(
        { status: 'ok', timestamp: new Date().toISOString() },
        { headers: corsHeaders }
      );
    }

    if (url.pathname === '/api/tickets') {
      const tickets = getAllTickets();
      return Response.json(
        tickets.map(t => ({
          ...t,
          labels: JSON.parse(t.labels || '[]')
        })),
        { headers: corsHeaders }
      );
    }

    if (url.pathname === '/api/slots') {
      return Response.json(getSlotStatus(), { headers: corsHeaders });
    }

    if (url.pathname === '/api/config') {
      return Response.json({
        repoOwner: config.github.owner,
        repoName: config.github.repo,
        claudeReadyLabel: config.github.claudeReadyLabel
      }, { headers: corsHeaders });
    }

    // Command queue API - for serializing heavy operations (test/build/lint)
    if (url.pathname === '/api/queue/acquire' && req.method === 'POST') {
      try {
        const body = await req.json() as { slot: number; type: string; command: string };
        const { slot, type, command } = body;

        if (!slot || !type || !command) {
          return Response.json(
            { error: 'Missing required fields: slot, type, command' },
            { status: 400, headers: corsHeaders }
          );
        }

        // Clean up any stale commands first
        cancelStaleCommands(30);

        // Enqueue the command
        const queued = enqueueCommand(slot, type, command);
        console.log(`[queue] Command ${queued.id} enqueued: slot=${slot} type=${type}`);

        // Poll until we can start (simple blocking approach)
        const maxWaitMs = 600000; // 10 minute max wait
        const pollIntervalMs = 1000; // Check every second
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitMs) {
          if (canStartCommand(queued.id)) {
            startCommand(queued.id);
            const position = 0;
            console.log(`[queue] Command ${queued.id} started after ${Date.now() - startTime}ms`);
            return Response.json(
              { id: queued.id, status: 'running', position, waitedMs: Date.now() - startTime },
              { headers: corsHeaders }
            );
          }

          const position = getQueuePosition(queued.id);
          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // Timeout - cancel the command
        cancelCommand(queued.id);
        console.log(`[queue] Command ${queued.id} timed out after ${maxWaitMs}ms`);
        return Response.json(
          { error: 'Timeout waiting for queue slot', id: queued.id },
          { status: 408, headers: corsHeaders }
        );
      } catch (error) {
        console.error('[queue] Error in acquire:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/queue/release' && req.method === 'POST') {
      try {
        const body = await req.json() as { id: number };
        const { id } = body;

        if (!id) {
          return Response.json(
            { error: 'Missing required field: id' },
            { status: 400, headers: corsHeaders }
          );
        }

        completeCommand(id);
        console.log(`[queue] Command ${id} completed`);
        return Response.json({ success: true, id }, { headers: corsHeaders });
      } catch (error) {
        console.error('[queue] Error in release:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/queue/status') {
      const status = getCommandQueueStatus();
      return Response.json(status, { headers: corsHeaders });
    }

    // ============================================
    // Merge Queue API
    // ============================================

    if (url.pathname === '/api/merge-queue') {
      const status = mergeQueue.getQueueStatus();
      return Response.json(status, { headers: corsHeaders });
    }

    if (url.pathname === '/api/merge-queue/add' && req.method === 'POST') {
      try {
        const body = await req.json() as { ticketId: number; priority?: number };
        const { ticketId, priority } = body;

        if (!ticketId) {
          return Response.json(
            { error: 'Missing required field: ticketId' },
            { status: 400, headers: corsHeaders }
          );
        }

        const ticket = getTicketById(ticketId);
        if (!ticket || !ticket.pr_number) {
          return Response.json(
            { error: 'Ticket not found or has no PR' },
            { status: 404, headers: corsHeaders }
          );
        }

        const entry = await mergeQueue.addToQueue(ticketId, ticket.pr_number, priority);
        return Response.json({ success: true, entry }, { headers: corsHeaders });
      } catch (error) {
        console.error('[merge-queue] Error in add:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/merge-queue/remove' && req.method === 'POST') {
      try {
        const body = await req.json() as { ticketId: number };
        const { ticketId } = body;

        if (!ticketId) {
          return Response.json(
            { error: 'Missing required field: ticketId' },
            { status: 400, headers: corsHeaders }
          );
        }

        const removed = mergeQueue.removeFromQueue(ticketId);
        return Response.json({ success: removed }, { headers: corsHeaders });
      } catch (error) {
        console.error('[merge-queue] Error in remove:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/merge-queue/reorder' && req.method === 'POST') {
      try {
        const body = await req.json() as { ticketId: number; newPosition: number };
        const { ticketId, newPosition } = body;

        if (!ticketId || newPosition === undefined) {
          return Response.json(
            { error: 'Missing required fields: ticketId, newPosition' },
            { status: 400, headers: corsHeaders }
          );
        }

        const reordered = mergeQueue.reorder(ticketId, newPosition);
        return Response.json({ success: reordered }, { headers: corsHeaders });
      } catch (error) {
        console.error('[merge-queue] Error in reorder:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/merge-queue/priority' && req.method === 'POST') {
      try {
        const body = await req.json() as { ticketId: number; priority: number };
        const { ticketId, priority } = body;

        if (!ticketId || priority === undefined) {
          return Response.json(
            { error: 'Missing required fields: ticketId, priority' },
            { status: 400, headers: corsHeaders }
          );
        }

        const updated = mergeQueue.setPriority(ticketId, priority);
        return Response.json({ success: updated }, { headers: corsHeaders });
      } catch (error) {
        console.error('[merge-queue] Error in priority:', error);
        return Response.json(
          { error: 'Internal server error' },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/merge-queue/pause' && req.method === 'POST') {
      mergeQueue.pauseQueue();
      return Response.json({ success: true, paused: true }, { headers: corsHeaders });
    }

    if (url.pathname === '/api/merge-queue/resume' && req.method === 'POST') {
      mergeQueue.resumeQueue();
      return Response.json({ success: true, paused: false }, { headers: corsHeaders });
    }

    // Reset stuck review state
    if (url.pathname === '/api/review/reset' && req.method === 'POST') {
      stopAllReviews();
      console.log('[review] Manual reset triggered via API');
      return Response.json({ success: true, message: 'Review state cleared' }, { headers: corsHeaders });
    }

    // Serve static files in production (for now, just return 404)
    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log('WebSocket client connected');
      addClient(ws);
      sendInitialState(ws, {
        owner: config.github.owner,
        repo: config.github.repo,
        label: config.github.claudeReadyLabel
      });
    },

    message(ws, message) {
      handleMessage(ws, message.toString());
    },

    close(ws) {
      console.log('WebSocket client disconnected');
      removeClient(ws);
    }
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  // Stop auto-play
  stopAutoPlay();
  console.log('Auto-play stopped');

  // Stop merge queue processor
  stopMergeQueueProcessor();
  console.log('Merge queue processor stopped');

  // Stop status broadcast
  stopStatusBroadcast();
  console.log('Status broadcast stopped');

  // Stop all running agents and reviews
  stopAllAgents();
  stopAllReviews();
  console.log('Agents stopped');

  // Close server
  server.stop();
  console.log('Server stopped');

  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  stopAutoPlay();
  stopMergeQueueProcessor();
  stopStatusBroadcast();
  stopAllAgents();
  stopAllReviews();
  server.stop();
  process.exit(0);
});

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    Claude Orchestrator                        ║
╠══════════════════════════════════════════════════════════════╣
║  Server:    http://localhost:${config.server.port}                          ║
║  WebSocket: ws://localhost:${config.server.port}/ws                         ║
║                                                               ║
║  Repository: ${config.github.owner}/${config.github.repo}
║  Label:      ${config.github.claudeReadyLabel}
║  Worktrees:  ${config.paths.worktreeDir}
╚══════════════════════════════════════════════════════════════╝
`);
