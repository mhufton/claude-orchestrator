import { useEffect, useRef, useState, useMemo } from 'react';
import { X, Terminal, Filter, ChevronDown, Eye, EyeOff, ChevronRight, ListTodo, MessageSquare, GitPullRequest, ExternalLink, CheckCircle2, XCircle, Clock, FileText, ClipboardCheck, Settings, RotateCcw, Play, StopCircle, Archive, GitCommit, FilePlus, FileEdit, FileX, FileMinus2 } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { useWebSocket } from '../hooks/useWebSocket';
import { Spinner } from './Spinner';
import { TodosView } from './TodosView';
import { ChatView } from './ChatView';
import type { AgentEvent, PRDetails } from '../lib/types';

interface IssueReview {
  verdict: 'ready' | 'minor_gaps' | 'needs_revision' | 'closed';
  gaps: string[];
  recommendations: string | null;
  changes_made: string | null;
  reviewed_at: string;
}

interface GitCommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: Array<{ status: string; path: string }>;
}

interface LogViewerProps {
  ticketId: number;
  onClose: () => void;
}

interface ParsedEvent {
  type: 'tool' | 'thinking' | 'text' | 'error' | 'result' | 'unknown';
  icon: string;
  title: string;
  subtitle?: string;
  content?: string;
  diff?: { added: number; removed: number; lines: string[] };
  expandable: boolean;
}

// Strip ANSI color codes from terminal output
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '');
}

// Parse a tool_use block into display format
function parseToolUse(toolName: string, input?: Record<string, unknown>): ParsedEvent {
  let title = toolName;
  let subtitle = '';

  if (input) {
    switch (toolName) {
      case 'Read':
        title = `Read(${input.file_path || 'file'})`;
        if (input.limit) subtitle = `${input.limit} lines`;
        break;
      case 'Write':
        title = `Write(${input.file_path || 'file'})`;
        break;
      case 'Edit':
        title = `Update(${input.file_path || 'file'})`;
        break;
      case 'Bash':
        const cmd = (input.command as string) || '';
        title = `Bash`;
        subtitle = cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
        break;
      case 'Grep':
        title = `Grep("${input.pattern}")`;
        if (input.path) subtitle = `in ${input.path}`;
        break;
      case 'Glob':
        title = `Glob("${input.pattern}")`;
        if (input.path) subtitle = `in ${input.path}`;
        break;
      case 'Task':
        title = 'Task';
        subtitle = (input.description as string) || '';
        break;
      case 'TodoWrite':
        const todos = input.todos as Array<unknown> | undefined;
        title = 'TodoWrite';
        subtitle = todos ? `${todos.length} items` : '';
        break;
      default:
        const keys = Object.keys(input);
        if (keys.length > 0) {
          const val = input[keys[0]];
          if (typeof val === 'string') {
            subtitle = val.length > 50 ? val.slice(0, 50) + '...' : val;
          }
        }
    }
  }

  return {
    type: 'tool',
    icon: '●',
    title,
    subtitle,
    content: input ? JSON.stringify(input, null, 2) : undefined,
    expandable: !!input
  };
}

