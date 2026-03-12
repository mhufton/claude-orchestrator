-- Tickets (GitHub issues being worked on)
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_issue_number INTEGER NOT NULL UNIQUE,
  github_issue_url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  labels TEXT DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'backlog' CHECK (state IN ('needs_review', 'backlog', 'in_progress', 'in_review', 'done')),
  worktree_slot INTEGER CHECK (worktree_slot IS NULL OR worktree_slot BETWEEN 1 AND 10),
  pr_number INTEGER,
  pr_url TEXT,
  branch_name TEXT,
  current_score INTEGER,
  attempt_count INTEGER DEFAULT 0,
  needs_attention INTEGER DEFAULT 0,
  attention_reason TEXT,
  retry_reason TEXT,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  position INTEGER DEFAULT 0,
  handoff_notes TEXT,
  paused INTEGER DEFAULT 0,
  pause_reason TEXT,
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  -- CI status for live tracking
  ci_status TEXT CHECK (ci_status IN ('pending', 'running', 'passing', 'failing', 'unknown')),
  ci_checks TEXT,
  ci_updated_at TEXT,
  -- Merge queue
  merge_queue_position INTEGER,
  merge_queue_priority INTEGER DEFAULT 0,
  -- Progress tracking
  progress_phase TEXT DEFAULT 'starting',
  progress_percent INTEGER DEFAULT 0,
  -- Error categorization
  error_category TEXT,
  should_escalate_model INTEGER DEFAULT 0,
  -- Respawn tracking (prevent double-respawn on same commit)
  last_checked_sha TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Agent logs (streaming output from Claude CLI)
CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  type TEXT,
  content TEXT,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Sync state (for tracking GitHub sync)
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Chat messages (user conversations with agents)
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content TEXT NOT NULL,
  pending INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Agent todos (task tracking from TodoWrite tool)
CREATE TABLE IF NOT EXISTS agent_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Issue reviews (batch review results)
CREATE TABLE IF NOT EXISTS issue_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ready', 'minor_gaps', 'needs_revision', 'closed', 'epic')),
  gaps TEXT DEFAULT '[]',
  recommendations TEXT,
  changes_made TEXT,
  reviewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Batches (groups of related tickets worked on together)
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  area_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'in_progress', 'in_review', 'done', 'failed')),
  worktree_slot INTEGER CHECK (worktree_slot IS NULL OR worktree_slot BETWEEN 1 AND 10),
  pr_number INTEGER,
  pr_url TEXT,
  branch_name TEXT,
  current_score INTEGER,
  attempt_count INTEGER DEFAULT 0,
  needs_attention INTEGER DEFAULT 0,
  attention_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Ticket dependencies (for blocking/dependency relationships)
CREATE TABLE IF NOT EXISTS ticket_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  depends_on_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, depends_on_id)
);

-- Command queue (for serializing heavy operations like test/build/lint)
CREATE TABLE IF NOT EXISTS command_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'done', 'cancelled')),
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);

-- State transitions (detailed audit log for debugging retry issues)
CREATE TABLE IF NOT EXISTS state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  github_issue_number INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL,
  reason TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Merge queue (FIFO queue for PR merges)
CREATE TABLE IF NOT EXISTS merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  position INTEGER NOT NULL,
  priority INTEGER DEFAULT 0,
  lane TEXT DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'merging', 'merged', 'failed', 'removed')),
  entered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT
);

-- Agent handoffs (persistent state for PM mode context clearing)
CREATE TABLE IF NOT EXISTS agent_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  -- Snapshot of work state
  planned_batches TEXT,      -- JSON: [{label: "A", tickets: [1,2,3], status: "planned"}]
  active_batch TEXT,         -- Current batch label
  pr_statuses TEXT,          -- JSON: [{pr: 123, status: "ci_running", issues: [...]}]

  -- What to do next
  pending_actions TEXT,      -- JSON: [{type: "fix_ci", pr: 123, details: "..."}]
  resume_instructions TEXT,  -- Plain English for agent

  -- Context management
  context_percentage REAL,   -- What % context was when handoff triggered
  cleared_at TEXT            -- When /clear happened (null if not yet cleared)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_tickets_issue_number ON tickets(github_issue_number);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_position ON tickets(position);
CREATE INDEX IF NOT EXISTS idx_agent_logs_ticket ON agent_logs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_timestamp ON agent_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_messages_ticket ON chat_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_agent_todos_ticket ON agent_todos(ticket_id);
CREATE INDEX IF NOT EXISTS idx_issue_reviews_ticket ON issue_reviews(ticket_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_ticket ON ticket_dependencies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON ticket_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_command_queue_status ON command_queue(status);
CREATE INDEX IF NOT EXISTS idx_command_queue_slot ON command_queue(slot);
CREATE INDEX IF NOT EXISTS idx_state_transitions_ticket ON state_transitions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_timestamp ON state_transitions(timestamp);
CREATE INDEX IF NOT EXISTS idx_batches_state ON batches(state);
CREATE INDEX IF NOT EXISTS idx_batches_area_key ON batches(area_key);
CREATE INDEX IF NOT EXISTS idx_tickets_batch_id ON tickets(batch_id);
CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);
CREATE INDEX IF NOT EXISTS idx_merge_queue_position ON merge_queue(position, lane);
CREATE INDEX IF NOT EXISTS idx_merge_queue_ticket ON merge_queue(ticket_id);
