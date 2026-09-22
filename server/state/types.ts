export type TicketState = 'needs_review' | 'backlog' | 'in_progress' | 'in_review' | 'done';

export type BatchState = 'pending' | 'in_progress' | 'in_review' | 'done' | 'failed';

export type RetryReason = 'addressing_pr_comments' | 'improving_score' | 'fixing_ci' | 'resolving_merge_conflict' | 'agent_interrupted' | null;

export type Priority = 'urgent' | 'high' | 'medium' | 'low';

// CI status for live tracking
export type CIStatus = 'pending' | 'running' | 'passing' | 'failing' | 'unknown';

export interface CICheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
}

// Merge queue types
export type MergeQueueStatus = 'waiting' | 'merging' | 'merged' | 'failed' | 'removed';

export interface MergeQueueEntry {
  id: number;
  ticket_id: number;
  pr_number: number;
  position: number;
  priority: number; // 0 = normal, 1 = high, 2 = urgent
  lane: string; // 'default' or path-based lane
  status: MergeQueueStatus;
  entered_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
}

export interface Ticket {
  id: number;
  github_issue_number: number;
  github_issue_url: string;
  title: string;
  body: string | null;
  labels: string;  // JSON string in DB
  state: TicketState;
  worktree_slot: number | null;
  pr_number: number | null;
  pr_url: string | null;
  branch_name: string | null;
  current_score: number | null;
  attempt_count: number;
  needs_attention: number;  // SQLite uses 0/1 for boolean
  attention_reason: string | null;
  retry_reason: RetryReason;
  priority: Priority;
  position: number;
  handoff_notes: string | null;
  paused: number;  // SQLite uses 0/1 for boolean
  pause_reason: string | null;
  batch_id: number | null;
  // Error categorization for smart retry
  error_category: string | null;
  should_escalate_model: number;  // SQLite uses 0/1 for boolean
  // Respawn tracking (prevent double-respawn on same commit)
  last_checked_sha: string | null;
  // CI status for live tracking
  ci_status: CIStatus | null;
  ci_checks: string | null;  // JSON array of CICheck
  ci_updated_at: string | null;
  // Merge queue
  merge_queue_position: number | null;
  merge_queue_priority: number;
  // Progress tracking
  progress_phase: string | null;
  progress_percent: number;
  created_at: string;
  updated_at: string;
}

export interface Batch {
  id: number;
  name: string | null;
  area_key: string;
  state: BatchState;
  worktree_slot: number | null;
  pr_number: number | null;
  pr_url: string | null;
  branch_name: string | null;
  current_score: number | null;
  attempt_count: number;
  needs_attention: number;  // SQLite uses 0/1 for boolean
  attention_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentLog {
  id: number;
  ticket_id: number;
  timestamp: string;
  type: string;
  content: string;
  model: string | null;
  attempt_number: number | null;
}

export interface WorktreeSlot {
  slot: number;
  available: boolean;
  ticketId: number | null;
}

/**
 * Why a review thread is or is not resolvable.
 * - `resolved`        — replied to, and a commit after the review touched its file.
 * - `unbacked_claim`  — replied to, but no post-review commit touches its file.
 * - `no_reply`        — nobody answered it.
 * - `unverifiable`    — the evidence could not be read (no path, or the commit API failed).
 * - `resolve_failed`  — backed, but the resolve mutation errored.
 */
export type ThreadDecision = 'resolved' | 'resolve_failed' | 'unbacked_claim' | 'no_reply' | 'unverifiable';

export interface UnresolvedThreadContext {
  threadId: string;
  path: string | null;
  line: number | null;
  isOutdated: boolean;
  firstComment: string;
  /** The agent already answered this thread. */
  agentReplied: boolean;
  /** A commit dated at or after the last reviewer comment touches the thread's file. */
  codeChangedAfterReview: boolean;
  decision: ThreadDecision;
  /** One-line human reason behind `decision`. */
  reason: string;
}

export interface ReviewContext {
  previousScore?: number | null;
  reviewFeedback?: string;
  ciFailures?: string[];
  inlineComments?: string[];
  botComments?: string[];
  lastActivity?: string;
  recentToolCalls?: string[];
  recentErrors?: string[];
  filesModified?: string[];
  agentIntent?: string;
  userMessages?: string[];
  hasMergeConflicts?: boolean;
  /** Repo identity, so retry prompts can print real `gh api` commands instead of OWNER/REPO/PR. */
  repoOwner?: string;
  repoName?: string;
  /** Threads `required_conversation_resolution` is still blocking the merge on. */
  unresolvedThreads?: UnresolvedThreadContext[];
  failureAnalysis?: {
    category: string;
    description: string;
    errorMessages: string[];
    repeatedPatterns: string[];
    suggestions: string[];
    severity: string;
  };
}

export interface ChatMessage {
  id: number;
  ticket_id: number;
  role: 'user' | 'agent';
  content: string;
  pending: number;  // 0 or 1 in SQLite
  created_at: string;
}
