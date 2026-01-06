// Shared types between server and client

export type TicketState = 'needs_review' | 'backlog' | 'in_progress' | 'in_review' | 'done';

export type RetryReason = 'addressing_pr_comments' | 'improving_score' | 'fixing_ci' | 'resolving_merge_conflict' | null;

export type Priority = 'high' | 'medium' | 'low';

export interface Ticket {
  id: number;
  github_issue_number: number;
  github_issue_url: string;
  title: string;
  body: string | null;
  labels: string[];
  state: TicketState;
  worktree_slot: number | null;
  pr_number: number | null;
  pr_url: string | null;
  branch_name: string | null;
  current_score: number | null;
  attempt_count: number;
  needs_attention: boolean;
  attention_reason: string | null;
  retry_reason: RetryReason;
  priority: Priority;
  position: number;
  blocked_by?: number[];  // Ticket IDs that block this ticket
  blocks?: number[];      // Ticket IDs that this ticket blocks
  created_at: string;
  updated_at: string;
}

export interface WorktreeSlot {
  slot: number;
  available: boolean;
  ticketId: number | null;
}

// Structured event content from Claude CLI stream-json format
export interface ToolUseContent {
  type: 'tool_use';
  name: string;
  input?: Record<string, unknown>;
  id?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface TextContent {
  type: 'text';
  text?: string;
  content?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking?: string;
  content?: string;
}

export interface AssistantContent {
  type: 'assistant';
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

export type StructuredContent =
  | ToolUseContent
  | ToolResultContent
  | TextContent
  | ThinkingContent
  | AssistantContent
  | Record<string, unknown>;

export interface AgentEvent {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result' | 'assistant' | 'system';
  content: string | StructuredContent;
  timestamp?: string;
}

export interface Config {
  repoOwner: string;
  repoName: string;
  claudeReadyLabel: string;
}

// WebSocket Messages
export type ServerMessage =
  | { type: 'init'; tickets: Ticket[]; config: Config; slots: WorktreeSlot[]; agentLogs?: Record<number, AgentEvent[]>; agentTodos?: Record<number, AgentTodo[]>; pipelineStatus?: { paused: boolean; reason: string; pausedAt: string }; settings?: Record<string, unknown>; autoplayStatus?: { enabled: boolean; active: boolean; intervalMs: number }; pollStatus?: PollStatus; activityLog?: ActivityEntry[] }
  | { type: 'ticket_created'; ticket: Ticket }
  | { type: 'ticket_updated'; ticketId: number; changes: Partial<Ticket> }
  | { type: 'ticket_started'; ticketId: number; slot: number }
  | { type: 'ticket_completed'; ticketId: number; score: number }
  | { type: 'agent_output'; ticketId: number; event: AgentEvent }
  | { type: 'agent_todos'; ticketId: number; todos: AgentTodo[] }
  | { type: 'worktree_status'; slots: WorktreeSlot[] }
  | { type: 'ticket_removed'; ticketId: number }
  | { type: 'chat_messages'; ticketId: number; messages: ChatMessage[] }
  | { type: 'chat_message'; ticketId: number; message: ChatMessage }
  | { type: 'tickets_reordered'; state: TicketState; ticketIds: number[] }
  | { type: 'dependencies'; ticketId: number; blockedBy: number[]; blocks: number[] }
  | { type: 'pipeline_paused'; reason: string; pausedAt: string }
  | { type: 'pipeline_resumed' }
  | { type: 'settings_updated'; settings: Record<string, unknown> }
  | { type: 'autoplay_started' }
  | { type: 'autoplay_stopped' }
  | { type: 'autoplay_enabled' }
  | { type: 'autoplay_disabled' }
  | { type: 'autoplay_status'; enabled: boolean; active: boolean; intervalMs: number }
  | { type: 'poll_status'; prWatch: PollStatus['prWatch']; issueSync: PollStatus['issueSync'] }
  | { type: 'activity'; activity: ActivityEntry }
  | { type: 'review_started'; ticketIds: number[] }
  | { type: 'review_completed'; results: unknown }
  | { type: 'review_error'; message: string }
  | { type: 'batch_review_started'; ticketIds: number[] }
  | { type: 'review_progress'; results: Array<{ ticketId: number; verdict: string; error?: string }>; completed: number; total: number }
  | { type: 'review_output'; content: string }
  | { type: 'error'; message: string };

export interface PRDetails {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  reviewScore: number | null;
  reviewComments: PRComment[];
  ciStatus: 'pending' | 'success' | 'failure' | 'unknown';
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
}

export type ClientMessage =
  | { type: 'start_ticket'; ticketId: number; force?: boolean }
  | { type: 'stop_ticket'; ticketId: number }
  | { type: 'retry_ticket'; ticketId: number }
  | { type: 'force_reset_ticket'; ticketId: number }
  | { type: 'archive_ticket'; ticketId: number }
  | { type: 'get_logs'; ticketId: number; limit?: number }
  | { type: 'get_pr_details'; ticketId: number }
  | { type: 'get_chat_messages'; ticketId: number }
  | { type: 'send_chat_message'; ticketId: number; content: string }
  | { type: 'resolve_attention'; ticketId: number; action: string }
  | { type: 'interrupt_for_message'; ticketId: number }
  | { type: 'add_label'; issueNumbers: number[]; label: string }
  | { type: 'run_skill'; skill: string; args?: string }
  | { type: 'sync_issues' }
  | { type: 'dispatcher_chat'; message: string; sessionId?: string }
  | { type: 'dispatcher_stop' }
  | { type: 'set_priority'; ticketId: number; priority: Priority }
  | { type: 'reorder_tickets'; state: TicketState; ticketIds: number[] }
  | { type: 'move_ticket'; ticketId: number; toState: TicketState; toIndex?: number }
  | { type: 'get_dependencies'; ticketId: number }
  | { type: 'pause_pipeline'; reason: string }
  | { type: 'resume_pipeline' }
  | { type: 'enable_autoplay' }
  | { type: 'disable_autoplay' }
  | { type: 'update_settings'; settings: Record<string, unknown> }
  | { type: 'batch_review'; ticketIds: number[]; issueNumbers: number[] };

// Agent Todo items (from Claude's TodoWrite tool)
export interface AgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

// Chat messages between user and agent
export interface ChatMessage {
  id: number;
  ticket_id: number;
  role: 'user' | 'agent';
  content: string;
  pending: boolean;
  created_at: string;
}

// Poll status for showing countdowns
export interface PollStatus {
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

// Activity log entry
export interface ActivityEntry {
  timestamp: number;
  type: 'pr_check' | 'issue_sync' | 'agent_spawn' | 'pr_merged' | 'ci_status' | 'respawn';
  message: string;
}
