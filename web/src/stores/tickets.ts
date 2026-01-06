import { create } from 'zustand';
import type { Ticket, WorktreeSlot, Config, AgentEvent, AgentTodo, ChatMessage, ServerMessage, PollStatus, ActivityEntry } from '../lib/types';

interface PipelineStatus {
  paused: boolean;
  reason: string;
  pausedAt: string;
}

interface OrchestratorSettings {
  maxAgentSlots: number;
  maxParallelReviews: number;
  autoPlayEnabled: boolean;
  autoPlayIntervalMs: number;
}

interface AutoplayStatus {
  enabled: boolean;
  active: boolean;
  intervalMs: number;
}

interface ReviewProgress {
  inProgress: boolean;
  activeTicketIds: Set<number>; // Currently being reviewed
  completedCount: number;
  totalCount: number;
  results: Map<number, { verdict: string; error?: string }>; // Results per ticket
  output: string; // Latest output from review agent
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

interface TicketsState {
  tickets: Ticket[];
  slots: WorktreeSlot[];
  config: Config | null;
  settings: OrchestratorSettings;
  connected: boolean;
  selectedTicketId: number | null;
  agentLogs: Map<number, AgentEvent[]>;
  agentTodos: Map<number, AgentTodo[]>;
  agentContexts: Map<number, AgentContext>;
  chatMessages: Map<number, ChatMessage[]>;
  reviewQueueIds: Set<number>; // Tickets selected for batch review
  reviewProgress: ReviewProgress;
  pipelineStatus: PipelineStatus;
  autoplayStatus: AutoplayStatus;
  pollStatus: PollStatus;
  activityLog: ActivityEntry[];

  // Actions
  setConnected: (connected: boolean) => void;
  setInitialState: (tickets: Ticket[], slots: WorktreeSlot[], config: Config, agentLogs?: Record<number, AgentEvent[]>, agentTodos?: Record<number, AgentTodo[]>, pipelineStatus?: PipelineStatus, settings?: OrchestratorSettings, autoplayStatus?: AutoplayStatus, pollStatus?: PollStatus, activityLog?: ActivityEntry[]) => void;
  setPollStatus: (status: PollStatus) => void;
  addActivity: (activity: ActivityEntry) => void;
  setPipelineStatus: (status: PipelineStatus) => void;
  setAutoplayStatus: (status: AutoplayStatus) => void;
  setSettings: (settings: OrchestratorSettings) => void;
  addTicket: (ticket: Ticket) => void;
  updateTicket: (ticketId: number, changes: Partial<Ticket>) => void;
  removeTicket: (ticketId: number) => void;
  setSlots: (slots: WorktreeSlot[]) => void;
  selectTicket: (ticketId: number | null) => void;
  addAgentLog: (ticketId: number, event: AgentEvent) => void;
  setAgentTodos: (ticketId: number, todos: AgentTodo[]) => void;
  setAgentContext: (ticketId: number, context: AgentContext) => void;
  setChatMessages: (ticketId: number, messages: ChatMessage[]) => void;
  addChatMessage: (ticketId: number, message: ChatMessage) => void;
  markChatMessagesDelivered: (ticketId: number) => void;
  toggleReviewQueue: (ticketId: number) => void;
  clearReviewQueue: () => void;
  setReviewProgress: (progress: Partial<ReviewProgress>) => void;
  addReviewOutput: (output: string) => void;
  setReviewResult: (ticketId: number, result: { verdict: string; error?: string }) => void;

