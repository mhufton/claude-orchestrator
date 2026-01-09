import { broadcast } from './ws/handler';

interface PollStatus {
  prWatch: {
    lastRun: number | null;
    nextRun: number | null;
    intervalMs: number;
    ticketsChecked: number;
  };
  issueSync: {
    lastRun: number | null;
    nextRun: number | null;
    intervalMs: number;
  };
}

const pollStatus: PollStatus = {
  prWatch: {
    lastRun: null,
    nextRun: null,
    intervalMs: 30000,  // Default 30s, updated by startPRWatchLoop
    ticketsChecked: 0
  },
  issueSync: {
    lastRun: null,
    nextRun: null,
    intervalMs: 60000
  }
};

// Activity log - last N activities
const activityLog: Array<{
  timestamp: number;
  type: 'pr_check' | 'issue_sync' | 'agent_spawn' | 'pr_merged' | 'ci_status' | 'respawn' | 'branch_update' | 'merge_started' | 'merge_completed';
  message: string;
}> = [];
const MAX_ACTIVITY_LOG = 50;

export function setPRWatchInterval(intervalMs: number): void {
  pollStatus.prWatch.intervalMs = intervalMs;
}

export function setIssueSyncInterval(intervalMs: number): void {
  pollStatus.issueSync.intervalMs = intervalMs;
}

export function recordPRWatchStart(): void {
  pollStatus.prWatch.lastRun = Date.now();
  pollStatus.prWatch.nextRun = Date.now() + pollStatus.prWatch.intervalMs;
  pollStatus.prWatch.ticketsChecked = 0;
  broadcastPollStatus();
}

export function recordPRWatchComplete(ticketsChecked: number): void {
  pollStatus.prWatch.ticketsChecked = ticketsChecked;
  broadcastPollStatus();
}

export function recordIssueSyncStart(): void {
  pollStatus.issueSync.lastRun = Date.now();
  pollStatus.issueSync.nextRun = Date.now() + pollStatus.issueSync.intervalMs;
  broadcastPollStatus();
}

export function addActivity(
  type: 'pr_check' | 'issue_sync' | 'agent_spawn' | 'pr_merged' | 'ci_status' | 'respawn' | 'branch_update' | 'merge_started' | 'merge_completed',
  message: string
): void {
  activityLog.unshift({
    timestamp: Date.now(),
    type,
    message
  });

  // Trim to max size
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.length = MAX_ACTIVITY_LOG;
  }

  // Broadcast the new activity
  broadcast({
    type: 'activity',
    activity: activityLog[0]
  });
}

export function getPollStatus(): PollStatus {
  return pollStatus;
}

export function getActivityLog(): typeof activityLog {
  return activityLog;
}

function broadcastPollStatus(): void {
  broadcast({
    type: 'poll_status',
    prWatch: pollStatus.prWatch,
    issueSync: pollStatus.issueSync
  });
}

// Broadcast status periodically so countdowns stay accurate
let statusInterval: ReturnType<typeof setInterval> | null = null;

export function startStatusBroadcast(): void {
  if (statusInterval) return;

  // Broadcast every 5 seconds for smooth countdowns
  statusInterval = setInterval(() => {
    broadcastPollStatus();
  }, 5000);
}

export function stopStatusBroadcast(): void {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}