// Parse Claude CLI stream-json events into display format
function parseEvent(event: AgentEvent): ParsedEvent {
  let content = event.content;

  // The content might be the full Claude CLI event object
  // containing { type, message, ... } - unwrap it
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    // If content has a nested message with content blocks, that's what we want
    if (obj.message && typeof obj.message === 'object') {
      const msg = obj.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
      if (msg.content && Array.isArray(msg.content)) {
        // Extract tool_use and text blocks from the message
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.name) {
            return parseToolUse(block.name, block.input as Record<string, unknown> | undefined);
          }
          if (block.type === 'text' && block.text) {
            const text = block.text;
            return {
              type: 'text',
              icon: '○',
              title: text.length > 150 ? text.slice(0, 150) + '...' : text,
              content: text.length > 150 ? text : undefined,
              expandable: text.length > 150
            };
          }
        }
      }
    }
  }

  // Handle string content
  if (typeof content === 'string') {
    const cleaned = stripAnsi(content);
    if (event.type === 'thinking') {
      return {
        type: 'thinking',
        icon: '●',
        title: cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned,
        content: cleaned.length > 100 ? cleaned : undefined,
        expandable: cleaned.length > 100
      };
    }
    if (event.type === 'error') {
      return {
        type: 'error',
        icon: '✗',
        title: cleaned,
        expandable: false
      };
    }
    return {
      type: 'text',
      icon: '○',
      title: cleaned.length > 150 ? cleaned.slice(0, 150) + '...' : cleaned,
      content: cleaned.length > 150 ? cleaned : undefined,
      expandable: cleaned.length > 150
    };
  }

  // Handle structured content (object)
  const obj = content as Record<string, unknown>;

  // Tool use events
  if (obj.type === 'tool_use' || obj.name) {
    const toolName = (obj.name as string) || 'Tool';
    const input = obj.input as Record<string, unknown> | undefined;
    return parseToolUse(toolName, input);
  }

  // Tool result events
  if (obj.type === 'tool_result' || event.type === 'tool_result') {
    const rawContent = (obj.content as string) || '';
    const resultContent = stripAnsi(rawContent);
    const isError = obj.is_error as boolean;

    // Check if it's a diff (has +/- lines)
    const lines = resultContent.split('\n');
    const addedLines = lines.filter(l => l.startsWith('+')).length;
    const removedLines = lines.filter(l => l.startsWith('-')).length;

    if (addedLines > 0 || removedLines > 0) {
      return {
        type: 'result',
        icon: isError ? '✗' : '↳',
        title: `${addedLines > 0 ? `+${addedLines}` : ''}${addedLines > 0 && removedLines > 0 ? ' ' : ''}${removedLines > 0 ? `-${removedLines}` : ''} lines`,
        diff: { added: addedLines, removed: removedLines, lines: lines.slice(0, 20) },
        content: lines.length > 20 ? resultContent : undefined,
        expandable: lines.length > 20
      };
    }

    // Regular result - show brief summary
    const firstLine = resultContent.split('\n')[0] || '';
    const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
    return {
      type: 'result',
      icon: isError ? '✗' : '↳',
      title: truncated || '(empty)',
      content: resultContent.length > 80 ? resultContent : undefined,
      expandable: resultContent.length > 80
    };
  }

  // Thinking events
  if (obj.type === 'thinking' || obj.thinking) {
    const text = (obj.thinking as string) || (obj.content as string) || '';
    return {
      type: 'thinking',
      icon: '●',
      title: text.length > 100 ? text.slice(0, 100) + '...' : text,
      content: text.length > 100 ? text : undefined,
      expandable: text.length > 100
    };
  }

  // Text events
  if (obj.type === 'text' || obj.text) {
    const text = (obj.text as string) || (obj.content as string) || '';
    return {
      type: 'text',
      icon: '○',
      title: text.length > 150 ? text.slice(0, 150) + '...' : text,
      content: text.length > 150 ? text : undefined,
      expandable: text.length > 150
    };
  }

  // Assistant message with content blocks
  if (obj.message || obj.content) {
    const message = obj.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined;
    const blocks = message?.content || [];

    const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');
    const toolBlocks = blocks.filter(b => b.type === 'tool_use').map(b => b.name);

    if (textBlocks) {
      return {
        type: 'text',
        icon: '○',
        title: textBlocks.length > 150 ? textBlocks.slice(0, 150) + '...' : textBlocks,
        content: textBlocks.length > 150 ? textBlocks : undefined,
        expandable: textBlocks.length > 150
      };
    }
    if (toolBlocks.length > 0) {
      return {
        type: 'tool',
        icon: '●',
        title: `Using: ${toolBlocks.join(', ')}`,
        expandable: false
      };
    }
  }

  // Fallback - show as JSON
  const json = JSON.stringify(obj, null, 2);
  return {
    type: 'unknown',
    icon: '○',
    title: json.length > 80 ? json.slice(0, 80) + '...' : json,
    content: json.length > 80 ? json : undefined,
    expandable: json.length > 80
  };
}

// Estimate progress based on log patterns
function estimateProgress(events: ParsedEvent[]): { phase: string; percent: number } {
  const content = events.map(e => e.title.toLowerCase()).join(' ');

  if (content.includes('pr created') || content.includes('gh pr create')) {
    return { phase: 'Creating PR', percent: 95 };
  }
  if (content.includes('git push')) {
    return { phase: 'Pushing', percent: 85 };
  }
  if (content.includes('git commit')) {
    return { phase: 'Committing', percent: 75 };
  }
  if (content.includes('test') && content.includes('pass')) {
    return { phase: 'Tests passed', percent: 70 };
  }
  if (content.includes('npm test') || content.includes('bun test')) {
    return { phase: 'Testing', percent: 60 };
  }
  if (content.includes('update(') || content.includes('write(')) {
    return { phase: 'Writing code', percent: 40 };
  }
  if (content.includes('read(') || content.includes('grep')) {
    return { phase: 'Reading code', percent: 20 };
  }

  const toolCount = events.filter(e => e.type === 'tool').length;
  if (toolCount > 20) return { phase: 'Working', percent: 40 };
  if (toolCount > 10) return { phase: 'Working', percent: 25 };
  if (toolCount > 5) return { phase: 'Exploring', percent: 15 };
  if (events.length > 0) return { phase: 'Starting', percent: 5 };

  return { phase: 'Initializing', percent: 0 };
}

const TYPE_COLORS: Record<string, string> = {
  tool: 'text-blue-400',
  thinking: 'text-purple-400',
  text: 'text-gray-300',
  error: 'text-red-400',
  result: 'text-green-400',
  unknown: 'text-gray-500'
};

const LOG_TYPE_FILTERS = [
  { key: 'tool', label: 'Tools', color: 'text-blue-400' },
  { key: 'result', label: 'Results', color: 'text-green-400' },
  { key: 'thinking', label: 'Thinking', color: 'text-purple-400' },
  { key: 'text', label: 'Text', color: 'text-gray-300' },
  { key: 'error', label: 'Errors', color: 'text-red-400' },
];