  // Selectors
  getTicketsByState: (state: Ticket['state']) => Ticket[];
  getSelectedTicket: () => Ticket | undefined;
}

export const useTicketsStore = create<TicketsState>((set, get) => ({
  tickets: [],
  slots: [
    { slot: 1, available: true, ticketId: null },
    { slot: 2, available: true, ticketId: null },
    { slot: 3, available: true, ticketId: null }
  ],
  config: null,
  settings: {
    maxAgentSlots: 3,
    maxParallelReviews: 3,
    autoPlayEnabled: false,
    autoPlayIntervalMs: 30000
  },
  connected: false,
  selectedTicketId: null,
  agentLogs: new Map(),
  agentTodos: new Map(),
  agentContexts: new Map(),
  chatMessages: new Map(),
  reviewQueueIds: new Set(),
  reviewProgress: {
    inProgress: false,
    activeTicketIds: new Set(),
    completedCount: 0,
    totalCount: 0,
    results: new Map(),
    output: ''
  },
  pipelineStatus: { paused: false, reason: '', pausedAt: '' },
  autoplayStatus: { enabled: false, active: false, intervalMs: 30000 },
  pollStatus: {
    prWatch: { lastRun: null, nextRun: null, intervalMs: 120000, ticketsChecked: 0 },
    issueSync: { lastRun: null, nextRun: null, intervalMs: 60000 }
  },
  activityLog: [],

  setConnected: (connected) => set({ connected }),

  setPollStatus: (status) => set({ pollStatus: status }),

  addActivity: (activity) => set((state) => ({
    activityLog: [activity, ...state.activityLog].slice(0, 50) // Keep last 50
  })),

  setPipelineStatus: (status) => set({ pipelineStatus: status }),

  setAutoplayStatus: (status) => set({ autoplayStatus: status }),

  setInitialState: (tickets, slots, config, agentLogs, agentTodos, pipelineStatus, settings, autoplayStatus, pollStatus, activityLog) => set({
    tickets,  // Replace all tickets on init
    slots,
    config,
    agentLogs: agentLogs
      ? new Map(Object.entries(agentLogs).map(([k, v]) => [parseInt(k), v]))
      : new Map(),
    agentTodos: agentTodos
      ? new Map(Object.entries(agentTodos).map(([k, v]) => [parseInt(k), v]))
      : new Map(),
    pipelineStatus: pipelineStatus || { paused: false, reason: '', pausedAt: '' },
    autoplayStatus: autoplayStatus || { enabled: false, active: false, intervalMs: 30000 },
    settings: settings || { maxAgentSlots: 3, maxParallelReviews: 3, autoPlayEnabled: false, autoPlayIntervalMs: 30000 },
    pollStatus: pollStatus || {
      prWatch: { lastRun: null, nextRun: null, intervalMs: 120000, ticketsChecked: 0 },
      issueSync: { lastRun: null, nextRun: null, intervalMs: 60000 }
    },
    activityLog: activityLog || []
  }),

  setSettings: (settings) => set({ settings }),

  addTicket: (ticket) => set((state) => {
    // Prevent duplicates - check if ticket already exists
    if (state.tickets.some(t => t.id === ticket.id)) {
      return state;
    }
    return { tickets: [ticket, ...state.tickets] };
  }),

  updateTicket: (ticketId, changes) => set((state) => ({
    tickets: state.tickets.map(t =>
      t.id === ticketId ? { ...t, ...changes } : t
    )
  })),

  removeTicket: (ticketId) => set((state) => ({
    tickets: state.tickets.filter(t => t.id !== ticketId),
    selectedTicketId: state.selectedTicketId === ticketId ? null : state.selectedTicketId
  })),

  setSlots: (slots) => set({ slots }),

  selectTicket: (ticketId) => set({ selectedTicketId: ticketId }),

  addAgentLog: (ticketId, event) => set((state) => {
    const logs = new Map(state.agentLogs);
    const existing = logs.get(ticketId) || [];
    logs.set(ticketId, [...existing, event].slice(-500)); // Keep last 500 logs
    return { agentLogs: logs };
  }),

  setAgentTodos: (ticketId, todos) => set((state) => {
    const newTodos = new Map(state.agentTodos);
    newTodos.set(ticketId, todos);
    return { agentTodos: newTodos };
  }),

  setAgentContext: (ticketId, context) => set((state) => {
    const newContexts = new Map(state.agentContexts);
    newContexts.set(ticketId, context);
    return { agentContexts: newContexts };
  }),

  setChatMessages: (ticketId, messages) => set((state) => {
    const newMessages = new Map(state.chatMessages);
    newMessages.set(ticketId, messages);
    return { chatMessages: newMessages };
  }),

  addChatMessage: (ticketId, message) => set((state) => {
    const newMessages = new Map(state.chatMessages);
    const existing = newMessages.get(ticketId) || [];
    // Prevent duplicates
    if (!existing.some(m => m.id === message.id)) {
      newMessages.set(ticketId, [...existing, message]);
    }
    return { chatMessages: newMessages };
  }),

  markChatMessagesDelivered: (ticketId) => set((state) => {
    const newMessages = new Map(state.chatMessages);
    const existing = newMessages.get(ticketId) || [];
    // Mark all pending messages as delivered
    const updated = existing.map(m => m.pending ? { ...m, pending: false } : m);
    newMessages.set(ticketId, updated);
    return { chatMessages: newMessages };
  }),

  toggleReviewQueue: (ticketId) => set((state) => {
    const newSet = new Set(state.reviewQueueIds);
    if (newSet.has(ticketId)) {
      newSet.delete(ticketId);
    } else {
      newSet.add(ticketId);
    }
    return { reviewQueueIds: newSet };
  }),

  clearReviewQueue: () => set({ reviewQueueIds: new Set() }),

  setReviewProgress: (progress) => set((state) => ({
    reviewProgress: { ...state.reviewProgress, ...progress }
  })),

  addReviewOutput: (output) => set((state) => ({
    reviewProgress: {
      ...state.reviewProgress,
      output: state.reviewProgress.output + output
    }
  })),

  setReviewResult: (ticketId, result) => set((state) => {
    const newResults = new Map(state.reviewProgress.results);
    newResults.set(ticketId, result);
    const newActive = new Set(state.reviewProgress.activeTicketIds);
    newActive.delete(ticketId);
    return {
      reviewProgress: {
        ...state.reviewProgress,
        results: newResults,
        activeTicketIds: newActive,
        completedCount: state.reviewProgress.completedCount + 1
      }
    };
  }),

  getTicketsByState: (ticketState) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return get().tickets
      .filter(t => t.state === ticketState)
      .sort((a, b) => {
        // Done column: sort by updated_at descending (most recent first)
        if (ticketState === 'done') {
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        }
        // Sort by priority first (high > medium > low)
        const priorityDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
        if (priorityDiff !== 0) return priorityDiff;
        // Then by position
        return (a.position ?? 0) - (b.position ?? 0);
      });
  },

  getSelectedTicket: () => {
    const { tickets, selectedTicketId } = get();
    return tickets.find(t => t.id === selectedTicketId);
  }
}));

