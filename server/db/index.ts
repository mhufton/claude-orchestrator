import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Ticket, AgentLog, TicketState, ChatMessage, Batch, BatchState, MergeQueueEntry, MergeQueueStatus } from '../state/types';

let db: Database;

export function initDatabase(dbPath: string = './orchestrator.db'): void {
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Run migrations first to add any missing columns to existing tables
  // This must happen before schema.sql because schema.sql creates indexes on new columns
  runMigrations();

  // Now run full schema - CREATE TABLE IF NOT EXISTS will be no-ops for existing tables
  // CREATE INDEX IF NOT EXISTS will work because migrations added the columns
  const schemaPath = join(import.meta.dir, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
}

function runMigrations(): void {
  // Check if tickets table exists
  const tableExists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tickets'").all();
  if (tableExists.length === 0) {
    // Fresh database - no migrations needed, schema.sql will create everything
    return;
  }

  // Check columns in tickets table
  const columns = db.query("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(c => c.name));

  // Migration: Add retry_reason column
  const hasRetryReason = columnNames.has('retry_reason');

  if (!hasRetryReason) {
    console.log('Migrating database: adding retry_reason column');
    db.exec('ALTER TABLE tickets ADD COLUMN retry_reason TEXT');
  }

  // Check if CHECK constraint includes 'needs_review'
  // SQLite doesn't allow altering CHECK constraints, so we need to check and recreate if needed
  const tableInfo = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get() as { sql: string } | undefined;
  if (tableInfo && !tableInfo.sql.includes("'needs_review'")) {
    console.log('Migrating database: adding needs_review state to tickets table');

    // Create new table with correct constraint
    db.exec(`
      CREATE TABLE tickets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_issue_number INTEGER NOT NULL UNIQUE,
        github_issue_url TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        labels TEXT DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'backlog' CHECK (state IN ('needs_review', 'backlog', 'in_progress', 'in_review', 'done')),
        worktree_slot INTEGER CHECK (worktree_slot IS NULL OR worktree_slot BETWEEN 1 AND 3),
        pr_number INTEGER,
        pr_url TEXT,
        branch_name TEXT,
        current_score INTEGER,
        attempt_count INTEGER DEFAULT 0,
        needs_attention INTEGER DEFAULT 0,
        attention_reason TEXT,
        retry_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Copy data from old table
    db.exec(`
      INSERT INTO tickets_new (
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        created_at, updated_at
      )
      SELECT
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        created_at, updated_at
      FROM tickets
    `);

    // Drop old table and rename new one
    db.exec('DROP TABLE tickets');
    db.exec('ALTER TABLE tickets_new RENAME TO tickets');

    // Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_issue_number ON tickets(github_issue_number)');

    console.log('Migration complete: needs_review state now supported');
  }

  // Migration: Add priority column
  if (!columnNames.has('priority')) {
    console.log('Migrating database: adding priority column');
    db.exec("ALTER TABLE tickets ADD COLUMN priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low'))");
  }

  // Migration: Add position column
  if (!columnNames.has('position')) {
    console.log('Migrating database: adding position column');
    db.exec('ALTER TABLE tickets ADD COLUMN position INTEGER DEFAULT 0');
  }

  // Migration: Add handoff_notes column
  if (!columnNames.has('handoff_notes')) {
    console.log('Migrating database: adding handoff_notes column');
    db.exec('ALTER TABLE tickets ADD COLUMN handoff_notes TEXT');
  }

  // Migration: Add paused column for per-ticket pause feature
  if (!columnNames.has('paused')) {
    console.log('Migrating database: adding paused column');
    db.exec('ALTER TABLE tickets ADD COLUMN paused INTEGER DEFAULT 0');
  }

  // Migration: Add pause_reason column
  if (!columnNames.has('pause_reason')) {
    console.log('Migrating database: adding pause_reason column');
    db.exec('ALTER TABLE tickets ADD COLUMN pause_reason TEXT');
  }

  // Migration: Expand worktree_slot constraint from 1-3 to 1-10
  if (tableInfo && tableInfo.sql.includes('BETWEEN 1 AND 3')) {
    console.log('Migrating database: expanding worktree_slot constraint from 1-3 to 1-10');

    // Create new table with expanded constraint
    db.exec(`
      CREATE TABLE tickets_new (
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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Copy data from old table
    db.exec(`
      INSERT INTO tickets_new (
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        priority, position, handoff_notes, created_at, updated_at
      )
      SELECT
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        priority, position, handoff_notes, created_at, updated_at
      FROM tickets
    `);

    // Drop old table and rename new one
    db.exec('DROP TABLE tickets');
    db.exec('ALTER TABLE tickets_new RENAME TO tickets');

    // Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_issue_number ON tickets(github_issue_number)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_position ON tickets(position)');

    console.log('Migration complete: worktree_slot now supports up to 10 slots');
  }

  // Migration: Add 'urgent' to priority CHECK constraint
  // Re-fetch tableInfo in case it changed
  const tableInfoForPriority = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'").get() as { sql: string } | undefined;
  if (tableInfoForPriority && tableInfoForPriority.sql.includes("priority IN ('high', 'medium', 'low')") && !tableInfoForPriority.sql.includes("'urgent'")) {
    console.log('Migrating database: adding urgent priority to CHECK constraint');

    // Create new table with urgent priority
    db.exec(`
      CREATE TABLE tickets_new (
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
        priority TEXT DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
        position INTEGER DEFAULT 0,
        handoff_notes TEXT,
        paused INTEGER DEFAULT 0,
        pause_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Copy data from old table
    db.exec(`
      INSERT INTO tickets_new (
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        priority, position, handoff_notes, paused, pause_reason, created_at, updated_at
      )
      SELECT
        id, github_issue_number, github_issue_url, title, body, labels, state,
        worktree_slot, pr_number, pr_url, branch_name, current_score,
        attempt_count, needs_attention, attention_reason, retry_reason,
        priority, position, handoff_notes, paused, pause_reason, created_at, updated_at
      FROM tickets
    `);

    // Drop old table and rename new one
    db.exec('DROP TABLE tickets');
    db.exec('ALTER TABLE tickets_new RENAME TO tickets');

    // Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_issue_number ON tickets(github_issue_number)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_position ON tickets(position)');

    console.log('Migration complete: urgent priority now supported');
  }

  // Migration: Create ticket_dependencies table
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ticket_dependencies'").all();
  if (tables.length === 0) {
    console.log('Migrating database: creating ticket_dependencies table');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        depends_on_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_id) REFERENCES tickets(id) ON DELETE CASCADE,
        UNIQUE(ticket_id, depends_on_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_dependencies_ticket ON ticket_dependencies(ticket_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON ticket_dependencies(depends_on_id)');
  }

  // Migration: Create batches table
  const batchesTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='batches'").all();
  if (batchesTable.length === 0) {
    console.log('Migrating database: creating batches table');
    db.exec(`
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
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_batches_state ON batches(state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_batches_area_key ON batches(area_key)');
  }

  // Migration: Add batch_id column to tickets
  // Re-check columns after potential table recreations
  const columnsAfterMigrations = db.query("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  const columnNamesAfter = new Set(columnsAfterMigrations.map(c => c.name));
  if (!columnNamesAfter.has('batch_id')) {
    console.log('Migrating database: adding batch_id column to tickets');
    db.exec('ALTER TABLE tickets ADD COLUMN batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_batch_id ON tickets(batch_id)');
  }

  // Migration: Add CI status columns for live tracking
  if (!columnNamesAfter.has('ci_status')) {
    console.log('Migrating database: adding CI status columns');
    db.exec("ALTER TABLE tickets ADD COLUMN ci_status TEXT CHECK (ci_status IN ('pending', 'running', 'passing', 'failing', 'unknown'))");
    db.exec('ALTER TABLE tickets ADD COLUMN ci_checks TEXT');  // JSON array
    db.exec('ALTER TABLE tickets ADD COLUMN ci_updated_at TEXT');
  }

  // Migration: Add merge queue columns to tickets
  if (!columnNamesAfter.has('merge_queue_position')) {
    console.log('Migrating database: adding merge queue columns');
    db.exec('ALTER TABLE tickets ADD COLUMN merge_queue_position INTEGER');
    db.exec('ALTER TABLE tickets ADD COLUMN merge_queue_priority INTEGER DEFAULT 0');
  }

  // Migration: Create merge_queue table
  const mergeQueueTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='merge_queue'").all();
  if (mergeQueueTable.length === 0) {
    console.log('Migrating database: creating merge_queue table');
    db.exec(`
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
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_merge_queue_position ON merge_queue(position, lane)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_merge_queue_ticket ON merge_queue(ticket_id)');
  }
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// Ticket operations
export function getAllTickets(): Ticket[] {
  return db.query('SELECT * FROM tickets ORDER BY created_at DESC').all() as Ticket[];
}

export function getTicketsByState(state: TicketState): Ticket[] {
  return db.query('SELECT * FROM tickets WHERE state = ? ORDER BY created_at DESC').all(state) as Ticket[];
}

export function getTicketById(id: number): Ticket | undefined {
  return db.query('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined;
}

export function getTicketByIssueNumber(issueNumber: number): Ticket | undefined {
  return db.query('SELECT * FROM tickets WHERE github_issue_number = ?').get(issueNumber) as Ticket | undefined;
}

export function getTicketBySlot(slot: number): Ticket | undefined {
  return db.query('SELECT * FROM tickets WHERE worktree_slot = ? AND state IN (?, ?)').get(slot, 'in_progress', 'in_review') as Ticket | undefined;
}

export interface CreateTicketInput {
  github_issue_number: number;
  github_issue_url: string;
  title: string;
  body?: string;
  labels?: string;
}

export function createTicket(input: CreateTicketInput): Ticket {
  const stmt = db.query(`
    INSERT INTO tickets (github_issue_number, github_issue_url, title, body, labels)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    input.github_issue_number,
    input.github_issue_url,
    input.title,
    input.body || null,
    input.labels || '[]'
  );

  return getTicketById(Number(result.lastInsertRowid))!;
}

export function updateTicket(id: number, changes: Partial<Ticket>): Ticket | undefined {
  const allowedFields = [
    'state', 'worktree_slot', 'pr_number', 'pr_url',
    'branch_name', 'current_score', 'attempt_count', 'title', 'body', 'labels',
    'needs_attention', 'attention_reason', 'retry_reason', 'priority', 'position',
    'handoff_notes', 'paused', 'pause_reason', 'batch_id',
    'ci_status', 'ci_checks', 'ci_updated_at',
    'merge_queue_position', 'merge_queue_priority'
  ];

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(changes)) {
    if (allowedFields.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }

  if (updates.length === 0) return getTicketById(id);

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const sql = `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`;
  db.query(sql).run(...values);

  return getTicketById(id);
}

export function deleteTicket(id: number): boolean {
  const result = db.query('DELETE FROM tickets WHERE id = ?').run(id);
  return result.changes > 0;
}

// Agent log operations
export function insertLog(ticketId: number, type: string, content: string): void {
  db.query(`
    INSERT INTO agent_logs (ticket_id, type, content)
    VALUES (?, ?, ?)
  `).run(ticketId, type, content);
}

export function getLogsForTicket(ticketId: number, limit: number = 100): AgentLog[] {
  return db.query(`
    SELECT * FROM agent_logs
    WHERE ticket_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(ticketId, limit) as AgentLog[];
}

export function clearLogsForTicket(ticketId: number): void {
  db.query('DELETE FROM agent_logs WHERE ticket_id = ?').run(ticketId);
}

// Sync state operations
export function getSyncState(key: string): string | undefined {
  const row = db.query('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSyncState(key: string, value: string): void {
  db.query(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run(key, value, value);
}

// Worktree slot helpers
export function getAvailableSlot(): number | null {
  const usedSlots = db.query(`
    SELECT worktree_slot FROM tickets
    WHERE worktree_slot IS NOT NULL
    AND state IN ('in_progress', 'in_review')
  `).all() as { worktree_slot: number }[];

  const used = new Set(usedSlots.map(r => r.worktree_slot));

  const maxSlots = getSettings().maxAgentSlots;
  for (let slot = 1; slot <= maxSlots; slot++) {
    if (!used.has(slot)) return slot;
  }

  return null;
}

export function getSlotStatus(): Array<{ slot: number; available: boolean; ticketId: number | null }> {
  const tickets = db.query(`
    SELECT id, worktree_slot FROM tickets
    WHERE worktree_slot IS NOT NULL
    AND state IN ('in_progress', 'in_review')
  `).all() as { id: number; worktree_slot: number }[];

  const slotMap = new Map(tickets.map(t => [t.worktree_slot, t.id]));

  const maxSlots = getSettings().maxAgentSlots;
  return Array.from({ length: maxSlots }, (_, i) => i + 1).map(slot => ({
    slot,
    available: !slotMap.has(slot),
    ticketId: slotMap.get(slot) || null
  }));
}

// Chat message operations
export function insertChatMessage(ticketId: number, role: 'user' | 'agent', content: string, pending: boolean = false): ChatMessage {
  const result = db.query(`
    INSERT INTO chat_messages (ticket_id, role, content, pending)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, role, content, pending ? 1 : 0);

  return getChatMessageById(Number(result.lastInsertRowid))!;
}

export function getChatMessageById(id: number): ChatMessage | undefined {
  return db.query('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessage | undefined;
}

export function getChatMessagesForTicket(ticketId: number, limit: number = 100): ChatMessage[] {
  return db.query(`
    SELECT * FROM chat_messages
    WHERE ticket_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(ticketId, limit) as ChatMessage[];
}

export function getPendingChatMessages(ticketId: number): ChatMessage[] {
  return db.query(`
    SELECT * FROM chat_messages
    WHERE ticket_id = ? AND pending = 1
    ORDER BY created_at ASC
  `).all(ticketId) as ChatMessage[];
}

export function markChatMessagesDelivered(ticketId: number): void {
  db.query('UPDATE chat_messages SET pending = 0 WHERE ticket_id = ? AND pending = 1').run(ticketId);
}

export function clearChatMessagesForTicket(ticketId: number): void {
  db.query('DELETE FROM chat_messages WHERE ticket_id = ?').run(ticketId);
}

// Agent todo operations
export interface AgentTodo {
  id?: number;
  ticket_id: number;
  attempt_number: number;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  created_at?: string;
  updated_at?: string;
}

export function saveTodosForTicket(ticketId: number, attemptNumber: number, todos: Array<{ content: string; status: string }>): void {
  // Clear existing todos for this attempt
  db.query('DELETE FROM agent_todos WHERE ticket_id = ? AND attempt_number = ?').run(ticketId, attemptNumber);

  // Insert new todos
  const stmt = db.query(`
    INSERT INTO agent_todos (ticket_id, attempt_number, content, status)
    VALUES (?, ?, ?, ?)
  `);

  for (const todo of todos) {
    stmt.run(ticketId, attemptNumber, todo.content, todo.status);
  }
}

export function getTodosForTicket(ticketId: number): AgentTodo[] {
  return db.query(`
    SELECT * FROM agent_todos
    WHERE ticket_id = ?
    ORDER BY attempt_number DESC, id ASC
  `).all(ticketId) as AgentTodo[];
}

export function getLatestTodosForTicket(ticketId: number): AgentTodo[] {
  // Get the latest attempt number
  const latest = db.query(`
    SELECT MAX(attempt_number) as max_attempt FROM agent_todos WHERE ticket_id = ?
  `).get(ticketId) as { max_attempt: number | null };

  if (!latest?.max_attempt) return [];

  return db.query(`
    SELECT * FROM agent_todos
    WHERE ticket_id = ? AND attempt_number = ?
    ORDER BY id ASC
  `).all(ticketId, latest.max_attempt) as AgentTodo[];
}

export function getAllTodosGroupedByTicket(): Record<number, AgentTodo[]> {
  const all = db.query(`
    SELECT * FROM agent_todos
    ORDER BY ticket_id, attempt_number DESC, id ASC
  `).all() as AgentTodo[];

  const grouped: Record<number, AgentTodo[]> = {};
  for (const todo of all) {
    if (!grouped[todo.ticket_id]) {
      grouped[todo.ticket_id] = [];
    }
    grouped[todo.ticket_id].push(todo);
  }

  return grouped;
}

// Issue review operations
export interface IssueReview {
  id?: number;
  ticket_id: number;
  verdict: 'ready' | 'minor_gaps' | 'needs_revision' | 'closed' | 'epic';
  gaps: string; // JSON array
  recommendations: string | null;
  changes_made: string | null;
  reviewed_at?: string;
}

export function saveIssueReview(review: Omit<IssueReview, 'id' | 'reviewed_at'>): IssueReview {
  const result = db.query(`
    INSERT INTO issue_reviews (ticket_id, verdict, gaps, recommendations, changes_made)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    review.ticket_id,
    review.verdict,
    review.gaps,
    review.recommendations,
    review.changes_made
  );

  return getIssueReviewById(Number(result.lastInsertRowid))!;
}

export function getIssueReviewById(id: number): IssueReview | undefined {
  return db.query('SELECT * FROM issue_reviews WHERE id = ?').get(id) as IssueReview | undefined;
}

export function getLatestReviewForTicket(ticketId: number): IssueReview | undefined {
  return db.query(`
    SELECT * FROM issue_reviews
    WHERE ticket_id = ?
    ORDER BY reviewed_at DESC
    LIMIT 1
  `).get(ticketId) as IssueReview | undefined;
}

export function getReviewsForTicket(ticketId: number): IssueReview[] {
  return db.query(`
    SELECT * FROM issue_reviews
    WHERE ticket_id = ?
    ORDER BY reviewed_at DESC
  `).all(ticketId) as IssueReview[];
}

// Ticket dependency operations
export interface TicketDependency {
  id: number;
  ticket_id: number;
  depends_on_id: number;
  created_at: string;
}

export interface DependencyInfo {
  blockedBy: number[];  // Ticket IDs that this ticket depends on
  blocks: number[];     // Ticket IDs that depend on this ticket
}

export function addDependency(ticketId: number, dependsOnId: number): TicketDependency | null {
  try {
    const result = db.query(`
      INSERT INTO ticket_dependencies (ticket_id, depends_on_id)
      VALUES (?, ?)
    `).run(ticketId, dependsOnId);
    return getDependencyById(Number(result.lastInsertRowid));
  } catch {
    // Unique constraint violation (already exists)
    return null;
  }
}

export function getDependencyById(id: number): TicketDependency | null {
  return db.query('SELECT * FROM ticket_dependencies WHERE id = ?').get(id) as TicketDependency | null;
}

export function removeDependency(ticketId: number, dependsOnId: number): boolean {
  const result = db.query('DELETE FROM ticket_dependencies WHERE ticket_id = ? AND depends_on_id = ?').run(ticketId, dependsOnId);
  return result.changes > 0;
}

export function getDependenciesForTicket(ticketId: number): DependencyInfo {
  // Get tickets that this ticket depends on (blockers)
  const blockedBy = db.query(`
    SELECT depends_on_id FROM ticket_dependencies WHERE ticket_id = ?
  `).all(ticketId) as { depends_on_id: number }[];

  // Get tickets that depend on this ticket (blocks)
  const blocks = db.query(`
    SELECT ticket_id FROM ticket_dependencies WHERE depends_on_id = ?
  `).all(ticketId) as { ticket_id: number }[];

  return {
    blockedBy: blockedBy.map(d => d.depends_on_id),
    blocks: blocks.map(d => d.ticket_id)
  };
}

export function clearDependenciesForTicket(ticketId: number): void {
  db.query('DELETE FROM ticket_dependencies WHERE ticket_id = ? OR depends_on_id = ?').run(ticketId, ticketId);
}

// Get tickets by state with ordering (for kanban columns)
export function getTicketsByStateOrdered(state: TicketState): Ticket[] {
  return db.query(`
    SELECT * FROM tickets
    WHERE state = ?
    ORDER BY
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 2
      END,
      position ASC,
      created_at DESC
  `).all(state) as Ticket[];
}

// Reorder tickets within a column
export function reorderTicketsInColumn(state: TicketState, ticketIds: number[]): void {
  const stmt = db.query('UPDATE tickets SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = ?');
  for (let i = 0; i < ticketIds.length; i++) {
    stmt.run(i, ticketIds[i], state);
  }
}

// Orchestrator settings
export interface OrchestratorSettings {
  maxAgentSlots: number;
  maxParallelReviews: number;
  autoPlayEnabled: boolean;
  autoPlayIntervalMs: number;
  batchingEnabled: boolean;
  // PM Mode settings
  agentMode: 'parallel-slots' | 'pm-single';  // parallel-slots = legacy, pm-single = single PM agent
  serialPRQueue: boolean;  // Only allow 1 PR in review at a time
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
  maxAgentSlots: 3,
  maxParallelReviews: 3,
  autoPlayEnabled: false,
  autoPlayIntervalMs: 30000,  // 30 seconds
  batchingEnabled: true,      // Auto-batch related tickets by default
  // PM Mode defaults (off by default for backwards compat)
  agentMode: 'parallel-slots',
  serialPRQueue: false
};

export function getSettings(): OrchestratorSettings {
  const json = getSyncState('orchestrator_settings');
  if (!json) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(json) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Partial<OrchestratorSettings>): OrchestratorSettings {
  const current = getSettings();
  const updated = { ...current, ...settings };
  setSyncState('orchestrator_settings', JSON.stringify(updated));
  return updated;
}

// Command queue operations (for serializing heavy operations like test/build/lint)
export interface QueuedCommand {
  id: number;
  slot: number;
  command_type: string;
  command: string;
  status: 'waiting' | 'running' | 'done' | 'cancelled';
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export function enqueueCommand(slot: number, commandType: string, command: string): QueuedCommand {
  const result = db.query(`
    INSERT INTO command_queue (slot, command_type, command, status)
    VALUES (?, ?, ?, 'waiting')
  `).run(slot, commandType, command);

  return getQueuedCommandById(Number(result.lastInsertRowid))!;
}

export function getQueuedCommandById(id: number): QueuedCommand | undefined {
  return db.query('SELECT * FROM command_queue WHERE id = ?').get(id) as QueuedCommand | undefined;
}

export function getQueuePosition(id: number): number {
  // Count how many commands are ahead of this one (waiting or running, requested before this one)
  const cmd = getQueuedCommandById(id);
  if (!cmd) return -1;

  const ahead = db.query(`
    SELECT COUNT(*) as count FROM command_queue
    WHERE status IN ('waiting', 'running')
    AND requested_at < ?
  `).get(cmd.requested_at) as { count: number };

  return ahead.count;
}

export function canStartCommand(id: number): boolean {
  // Check if this command can start (no other commands running, and it's at the front of the queue)
  const cmd = getQueuedCommandById(id);
  if (!cmd || cmd.status !== 'waiting') return false;

  // Check if any command is currently running
  const running = db.query(`
    SELECT COUNT(*) as count FROM command_queue WHERE status = 'running'
  `).get() as { count: number };

  if (running.count > 0) return false;

  // Check if this is the oldest waiting command
  const oldest = db.query(`
    SELECT id FROM command_queue
    WHERE status = 'waiting'
    ORDER BY requested_at ASC
    LIMIT 1
  `).get() as { id: number } | undefined;

  return oldest?.id === id;
}

export function startCommand(id: number): boolean {
  if (!canStartCommand(id)) return false;

  db.query(`
    UPDATE command_queue
    SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  return true;
}

export function completeCommand(id: number): void {
  db.query(`
    UPDATE command_queue
    SET status = 'done', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

export function cancelCommand(id: number): void {
  db.query(`
    UPDATE command_queue
    SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

export function getRunningCommandForSlot(slot: number): QueuedCommand | null {
  const running = db.query(`
    SELECT * FROM command_queue
    WHERE slot = ? AND status = 'running'
    LIMIT 1
  `).get(slot) as QueuedCommand | undefined;
  return running || null;
}

export function getCommandQueueStatus(): { waiting: number; running: QueuedCommand | null; queue: QueuedCommand[] } {
  const waiting = db.query(`
    SELECT COUNT(*) as count FROM command_queue WHERE status = 'waiting'
  `).get() as { count: number };

  const running = db.query(`
    SELECT * FROM command_queue WHERE status = 'running' LIMIT 1
  `).get() as QueuedCommand | undefined;

  const queue = db.query(`
    SELECT * FROM command_queue
    WHERE status IN ('waiting', 'running')
    ORDER BY requested_at ASC
  `).all() as QueuedCommand[];

  return {
    waiting: waiting.count,
    running: running || null,
    queue
  };
}

export function cleanupOldQueueEntries(olderThanHours: number = 24): number {
  const result = db.query(`
    DELETE FROM command_queue
    WHERE status IN ('done', 'cancelled')
    AND completed_at < datetime('now', '-' || ? || ' hours')
  `).run(olderThanHours);

  return result.changes;
}

export function cancelStaleCommands(olderThanMinutes: number = 30): number {
  // Cancel commands that have been running for too long (likely orphaned)
  const result = db.query(`
    UPDATE command_queue
    SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
    WHERE status = 'running'
    AND started_at < datetime('now', '-' || ? || ' minutes')
  `).run(olderThanMinutes);

  return result.changes;
}

// ============================================
// State Transition Logging (for debugging)
// ============================================

export type TransitionSource =
  | 'autoplay'           // Starting from backlog
  | 'stale-detector'     // Agent process died
  | 'spawner-self-heal'  // Agent exited non-zero
  | 'pr-watcher'         // CI failure, merge conflict, etc
  | 'user-retry'         // Manual retry from UI
  | 'user-message'       // User sent message, interrupted agent
  | 'state-machine';     // Direct state machine call

export interface StateTransition {
  id: number;
  ticket_id: number;
  github_issue_number: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  source: TransitionSource;
  reason: string | null;
  timestamp: string;
}

/**
 * Log a state transition for audit/debugging purposes.
 * Call this whenever attempt_count, state, or other key fields change.
 */
export function logStateTransition(
  ticketId: number,
  issueNumber: number,
  field: string,
  oldValue: string | number | null,
  newValue: string | number | null,
  source: TransitionSource,
  reason?: string
): void {
  db.query(`
    INSERT INTO state_transitions (ticket_id, github_issue_number, field, old_value, new_value, source, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    issueNumber,
    field,
    oldValue?.toString() ?? null,
    newValue?.toString() ?? null,
    source,
    reason ?? null
  );

  // Also log to console for immediate visibility
  console.log(`[state-transition] #${issueNumber}: ${field} ${oldValue}→${newValue} (source=${source}${reason ? `, reason=${reason}` : ''})`);
}

/**
 * Get state transitions for a ticket (for debugging)
 */
export function getStateTransitions(ticketId: number, limit: number = 50): StateTransition[] {
  return db.query(`
    SELECT * FROM state_transitions
    WHERE ticket_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(ticketId, limit) as StateTransition[];
}

/**
 * Archive/flush logs for a completed ticket.
 * Moves agent_logs older than the retention period to a summary.
 */
export function archiveTicketLogs(ticketId: number, keepRecentCount: number = 100): { deleted: number; kept: number } {
  // Count total logs
  const total = db.query(`SELECT COUNT(*) as count FROM agent_logs WHERE ticket_id = ?`).get(ticketId) as { count: number };

  if (total.count <= keepRecentCount) {
    return { deleted: 0, kept: total.count };
  }

  // Delete oldest logs, keeping only the most recent ones
  const result = db.query(`
    DELETE FROM agent_logs
    WHERE ticket_id = ?
    AND id NOT IN (
      SELECT id FROM agent_logs
      WHERE ticket_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
  `).run(ticketId, ticketId, keepRecentCount);

  return { deleted: result.changes, kept: keepRecentCount };
}

/**
 * Cleanup old state transitions (keep last N days)
 */
export function cleanupOldTransitions(olderThanDays: number = 7): number {
  const result = db.query(`
    DELETE FROM state_transitions
    WHERE timestamp < datetime('now', '-' || ? || ' days')
  `).run(olderThanDays);

  return result.changes;
}

// ============================================
// Urgent Priority Helpers
// ============================================

/**
 * Get count of urgent tickets currently in_progress.
 * Used to enforce max 1 urgent at a time.
 */
export function getUrgentInProgressCount(): number {
  const result = db.query(`
    SELECT COUNT(*) as count FROM tickets
    WHERE state = 'in_progress' AND priority = 'urgent'
  `).get() as { count: number };
  return result.count;
}

/**
 * Find the lowest-priority running ticket for displacement.
 * Returns the ticket with lowest priority that's been running longest.
 * Excludes urgent tickets (can't displace urgent with urgent).
 */
export function getLowestPriorityRunningTicket(): Ticket | null {
  // Priority ordering: urgent=0, high=1, medium=2, low=3
  // We want the highest number (lowest priority) first, then oldest updated_at
  const ticket = db.query(`
    SELECT * FROM tickets
    WHERE state = 'in_progress'
      AND priority != 'urgent'
    ORDER BY
      CASE priority
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 2
      END DESC,
      updated_at ASC
    LIMIT 1
  `).get() as Ticket | undefined;

  return ticket || null;
}

/**
 * Check if urgent ticket already exists in queue or in progress.
 * Used to prevent multiple urgent tickets.
 */
export function hasUrgentTicketPending(): boolean {
  const result = db.query(`
    SELECT COUNT(*) as count FROM tickets
    WHERE priority = 'urgent'
      AND state IN ('backlog', 'in_progress')
  `).get() as { count: number };
  return result.count > 0;
}

// ============================================
// Batch Operations
// ============================================

export interface CreateBatchInput {
  area_key: string;
  name?: string;
}

export function createBatch(input: CreateBatchInput): Batch {
  const result = db.query(`
    INSERT INTO batches (area_key, name)
    VALUES (?, ?)
  `).run(input.area_key, input.name || `Batch: ${input.area_key}`);

  return getBatchById(Number(result.lastInsertRowid))!;
}

export function getBatchById(id: number): Batch | undefined {
  return db.query('SELECT * FROM batches WHERE id = ?').get(id) as Batch | undefined;
}

export function getBatchBySlot(slot: number): Batch | undefined {
  return db.query('SELECT * FROM batches WHERE worktree_slot = ?').get(slot) as Batch | undefined;
}

export function getBatchesByState(state: BatchState): Batch[] {
  return db.query('SELECT * FROM batches WHERE state = ? ORDER BY created_at ASC').all(state) as Batch[];
}

export function getAllBatches(): Batch[] {
  return db.query('SELECT * FROM batches ORDER BY created_at DESC').all() as Batch[];
}

export function getTicketsInBatch(batchId: number): Ticket[] {
  return db.query('SELECT * FROM tickets WHERE batch_id = ? ORDER BY id ASC').all(batchId) as Ticket[];
}

export function updateBatch(id: number, changes: Partial<Batch>): Batch | undefined {
  const allowedFields = [
    'name', 'area_key', 'state', 'worktree_slot', 'pr_number', 'pr_url',
    'branch_name', 'current_score', 'attempt_count', 'needs_attention', 'attention_reason'
  ];

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(changes)) {
    if (allowedFields.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }

  if (updates.length === 0) return getBatchById(id);

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const sql = `UPDATE batches SET ${updates.join(', ')} WHERE id = ?`;
  db.query(sql).run(...values);

  return getBatchById(id);
}

export function deleteBatch(id: number): boolean {
  // First unassign all tickets from batch
  db.query('UPDATE tickets SET batch_id = NULL WHERE batch_id = ?').run(id);
  const result = db.query('DELETE FROM batches WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get count of batches in active states (pending, in_progress, in_review)
 */
export function getActiveBatchCount(): number {
  const result = db.query(`
    SELECT COUNT(*) as count FROM batches
    WHERE state IN ('pending', 'in_progress', 'in_review')
  `).get() as { count: number };
  return result.count;
}

/**
 * Get tickets in backlog that are not part of any batch
 */
export function getUnbatchedBacklogTickets(): Ticket[] {
  return db.query(`
    SELECT * FROM tickets
    WHERE state = 'backlog'
      AND batch_id IS NULL
      AND paused = 0
    ORDER BY
      CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 2
      END,
      position ASC,
      created_at ASC
  `).all() as Ticket[];
}

// ============================================
// Merge Queue Operations
// ============================================

/**
 * Add a PR to the merge queue
 */
export function addToMergeQueue(
  ticketId: number,
  prNumber: number,
  priority: number = 0,
  lane: string = 'default'
): MergeQueueEntry {
  // Get next position for this lane
  const maxPos = db.query(`
    SELECT MAX(position) as max_pos FROM merge_queue
    WHERE lane = ? AND status IN ('waiting', 'merging')
  `).get(lane) as { max_pos: number | null };

  const position = (maxPos?.max_pos ?? -1) + 1;

  const result = db.query(`
    INSERT INTO merge_queue (ticket_id, pr_number, position, priority, lane, status, entered_at)
    VALUES (?, ?, ?, ?, ?, 'waiting', CURRENT_TIMESTAMP)
  `).run(ticketId, prNumber, position, priority, lane);

  // Also update ticket's merge_queue_position
  updateTicket(ticketId, { merge_queue_position: position, merge_queue_priority: priority });

  return getMergeQueueEntryById(Number(result.lastInsertRowid))!;
}

/**
 * Get a merge queue entry by ID
 */
export function getMergeQueueEntryById(id: number): MergeQueueEntry | undefined {
  return db.query('SELECT * FROM merge_queue WHERE id = ?').get(id) as MergeQueueEntry | undefined;
}

/**
 * Get a merge queue entry by ticket ID
 */
export function getMergeQueueEntryByTicketId(ticketId: number): MergeQueueEntry | undefined {
  return db.query(`
    SELECT * FROM merge_queue
    WHERE ticket_id = ? AND status IN ('waiting', 'merging')
    ORDER BY entered_at DESC LIMIT 1
  `).get(ticketId) as MergeQueueEntry | undefined;
}

/**
 * Get all active entries in the merge queue
 */
export function getMergeQueue(): MergeQueueEntry[] {
  return db.query(`
    SELECT * FROM merge_queue
    WHERE status IN ('waiting', 'merging')
    ORDER BY priority DESC, position ASC
  `).all() as MergeQueueEntry[];
}

/**
 * Get merge queue entries by status
 */
export function getMergeQueueByStatus(status: MergeQueueStatus): MergeQueueEntry[] {
  return db.query(`
    SELECT * FROM merge_queue
    WHERE status = ?
    ORDER BY priority DESC, position ASC
  `).all(status) as MergeQueueEntry[];
}

/**
 * Get the next entry ready to merge in a lane
 */
export function getNextToMerge(lane?: string): MergeQueueEntry | undefined {
  // Check if anything is currently merging in this lane
  const merging = db.query(`
    SELECT * FROM merge_queue
    WHERE status = 'merging'
    ${lane ? "AND lane = ?" : ""}
    LIMIT 1
  `).get(...(lane ? [lane] : [])) as MergeQueueEntry | undefined;

  if (merging) return undefined; // Something is already merging

  // Get the highest priority waiting entry
  return db.query(`
    SELECT * FROM merge_queue
    WHERE status = 'waiting'
    ${lane ? "AND lane = ?" : ""}
    ORDER BY priority DESC, position ASC
    LIMIT 1
  `).get(...(lane ? [lane] : [])) as MergeQueueEntry | undefined;
}

/**
 * Start merging an entry
 */
export function startMerging(id: number): boolean {
  const result = db.query(`
    UPDATE merge_queue
    SET status = 'merging', started_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'waiting'
  `).run(id);

  return result.changes > 0;
}

/**
 * Mark a merge as completed successfully
 */
export function completeMerge(id: number): void {
  const entry = getMergeQueueEntryById(id);
  if (!entry) return;

  db.query(`
    UPDATE merge_queue
    SET status = 'merged', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  // Clear ticket's merge queue position
  updateTicket(entry.ticket_id, { merge_queue_position: null });
}

/**
 * Mark a merge as failed
 */
export function failMerge(id: number, reason: string): void {
  const entry = getMergeQueueEntryById(id);
  if (!entry) return;

  db.query(`
    UPDATE merge_queue
    SET status = 'failed', completed_at = CURRENT_TIMESTAMP, failure_reason = ?
    WHERE id = ?
  `).run(reason, id);

  // Clear ticket's merge queue position
  updateTicket(entry.ticket_id, { merge_queue_position: null });
}

/**
 * Remove an entry from the queue (manual removal)
 */
export function removeFromMergeQueue(ticketId: number): boolean {
  const entry = getMergeQueueEntryByTicketId(ticketId);
  if (!entry) return false;

  db.query(`
    UPDATE merge_queue
    SET status = 'removed', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(entry.id);

  // Clear ticket's merge queue position
  updateTicket(ticketId, { merge_queue_position: null });

  return true;
}

/**
 * Update the priority of an entry
 */
export function setMergeQueuePriority(ticketId: number, priority: number): boolean {
  const entry = getMergeQueueEntryByTicketId(ticketId);
  if (!entry) return false;

  db.query(`
    UPDATE merge_queue SET priority = ? WHERE id = ?
  `).run(priority, entry.id);

  updateTicket(ticketId, { merge_queue_priority: priority });

  return true;
}

/**
 * Reorder an entry to a new position
 */
export function reorderMergeQueue(ticketId: number, newPosition: number): boolean {
  const entry = getMergeQueueEntryByTicketId(ticketId);
  if (!entry || entry.status !== 'waiting') return false;

  const oldPosition = entry.position;
  const lane = entry.lane;

  if (newPosition === oldPosition) return true;

  // Shift other entries
  if (newPosition < oldPosition) {
    // Moving up - shift entries down
    db.query(`
      UPDATE merge_queue
      SET position = position + 1
      WHERE lane = ? AND status = 'waiting'
        AND position >= ? AND position < ?
    `).run(lane, newPosition, oldPosition);
  } else {
    // Moving down - shift entries up
    db.query(`
      UPDATE merge_queue
      SET position = position - 1
      WHERE lane = ? AND status = 'waiting'
        AND position > ? AND position <= ?
    `).run(lane, oldPosition, newPosition);
  }

  // Update the entry's position
  db.query(`
    UPDATE merge_queue SET position = ? WHERE id = ?
  `).run(newPosition, entry.id);

  updateTicket(ticketId, { merge_queue_position: newPosition });

  return true;
}

/**
 * Get queue status for API/UI
 */
export function getMergeQueueStatus(): {
  queue: MergeQueueEntry[];
  lanes: string[];
  currentlyMerging: MergeQueueEntry | null;
  paused: boolean;
} {
  const queue = getMergeQueue();

  // Get distinct lanes
  const lanesResult = db.query(`
    SELECT DISTINCT lane FROM merge_queue
    WHERE status IN ('waiting', 'merging')
  `).all() as { lane: string }[];

  const currentlyMerging = db.query(`
    SELECT * FROM merge_queue WHERE status = 'merging' LIMIT 1
  `).get() as MergeQueueEntry | undefined;

  // Check if queue is paused (stored in sync_state)
  const pausedStr = getSyncState('merge_queue_paused');
  const paused = pausedStr === 'true';

  return {
    queue,
    lanes: lanesResult.map(r => r.lane),
    currentlyMerging: currentlyMerging || null,
    paused
  };
}

/**
 * Pause/resume the merge queue
 */
export function setMergeQueuePaused(paused: boolean): void {
  setSyncState('merge_queue_paused', paused ? 'true' : 'false');
}

/**
 * Check if merge queue is paused
 */
export function isMergeQueuePaused(): boolean {
  return getSyncState('merge_queue_paused') === 'true';
}

/**
 * Check if a ticket is already in the merge queue
 */
export function isInMergeQueue(ticketId: number): boolean {
  const entry = getMergeQueueEntryByTicketId(ticketId);
  return !!entry;
}

/**
 * Clean up old completed/failed merge queue entries
 */
export function cleanupOldMergeQueueEntries(olderThanHours: number = 24): number {
  const result = db.query(`
    DELETE FROM merge_queue
    WHERE status IN ('merged', 'failed', 'removed')
    AND completed_at < datetime('now', '-' || ? || ' hours')
  `).run(olderThanHours);

  return result.changes;
}

// ============================================================================
// Agent Handoffs (PM Mode persistent state)
// ============================================================================

export interface PlannedBatch {
  label: string;
  tickets: number[];
  strategy: 'combine' | 'parallel' | 'sequential';
  status: 'planned' | 'in_progress' | 'pr_open' | 'merged' | 'failed';
  dependsOn?: string[];
  prNumber?: number;
  notes?: string;
}

export interface PRStatus {
  pr: number;
  status: 'ci_pending' | 'ci_running' | 'ci_passing' | 'ci_failing' | 'merged';
  issues: string[];
}

export interface PendingAction {
  type: 'fix_ci' | 'resolve_conflicts' | 'reply_comment' | 'create_followup';
  target: string;
  details: string;
}

export interface AgentHandoff {
  id: number;
  created_at: string;
  planned_batches: PlannedBatch[];
  active_batch: string | null;
  pr_statuses: PRStatus[];
  pending_actions: PendingAction[];
  resume_instructions: string;
  context_percentage: number | null;
  cleared_at: string | null;
}

/**
 * Create a new handoff record
 */
export function createHandoff(handoff: Omit<AgentHandoff, 'id' | 'created_at' | 'cleared_at'>): AgentHandoff {
  const result = db.query(`
    INSERT INTO agent_handoffs (
      planned_batches, active_batch, pr_statuses,
      pending_actions, resume_instructions, context_percentage
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(handoff.planned_batches),
    handoff.active_batch,
    JSON.stringify(handoff.pr_statuses),
    JSON.stringify(handoff.pending_actions),
    handoff.resume_instructions,
    handoff.context_percentage
  );

  return getHandoffById(Number(result.lastInsertRowid))!;
}

/**
 * Get a handoff by ID
 */
export function getHandoffById(id: number): AgentHandoff | undefined {
  const row = db.query('SELECT * FROM agent_handoffs WHERE id = ?').get(id) as {
    id: number;
    created_at: string;
    planned_batches: string | null;
    active_batch: string | null;
    pr_statuses: string | null;
    pending_actions: string | null;
    resume_instructions: string | null;
    context_percentage: number | null;
    cleared_at: string | null;
  } | undefined;

  if (!row) return undefined;

  return {
    id: row.id,
    created_at: row.created_at,
    planned_batches: row.planned_batches ? JSON.parse(row.planned_batches) : [],
    active_batch: row.active_batch,
    pr_statuses: row.pr_statuses ? JSON.parse(row.pr_statuses) : [],
    pending_actions: row.pending_actions ? JSON.parse(row.pending_actions) : [],
    resume_instructions: row.resume_instructions || '',
    context_percentage: row.context_percentage,
    cleared_at: row.cleared_at
  };
}

/**
 * Get the latest handoff (most recent)
 */
export function getLatestHandoff(): AgentHandoff | undefined {
  const row = db.query('SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT 1').get() as {
    id: number;
    created_at: string;
    planned_batches: string | null;
    active_batch: string | null;
    pr_statuses: string | null;
    pending_actions: string | null;
    resume_instructions: string | null;
    context_percentage: number | null;
    cleared_at: string | null;
  } | undefined;

  if (!row) return undefined;

  return {
    id: row.id,
    created_at: row.created_at,
    planned_batches: row.planned_batches ? JSON.parse(row.planned_batches) : [],
    active_batch: row.active_batch,
    pr_statuses: row.pr_statuses ? JSON.parse(row.pr_statuses) : [],
    pending_actions: row.pending_actions ? JSON.parse(row.pending_actions) : [],
    resume_instructions: row.resume_instructions || '',
    context_percentage: row.context_percentage,
    cleared_at: row.cleared_at
  };
}

/**
 * Get the latest uncleared handoff (needs resuming)
 */
export function getUnclearedHandoff(): AgentHandoff | undefined {
  const row = db.query('SELECT * FROM agent_handoffs WHERE cleared_at IS NULL ORDER BY created_at DESC LIMIT 1').get() as {
    id: number;
    created_at: string;
    planned_batches: string | null;
    active_batch: string | null;
    pr_statuses: string | null;
    pending_actions: string | null;
    resume_instructions: string | null;
    context_percentage: number | null;
    cleared_at: string | null;
  } | undefined;

  if (!row) return undefined;

  return {
    id: row.id,
    created_at: row.created_at,
    planned_batches: row.planned_batches ? JSON.parse(row.planned_batches) : [],
    active_batch: row.active_batch,
    pr_statuses: row.pr_statuses ? JSON.parse(row.pr_statuses) : [],
    pending_actions: row.pending_actions ? JSON.parse(row.pending_actions) : [],
    resume_instructions: row.resume_instructions || '',
    context_percentage: row.context_percentage,
    cleared_at: row.cleared_at
  };
}

/**
 * Mark a handoff as cleared (context was cleared after this handoff)
 */
export function markHandoffCleared(id: number): void {
  db.query(`
    UPDATE agent_handoffs
    SET cleared_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

/**
 * Update a handoff with new state
 */
export function updateHandoff(id: number, updates: Partial<Omit<AgentHandoff, 'id' | 'created_at'>>): void {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.planned_batches !== undefined) {
    setClauses.push('planned_batches = ?');
    values.push(JSON.stringify(updates.planned_batches));
  }
  if (updates.active_batch !== undefined) {
    setClauses.push('active_batch = ?');
    values.push(updates.active_batch);
  }
  if (updates.pr_statuses !== undefined) {
    setClauses.push('pr_statuses = ?');
    values.push(JSON.stringify(updates.pr_statuses));
  }
  if (updates.pending_actions !== undefined) {
    setClauses.push('pending_actions = ?');
    values.push(JSON.stringify(updates.pending_actions));
  }
  if (updates.resume_instructions !== undefined) {
    setClauses.push('resume_instructions = ?');
    values.push(updates.resume_instructions);
  }
  if (updates.context_percentage !== undefined) {
    setClauses.push('context_percentage = ?');
    values.push(updates.context_percentage);
  }
  if (updates.cleared_at !== undefined) {
    setClauses.push('cleared_at = ?');
    values.push(updates.cleared_at);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.query(`UPDATE agent_handoffs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Delete old handoffs (cleanup)
 */
export function cleanupOldHandoffs(keepLast: number = 10): number {
  // Get IDs to keep
  const keepIds = db.query(`
    SELECT id FROM agent_handoffs ORDER BY created_at DESC LIMIT ?
  `).all(keepLast) as { id: number }[];

  if (keepIds.length === 0) return 0;

  const idsToKeep = keepIds.map(r => r.id);
  const placeholders = idsToKeep.map(() => '?').join(',');

  const result = db.query(`
    DELETE FROM agent_handoffs WHERE id NOT IN (${placeholders})
  `).run(...idsToKeep);

  return result.changes;
}
