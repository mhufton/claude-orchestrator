export type TicketState = 'needs_review' | 'backlog' | 'in_progress' | 'in_review' | 'done';

export type RetryReason = 'addressing_pr_comments' | 'improving_score' | 'fixing_ci' | 'resolving_merge_conflict' | null;

export type Priority = 'high' | 'medium' | 'low';

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
  created_at: string;
  updated_at: string;
}

export interface AgentLog {
  id: number;
  ticket_id: number;
  timestamp: string;
  type: string;
  content: string;
}

export interface WorktreeSlot {
  slot: number;
  available: boolean;
  ticketId: number | null;
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
}

export interface ChatMessage {
  id: number;
  ticket_id: number;
  role: 'user' | 'agent';
  content: string;
  pending: number;  // 0 or 1 in SQLite
  created_at: string;
}
