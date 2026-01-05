import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Ticket, AgentLog, TicketState, ChatMessage } from '../state/types';

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
    'needs_attention', 'attention_reason', 'retry_reason', 'priority', 'position'
  ];

  const updates: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(changes)) {
    if (allowedFields.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
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

  // Cap at 3 due to database CHECK constraint (worktree_slot BETWEEN 1 AND 3)
  // TODO: Update database schema if more slots are needed
  const maxSlots = Math.min(getSettings().maxAgentSlots, 3);
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
  verdict: 'ready' | 'minor_gaps' | 'needs_revision' | 'closed';
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
}

const DEFAULT_SETTINGS: OrchestratorSettings = {
  maxAgentSlots: 3,
  maxParallelReviews: 3,
  autoPlayEnabled: false,
  autoPlayIntervalMs: 30000  // 30 seconds
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