export function LogViewer({ ticketId, onClose }: LogViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [compactMode, setCompactMode] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<'todos' | 'logs' | 'chat' | 'issue' | 'pr' | 'review' | 'commits'>('todos');
  const [prDetails, setPRDetails] = useState<PRDetails | null>(null);
  const [prLoading, setPRLoading] = useState(false);
  const [prError, setPRError] = useState<string | null>(null);
  const [issueReview, setIssueReview] = useState<IssueReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsBranch, setCommitsBranch] = useState<string | null>(null);
  const { send } = useWebSocket();
  const chatMessages = useTicketsStore(state => state.chatMessages.get(ticketId) || []);
  const pendingChatCount = chatMessages.filter(m => m.pending).length;

  const ticket = useTicketsStore(state => state.tickets.find(t => t.id === ticketId));
  const logs = useTicketsStore(state => state.agentLogs.get(ticketId) || []);
  const todos = useTicketsStore(state => state.agentTodos.get(ticketId) || []);
  const agentContext = useTicketsStore(state => state.agentContexts.get(ticketId));
  const hasPR = Boolean(ticket?.pr_number);

  // Auto-switch to PR tab for in_review/done tickets
  useEffect(() => {
    if (hasPR && (ticket?.state === 'in_review' || ticket?.state === 'done')) {
      setActiveTab('pr');
    }
  }, [hasPR, ticket?.state]);

  // Fetch review results when review tab is active
  useEffect(() => {
    if (activeTab !== 'review') return;

    setReviewLoading(true);

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'review_result' && data.ticketId === ticketId) {
          setIssueReview(data.review);
          setReviewLoading(false);
        }
      } catch (e) {
        console.error('Error parsing review message:', e);
      }
    };

    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.addEventListener('message', handleMessage);
      ws.send(JSON.stringify({ type: 'get_review', ticketId }));
    }

    return () => {
      if (ws) ws.removeEventListener('message', handleMessage);
    };
  }, [activeTab, ticketId]);

  // Fetch PR details when PR tab is active
  useEffect(() => {
    if (activeTab !== 'pr' || !hasPR || !ticket?.pr_number) return;

    setPRLoading(true);
    setPRError(null);

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pr_details' && data.ticketId === ticketId) {
          setPRDetails(data.prDetails);
          setPRLoading(false);
        }
        if (data.type === 'error' && data.ticketId === ticketId) {
          setPRError(data.message);
          setPRLoading(false);
        }
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    };

    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.addEventListener('message', handleMessage);
      ws.send(JSON.stringify({ type: 'get_pr_details', ticketId }));
    }

    // Auto-refresh every 30 seconds when on PR tab
    const refreshInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'get_pr_details', ticketId }));
      }
    }, 30000);

    return () => {
      if (ws) ws.removeEventListener('message', handleMessage);
      clearInterval(refreshInterval);
    };
  }, [activeTab, hasPR, ticketId, ticket?.pr_number]);

  // Fetch commits when commits tab is active
  useEffect(() => {
    if (activeTab !== 'commits') return;
    if (!ticket?.worktree_slot) return;

    setCommitsLoading(true);

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'commits' && data.ticketId === ticketId) {
          setCommits(data.commits || []);
          setCommitsBranch(data.branchName || null);
          setCommitsLoading(false);
        }
      } catch (e) {
        console.error('Error parsing commits message:', e);
      }
    };

    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.addEventListener('message', handleMessage);
      ws.send(JSON.stringify({ type: 'get_commits', ticketId }));
    }

    return () => {
      if (ws) ws.removeEventListener('message', handleMessage);
    };
  }, [activeTab, ticketId, ticket?.worktree_slot]);

  // Parse all events with timestamps
  const parsedEvents = useMemo(() => logs.map((log, i) => ({
    ...parseEvent(log),
    timestamp: log.timestamp,
    originalIndex: i
  })), [logs]);

  const progress = useMemo(() => estimateProgress(parsedEvents), [parsedEvents]);

  const filteredEvents = useMemo(() => {
    const filtered = parsedEvents.filter((event) => {
      if (hiddenTypes.has(event.type)) return false;
      if (compactMode) {
        // Hide empty or very short entries
        if (event.title.length < 3) return false;
        // Hide raw JSON in compact mode
        if (event.title.startsWith('{')) return false;
      }
      return true;
    });
    // Reverse to show most recent first (live feed style)
    return [...filtered].reverse();
  }, [parsedEvents, compactMode, hiddenTypes]);

  // Format timestamp to show just time (HH:MM:SS)
  const formatTime = (timestamp?: string) => {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return '';
    }
  };

  // For reversed logs (newest at top), auto-scroll keeps us at the TOP
  // so we see the newest entries as they come in
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      // Scroll to top (where newest entries are in reversed mode)
      scrollRef.current.scrollTop = 0;
    }
  }, [filteredEvents, autoScroll]);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop } = scrollRef.current;
      // For reversed logs, "following new entries" means being at the top
      const isAtTop = scrollTop < 50;
      setAutoScroll(isAtTop);
    }
  };

  // ESC key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close settings dropdown first if open
        if (showSettings) {
          setShowSettings(false);
        } else if (showFilters) {
          setShowFilters(false);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, showSettings, showFilters]);

  if (!ticket) return null;

  const toggleType = (type: string) => {
    const newHidden = new Set(hiddenTypes);
    if (newHidden.has(type)) {
      newHidden.delete(type);
    } else {
      newHidden.add(type);
    }
    setHiddenTypes(newHidden);
  };

  const toggleExpanded = (index: number) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedRows(newExpanded);
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-lg w-full max-w-4xl h-[80vh] flex flex-col border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <Terminal className="text-green-400" size={20} />
            <div>
              <h2 className="font-semibold">Agent Activity</h2>
              <p className="text-sm text-gray-400">
                #{ticket.github_issue_number} - {ticket.title}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded">
            <X size={20} />
          </button>
        </div>

        {/* Agent Context Banner - shows what the agent is working on */}
        {agentContext && (
          <div className="px-4 py-3 bg-blue-900/30 border-b border-blue-800/50">
            <div className="text-sm font-medium text-blue-300 mb-2">
              {agentContext.summary}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {agentContext.hasMergeConflicts && (
                <span className="px-2 py-1 bg-orange-900/50 text-orange-300 rounded">
                  Merge Conflicts
                </span>
              )}
              {agentContext.ciFailures.length > 0 && (
                <span className="px-2 py-1 bg-red-900/50 text-red-300 rounded">
                  {agentContext.ciFailures.length} CI Failure(s)
                </span>
              )}
              {agentContext.inlineComments.length > 0 && (
                <span className="px-2 py-1 bg-purple-900/50 text-purple-300 rounded">
                  {agentContext.inlineComments.length} Review Comment(s)
                </span>
              )}
              {agentContext.userMessages.length > 0 && (
                <span className="px-2 py-1 bg-green-900/50 text-green-300 rounded">
                  {agentContext.userMessages.length} User Message(s)
                </span>
              )}
              {agentContext.previousScore !== null && (
                <span className="px-2 py-1 bg-yellow-900/50 text-yellow-300 rounded">
                  Previous Score: {agentContext.previousScore}
                </span>
              )}
            </div>
            {/* Show first few items from each category */}
            {agentContext.inlineComments.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-300">
                  Show review comments ({agentContext.inlineComments.length})
                </summary>
                <ul className="mt-1 space-y-1 text-xs text-gray-400 max-h-32 overflow-y-auto">
                  {agentContext.inlineComments.slice(0, 5).map((comment, i) => (
                    <li key={i} className="pl-2 border-l border-gray-600">
                      {comment.length > 150 ? comment.slice(0, 150) + '...' : comment}
                    </li>
                  ))}
                  {agentContext.inlineComments.length > 5 && (
                    <li className="text-gray-500">
                      +{agentContext.inlineComments.length - 5} more...
                    </li>
                  )}
                </ul>
              </details>
            )}
            {agentContext.ciFailures.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-300">
                  Show CI failures ({agentContext.ciFailures.length})
                </summary>
                <ul className="mt-1 space-y-1 text-xs text-gray-400 max-h-32 overflow-y-auto">
                  {agentContext.ciFailures.slice(0, 3).map((failure, i) => (
                    <li key={i} className="pl-2 border-l border-red-600">
                      {failure.length > 200 ? failure.slice(0, 200) + '...' : failure}
                    </li>
                  ))}
                  {agentContext.ciFailures.length > 3 && (
                    <li className="text-gray-500">
                      +{agentContext.ciFailures.length - 3} more...
                    </li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setActiveTab('todos')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'todos'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <ListTodo size={16} />
            Tasks
            {todos.length > 0 && (
              <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded">
                {todos.filter(t => t.status === 'completed').length}/{todos.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <Terminal size={16} />
            Logs
            <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded">
              {filteredEvents.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'chat'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <MessageSquare size={16} />
            Chat
            {pendingChatCount > 0 && (
              <span className="text-xs bg-yellow-600 px-1.5 py-0.5 rounded">
                {pendingChatCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('issue')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'issue'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <FileText size={16} />
            Issue
          </button>
          {ticket?.state === 'needs_review' && (
            <button
              onClick={() => setActiveTab('review')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'review'
                  ? 'border-purple-500 text-purple-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <ClipboardCheck size={16} />
              Review
              {issueReview && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  issueReview.verdict === 'ready' ? 'bg-green-600' :
                  issueReview.verdict === 'minor_gaps' ? 'bg-yellow-600' :
                  issueReview.verdict === 'needs_revision' ? 'bg-orange-600' :
                  'bg-red-600'
                }`}>
                  {issueReview.verdict === 'ready' ? '✓' :
                   issueReview.verdict === 'minor_gaps' ? '~' :
                   issueReview.verdict === 'needs_revision' ? '!' : '✗'}
                </span>
              )}
            </button>
          )}
          {hasPR && (
            <button
              onClick={() => setActiveTab('pr')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'pr'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <GitPullRequest size={16} />
              PR
              {prDetails && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  prDetails.ciStatus === 'success' ? 'bg-green-600' :
                  prDetails.ciStatus === 'failure' ? 'bg-red-600' :
                  prDetails.ciStatus === 'pending' ? 'bg-yellow-600' : 'bg-gray-600'
                }`}>
                  {prDetails.reviewScore ?? '—'}
                </span>
              )}
            </button>
          )}
          {ticket?.worktree_slot && (
            <button
              onClick={() => setActiveTab('commits')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'commits'
                  ? 'border-green-500 text-green-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300'
              }`}
            >
              <GitCommit size={16} />
              Commits
              {commits.length > 0 && (
                <span className="text-xs bg-gray-700 px-1.5 py-0.5 rounded">
                  {commits.length}
                </span>
              )}
            </button>
          )}

          {/* Spacer to push settings to right */}
          <div className="flex-1" />

          {/* Settings gear */}
          <div className="relative">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-1 px-3 py-2 text-sm font-medium transition-colors ${
                showSettings
                  ? 'text-blue-400'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
              title="Ticket actions"
            >
              <Settings size={16} />
            </button>

            {/* Settings dropdown */}
            {showSettings && (
              <>
                {/* Backdrop to close dropdown */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowSettings(false)}
                />
                <div className="absolute right-0 top-full mt-1 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 py-1">
                  {ticket.state === 'backlog' && (
                    <button
                      onClick={() => {
                        send({ type: 'start_ticket', ticketId: ticket.id });
                        setShowSettings(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-700 text-green-400"
                    >
                      <Play size={14} />
                      Start Agent
                    </button>
                  )}
                  {ticket.state === 'in_progress' && (
                    <>
                      <button
                        onClick={() => {
                          send({ type: 'stop_ticket', ticketId: ticket.id });
                          setShowSettings(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-700 text-yellow-400"
                      >
                        <StopCircle size={14} />
                        Stop Agent
                      </button>
                      <button
                        onClick={() => {
                          send({ type: 'retry_ticket', ticketId: ticket.id });
                          setShowSettings(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-700 text-orange-400"
                      >
                        <RotateCcw size={14} />
                        Restart Agent
                      </button>
                    </>
                  )}
                  {(ticket.state === 'in_review' || ticket.state === 'done') && (
                    <button
                      onClick={() => {
                        send({ type: 'move_ticket', ticketId: ticket.id, toState: 'backlog' });
                        setShowSettings(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-700 text-blue-400"
                    >
                      <RotateCcw size={14} />
                      Move to Backlog
                    </button>
                  )}
                  <div className="border-t border-gray-700 my-1" />
                  <button
                    onClick={() => {
                      send({ type: 'archive_ticket', ticketId: ticket.id });
                      setShowSettings(false);
                      onClose();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-700 text-red-400"
                  >
                    <Archive size={14} />
                    Archive Ticket
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Todos Tab Content */}
        {activeTab === 'todos' && (
          <div className="flex-1 overflow-y-auto p-4">
            {todos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                {ticket.state === 'in_progress' ? (
                  <>
                    <Spinner size="lg" className="text-blue-400" />
                    <span className="text-gray-400">Waiting for agent to create tasks...</span>
                  </>
                ) : (
                  <span className="text-gray-500">No tasks recorded</span>
                )}
              </div>
            ) : (
              <TodosView todos={todos} />
            )}
          </div>
        )}

        {/* Logs Tab Content */}
        {activeTab === 'logs' && (
          <>
            {/* Progress bar */}
            {ticket.state === 'in_progress' && (
              <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-700">
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-gray-300">{progress.phase}</span>
                  <span className="text-gray-500">{progress.percent}%</span>
                </div>
                <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-500 ease-out"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Toolbar */}
            <div className="px-4 py-2 bg-gray-800 text-sm flex items-center gap-4 border-b border-gray-700">
          <button
            onClick={() => setCompactMode(!compactMode)}
            className={`flex items-center gap-1 px-2 py-1 rounded ${
              compactMode ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
            }`}
          >
            {compactMode ? <EyeOff size={14} /> : <Eye size={14} />}
            {compactMode ? 'Compact' : 'Verbose'}
          </button>

          <div className="relative">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
            >
              <Filter size={14} />
              Filters
              <ChevronDown size={14} className={showFilters ? 'rotate-180' : ''} />
            </button>

            {showFilters && (
              <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg p-2 z-10">
                {LOG_TYPE_FILTERS.map(type => (
                  <label
                    key={type.key}
                    className="flex items-center gap-2 px-2 py-1 hover:bg-gray-700 rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!hiddenTypes.has(type.key)}
                      onChange={() => toggleType(type.key)}
                      className="rounded"
                    />
                    <span className={type.color}>{type.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <span className="text-gray-500 ml-auto">
            {filteredEvents.length} / {parsedEvents.length} entries
          </span>
        </div>

        {/* Log content */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 font-mono text-sm"
        >
          {filteredEvents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              {ticket.state === 'in_progress' && logs.length === 0 ? (
                <>
                  <Spinner size="lg" className="text-blue-400" />
                  <span className="text-gray-400">Waiting for agent output...</span>
                </>
              ) : ticket.state === 'in_progress' ? (
                <span className="text-gray-500">No logs match current filters</span>
              ) : (
                <span className="text-gray-500">No logs available</span>
              )}
            </div>
          )}

          {filteredEvents.map((event) => {
            const isExpanded = expandedRows.has(event.originalIndex);
            const typeColor = TYPE_COLORS[event.type] || 'text-gray-400';

            return (
              <div key={event.originalIndex} className="mb-2">
                {/* Main line */}
                <div
                  className={`flex items-start gap-2 ${event.expandable ? 'cursor-pointer hover:bg-gray-800/50 rounded px-2 -mx-2 py-1' : 'py-1'}`}
                  onClick={() => event.expandable && toggleExpanded(event.originalIndex)}
                >
                  {/* Timestamp */}
                  <span className="text-gray-400 text-xs w-16 shrink-0 font-mono">
                    {formatTime(event.timestamp)}
                  </span>

                  {event.expandable && (
                    <ChevronRight
                      size={14}
                      className={`mt-1 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    />
                  )}
                  {!event.expandable && <span className="w-3.5" />}

                  <span className={`${typeColor} shrink-0`}>{event.icon}</span>
                  <span className={typeColor}>{event.title}</span>
                  {event.subtitle && (
                    <span className="text-gray-500 ml-2">{event.subtitle}</span>
                  )}
                </div>

                {/* Diff preview (for file changes) */}
                {event.diff && !isExpanded && (
                  <div className="ml-8 mt-1 text-xs">
                    {event.diff.lines.slice(0, 5).map((line, j) => (
                      <div
                        key={j}
                        className={
                          line.startsWith('+') ? 'text-green-400 bg-green-900/20' :
                          line.startsWith('-') ? 'text-red-400 bg-red-900/20' :
                          'text-gray-500'
                        }
                      >
                        {line}
                      </div>
                    ))}
                    {event.diff.lines.length > 5 && (
                      <div className="text-gray-500 italic">... {event.diff.lines.length - 5} more lines</div>
                    )}
                  </div>
                )}

                {/* Expanded content */}
                {isExpanded && event.content && (
                  <div className="ml-8 mt-2 p-3 bg-gray-800 rounded text-xs text-gray-400 whitespace-pre-wrap max-h-64 overflow-y-auto">
                    {event.content}
                  </div>
                )}

                {/* Full diff when expanded */}
                {isExpanded && event.diff && (
                  <div className="ml-8 mt-2 p-3 bg-gray-800 rounded text-xs max-h-64 overflow-y-auto">
                    {event.diff.lines.map((line, j) => (
                      <div
                        key={j}
                        className={
                          line.startsWith('+') ? 'text-green-400' :
                          line.startsWith('-') ? 'text-red-400' :
                          'text-gray-500'
                        }
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

            {/* Auto-scroll indicator - scroll to top for newest (reversed order) */}
            {!autoScroll && (
              <button
                onClick={() => {
                  setAutoScroll(true);
                  if (scrollRef.current) {
                    scrollRef.current.scrollTop = 0;
                  }
                }}
                className="absolute bottom-20 right-8 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-full text-sm shadow-lg"
              >
                Scroll to newest
              </button>
            )}
          </>
        )}

        {/* Chat Tab Content */}
        {activeTab === 'chat' && (
          <ChatView ticketId={ticketId} />
        )}

        {/* Issue Tab Content */}
        {activeTab === 'issue' && ticket && (
          <div className="flex-1 overflow-y-auto">
            <div className="p-4 border-b border-gray-700">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-gray-400 text-sm">#{ticket.github_issue_number}</span>
                    {ticket.labels && ticket.labels.map((label: string) => (
                      <span
                        key={label}
                        className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                  <h3 className="font-medium text-lg">{ticket.title}</h3>
                </div>
                <a
                  href={ticket.github_issue_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm shrink-0"
                >
                  View on GitHub
                  <ExternalLink size={14} />
                </a>
              </div>
            </div>

            {/* Issue Body */}
            <div className="p-4">
              <h4 className="text-sm font-semibold text-gray-400 mb-3">Description</h4>
              {ticket.body ? (
                <div className="text-sm text-gray-300 whitespace-pre-wrap bg-gray-800 rounded p-4">
                  {ticket.body}
                </div>
              ) : (
                <div className="text-gray-500 text-sm italic">No description provided</div>
              )}
            </div>

            {/* Ticket Metadata */}
            <div className="p-4 border-t border-gray-700">
              <h4 className="text-sm font-semibold text-gray-400 mb-3">Status</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">State:</span>
                  <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                    ticket.state === 'done' ? 'bg-green-900 text-green-300' :
                    ticket.state === 'in_progress' ? 'bg-blue-900 text-blue-300' :
                    ticket.state === 'in_review' ? 'bg-yellow-900 text-yellow-300' :
                    'bg-gray-700 text-gray-300'
                  }`}>
                    {ticket.state}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Attempts:</span>
                  <span className="ml-2 text-gray-300">{ticket.attempt_count || 1}</span>
                </div>
                {ticket.current_score !== null && ticket.current_score !== undefined && (
                  <div>
                    <span className="text-gray-500">Score:</span>
                    <span className={`ml-2 font-medium ${
                      ticket.current_score >= 90 ? 'text-green-400' :
                      ticket.current_score >= 70 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {ticket.current_score}/100
                    </span>
                  </div>
                )}
                {ticket.pr_number && (
                  <div>
                    <span className="text-gray-500">PR:</span>
                    <span className="ml-2 text-gray-300">#{ticket.pr_number}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Review Tab Content */}
        {activeTab === 'review' && (
          <div className="flex-1 overflow-y-auto p-4">
            {reviewLoading ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Spinner size="lg" className="text-purple-400" />
                <span className="text-gray-400">Loading review results...</span>
              </div>
            ) : issueReview ? (
              <div className="space-y-6">
                {/* Verdict Banner */}
                <div className={`p-4 rounded-lg ${
                  issueReview.verdict === 'ready' ? 'bg-green-900/30 border border-green-700' :
                  issueReview.verdict === 'minor_gaps' ? 'bg-yellow-900/30 border border-yellow-700' :
                  issueReview.verdict === 'needs_revision' ? 'bg-orange-900/30 border border-orange-700' :
                  'bg-red-900/30 border border-red-700'
                }`}>
                  <div className="flex items-center gap-3">
                    {issueReview.verdict === 'ready' ? (
                      <CheckCircle2 className="text-green-400" size={24} />
                    ) : issueReview.verdict === 'minor_gaps' ? (
                      <Clock className="text-yellow-400" size={24} />
                    ) : issueReview.verdict === 'needs_revision' ? (
                      <XCircle className="text-orange-400" size={24} />
                    ) : (
                      <XCircle className="text-red-400" size={24} />
                    )}
                    <div>
                      <h3 className={`font-semibold ${
                        issueReview.verdict === 'ready' ? 'text-green-300' :
                        issueReview.verdict === 'minor_gaps' ? 'text-yellow-300' :
                        issueReview.verdict === 'needs_revision' ? 'text-orange-300' :
                        'text-red-300'
                      }`}>
                        {issueReview.verdict === 'ready' ? 'Ready for Implementation' :
                         issueReview.verdict === 'minor_gaps' ? 'Minor Gaps Fixed' :
                         issueReview.verdict === 'needs_revision' ? 'Needs Revision' :
                         'Issue Closed'}
                      </h3>
                      <p className="text-sm text-gray-400 mt-1">
                        Reviewed {new Date(issueReview.reviewed_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Gaps Found */}
                {issueReview.gaps.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-3">Gaps Identified</h4>
                    <ul className="space-y-2">
                      {issueReview.gaps.map((gap, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-yellow-400 mt-0.5">•</span>
                          <span className="text-gray-300">{gap}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Changes Made */}
                {issueReview.changes_made && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-3">Changes Made</h4>
                    <div className="bg-gray-800 rounded p-4 text-sm text-gray-300 whitespace-pre-wrap">
                      {issueReview.changes_made}
                    </div>
                  </div>
                )}

                {/* Recommendations */}
                {issueReview.recommendations && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-3">Recommendations</h4>
                    <div className="bg-gray-800 rounded p-4 text-sm text-gray-300 whitespace-pre-wrap">
                      {issueReview.recommendations}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <ClipboardCheck className="text-gray-600" size={48} />
                <span className="text-gray-500">No review results yet</span>
                <p className="text-sm text-gray-600 text-center max-w-md">
                  Select this issue and click "Start Batch Review" in the Needs Review column to analyze it.
                </p>
              </div>
            )}
          </div>
        )}

        {/* PR Tab Content */}
        {activeTab === 'pr' && hasPR && (
          <div className="flex-1 overflow-y-auto">
            {prLoading ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Spinner size="lg" className="text-blue-400" />
                <span className="text-gray-400">Loading PR details...</span>
              </div>
            ) : prError ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-red-400">{prError}</span>
              </div>
            ) : prDetails ? (
              <div>
                {/* PR Info */}
                <div className="p-4 border-b border-gray-700 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-medium text-lg">{prDetails.title}</h3>
                      <div className="flex items-center gap-4 mt-2 text-sm text-gray-400">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          prDetails.state === 'open' ? 'bg-green-900 text-green-300' :
                          prDetails.state === 'merged' ? 'bg-purple-900 text-purple-300' :
                          'bg-gray-700 text-gray-300'
                        }`}>
                          {prDetails.state}
                        </span>
                        <span>Updated {new Date(prDetails.updated_at).toLocaleString()}</span>
                      </div>
                    </div>
                    <a
                      href={prDetails.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm"
                    >
                      View on GitHub
                      <ExternalLink size={14} />
                    </a>
                  </div>

                  {/* Status row */}
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2">
                      {prDetails.ciStatus === 'success' ? (
                        <CheckCircle2 className="text-green-400" size={16} />
                      ) : prDetails.ciStatus === 'failure' ? (
                        <XCircle className="text-red-400" size={16} />
                      ) : prDetails.ciStatus === 'pending' ? (
                        <Clock className="text-yellow-400 animate-pulse" size={16} />
                      ) : (
                        <Clock className="text-gray-400" size={16} />
                      )}
                      <span className="text-sm">
                        CI: {prDetails.ciStatus === 'success' ? 'Passed' :
                             prDetails.ciStatus === 'failure' ? 'Failed' :
                             prDetails.ciStatus === 'pending' ? 'Running' : 'Unknown'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-bold ${
                        prDetails.reviewScore === null ? 'text-gray-400' :
                        prDetails.reviewScore >= 90 ? 'text-green-400' :
                        prDetails.reviewScore >= 70 ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {prDetails.reviewScore !== null ? `${prDetails.reviewScore}/100` : '—'}
                      </span>
                      <span className="text-sm text-gray-400">Review Score</span>
                    </div>

                    <span className="text-xs text-gray-500 ml-auto">
                      Auto-refreshes every 30s
                    </span>
                  </div>
                </div>

                {/* PR Body */}
                {prDetails.body && (
                  <div className="p-4 border-b border-gray-700">
                    <h4 className="text-sm font-semibold text-gray-400 mb-2">Description</h4>
                    <div className="text-sm text-gray-300 whitespace-pre-wrap">
                      {prDetails.body}
                    </div>
                  </div>
                )}

                {/* Comments */}
                <div className="p-4">
                  <h4 className="text-sm font-semibold text-gray-400 mb-3 flex items-center gap-2">
                    <MessageSquare size={14} />
                    Comments ({prDetails.reviewComments.length})
                  </h4>

                  {prDetails.reviewComments.length === 0 ? (
                    <div className="text-gray-500 text-sm text-center py-4">No comments yet</div>
                  ) : (
                    <div className="space-y-3">
                      {prDetails.reviewComments.map(comment => (
                        <div key={comment.id} className="bg-gray-800 rounded p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium text-sm">{comment.author}</span>
                            <span className="text-xs text-gray-500">
                              {new Date(comment.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-sm text-gray-300 whitespace-pre-wrap">
                            {comment.body}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <span className="text-gray-500">No PR details available</span>
              </div>
            )}
          </div>
        )}

        {/* Commits Tab Content */}
        {activeTab === 'commits' && (
          <div className="flex-1 overflow-y-auto">
            {commitsLoading ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Spinner size="lg" className="text-green-400" />
                <span className="text-gray-400">Loading commits...</span>
              </div>
            ) : commits.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <GitCommit className="text-gray-600" size={48} />
                <span className="text-gray-500">No commits found</span>
                <p className="text-sm text-gray-600 text-center max-w-md">
                  Commits will appear here once the agent starts making changes.
                </p>
              </div>
            ) : (
              <div>
                {/* Branch info */}
                {commitsBranch && (
                  <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-700 flex items-center gap-2">
                    <span className="text-sm text-gray-400">Branch:</span>
                    <code className="text-sm text-green-400 bg-gray-800 px-2 py-0.5 rounded">
                      {commitsBranch}
                    </code>
                  </div>
                )}

                {/* Commits list */}
                <div className="divide-y divide-gray-700">
                  {commits.map((commit) => (
                    <div key={commit.hash} className="p-4 hover:bg-gray-800/30">
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 mt-0.5">
                          <GitCommit className="text-green-400" size={16} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <code className="text-xs text-yellow-400 bg-yellow-900/30 px-1.5 py-0.5 rounded font-mono">
                              {commit.hash}
                            </code>
                            <span className="text-xs text-gray-500">{commit.date}</span>
                          </div>
                          <p className="text-sm text-gray-200 mb-2">{commit.message}</p>
                          <div className="text-xs text-gray-500 mb-2">by {commit.author}</div>

                          {/* Files changed */}
                          {commit.files.length > 0 && (
                            <details className="mt-2">
                              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-300">
                                {commit.files.length} file{commit.files.length !== 1 ? 's' : ''} changed
                              </summary>
                              <ul className="mt-2 space-y-1 text-xs">
                                {commit.files.map((file, i) => (
                                  <li key={i} className="flex items-center gap-2">
                                    {file.status === 'added' && (
                                      <FilePlus size={12} className="text-green-400" />
                                    )}
                                    {file.status === 'modified' && (
                                      <FileEdit size={12} className="text-yellow-400" />
                                    )}
                                    {file.status === 'deleted' && (
                                      <FileX size={12} className="text-red-400" />
                                    )}
                                    {file.status === 'renamed' && (
                                      <FileMinus2 size={12} className="text-blue-400" />
                                    )}
                                    {!['added', 'modified', 'deleted', 'renamed'].includes(file.status) && (
                                      <FileText size={12} className="text-gray-400" />
                                    )}
                                    <span className={`font-mono ${
                                      file.status === 'added' ? 'text-green-300' :
                                      file.status === 'deleted' ? 'text-red-300' :
                                      file.status === 'renamed' ? 'text-blue-300' :
                                      'text-gray-300'
                                    }`}>
                                      {file.path}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