// WebSocket message handler
export function handleServerMessage(message: ServerMessage): void {
  const store = useTicketsStore.getState();

  switch (message.type) {
    case 'init':
      store.setInitialState(
        message.tickets,
        message.slots,
        message.config,
        message.agentLogs,
        message.agentTodos,
        message.pipelineStatus,
        message.settings as unknown as OrchestratorSettings | undefined,
        message.autoplayStatus,
        message.pollStatus,
        message.activityLog
      );
      break;

    case 'poll_status':
      store.setPollStatus({
        prWatch: message.prWatch,
        issueSync: message.issueSync
      });
      break;

    case 'activity':
      store.addActivity(message.activity);
      break;

    case 'settings_updated':
      store.setSettings(message.settings as unknown as OrchestratorSettings);
      console.log('Settings updated:', message.settings);
      break;

    case 'pipeline_paused':
      store.setPipelineStatus({
        paused: true,
        reason: message.reason as string,
        pausedAt: message.pausedAt as string
      });
      console.log('Pipeline paused:', message.reason);
      break;

    case 'pipeline_resumed':
      store.setPipelineStatus({
        paused: false,
        reason: '',
        pausedAt: ''
      });
      console.log('Pipeline resumed');
      break;

    case 'autoplay_started':
    case 'autoplay_enabled':
      store.setAutoplayStatus({
        ...store.autoplayStatus,
        enabled: true,
        active: true
      });
      console.log('Auto-play enabled');
      break;

    case 'autoplay_stopped':
    case 'autoplay_disabled':
      store.setAutoplayStatus({
        ...store.autoplayStatus,
        enabled: false,
        active: false
      });
      console.log('Auto-play disabled');
      break;

    case 'autoplay_status':
      store.setAutoplayStatus({
        enabled: message.enabled as boolean,
        active: message.active as boolean,
        intervalMs: message.intervalMs as number
      });
      break;

    case 'review_started':
      // Review batch started
      store.setReviewProgress({
        inProgress: true,
        activeTicketIds: new Set(message.ticketIds as number[]),
        completedCount: 0,
        totalCount: (message.ticketIds as number[]).length,
        results: new Map(),
        output: ''
      });
      console.log('Review started for tickets:', message.ticketIds);
      break;

    case 'review_completed':
      // Review finished - clear the queue and reset progress
      store.clearReviewQueue();
      store.setReviewProgress({
        inProgress: false,
        activeTicketIds: new Set(),
        output: ''
      });
      console.log('Review completed:', message.results);
      break;

    case 'review_error':
      // Review failed
      store.setReviewProgress({ inProgress: false });
      console.error('Review error:', message.message);
      break;

    case 'batch_review_started':
      // Acknowledge that review started (initial ack before actual start)
      console.log('Batch review acknowledged for tickets:', message.ticketIds);
      break;

    case 'review_progress': {
      // Progress update during review - a ticket finished
      const results = message.results as Array<{ ticketId: number; verdict: string; error?: string }>;
      for (const result of results) {
        store.setReviewResult(result.ticketId, { verdict: result.verdict, error: result.error });
      }
      console.log(`Review progress: ${message.completed}/${message.total}`);
      break;
    }

    case 'review_output':
      // Output from review agent
      store.addReviewOutput(message.content as string);
      break;

    case 'ticket_created':
      store.addTicket(message.ticket);
      break;

    case 'ticket_updated':
      console.log('Ticket updated:', message.ticketId, message.changes);
      store.updateTicket(message.ticketId, message.changes);
      break;

    case 'ticket_started':
      store.updateTicket(message.ticketId, {
        state: 'in_progress',
        worktree_slot: message.slot
      });
      break;

    case 'ticket_completed':
      store.updateTicket(message.ticketId, {
        state: 'done',
        current_score: message.score,
        worktree_slot: null
      });
      break;

    case 'agent_output':
      store.addAgentLog(message.ticketId, message.event);
      break;

    case 'agent_todos':
      store.setAgentTodos(message.ticketId, message.todos);
      break;

    case 'agent_context':
      store.setAgentContext(message.ticketId, message.context as AgentContext);
      console.log(`Agent context for ticket ${message.ticketId}:`, message.context);
      break;

    case 'worktree_status':
      store.setSlots(message.slots);
      break;

    case 'ticket_removed':
      store.removeTicket(message.ticketId as number);
      break;

    case 'chat_messages':
      store.setChatMessages(message.ticketId, message.messages);
      break;

    case 'chat_message':
      store.addChatMessage(message.ticketId, message.message);
      break;

    case 'chat_messages_delivered':
      store.markChatMessagesDelivered(message.ticketId);
      break;

    case 'tickets_reordered': {
      // Update positions for reordered tickets
      const ticketIds = message.ticketIds;
      for (let i = 0; i < ticketIds.length; i++) {
        store.updateTicket(ticketIds[i], { position: i });
      }
      break;
    }

    case 'dependencies': {
      // Update dependencies for a ticket
      store.updateTicket(message.ticketId, {
        blocked_by: message.blockedBy,
        blocks: message.blocks
      });
      break;
    }

    case 'error':
      console.error('Server error:', message.message);
      break;
  }
}
