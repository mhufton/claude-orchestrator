import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, User, Sparkles, ChevronUp, ChevronDown, Loader2, RefreshCw, Square } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';

interface OrchestratorMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const STORAGE_KEY = 'orchestrator-chat-messages';
const SESSION_KEY = 'orchestrator-chat-session';
const MAX_STORED_MESSAGES = 50;

// Generate a unique session ID (must be valid UUID for claude CLI)
function generateSessionId(): string {
  return crypto.randomUUID();
}

// Load messages from localStorage
function loadMessages(): OrchestratorMessage[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.map((m: OrchestratorMessage) => ({
        ...m,
        timestamp: new Date(m.timestamp)
      }));
    }
  } catch (e) {
    console.warn('Failed to load chat messages:', e);
  }
  return [];
}

// Load session ID from localStorage
function loadSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

// Save messages to localStorage
function saveMessages(messages: OrchestratorMessage[]) {
  try {
    const toStore = messages.slice(-MAX_STORED_MESSAGES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.warn('Failed to save chat messages:', e);
  }
}

// Save session ID to localStorage
function saveSessionId(sessionId: string | null) {
  try {
    if (sessionId) {
      localStorage.setItem(SESSION_KEY, sessionId);
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // ignore
  }
}

export function OrchestratorChat() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<OrchestratorMessage[]>(loadMessages);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(loadSessionId);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { send, connected } = useWebSocket();

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Save messages to localStorage when they change
  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(messages);
    }
  }, [messages]);

  const addMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date()
    }]);
  }, []);

  // Listen for dispatcher responses
  // Re-run when `connected` changes to attach listener to new WebSocket after reconnect
  useEffect(() => {
    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (!ws) {
      console.log('[OrchestratorChat] No WebSocket available');
      return;
    }

    console.log('[OrchestratorChat] Attaching message listener to WebSocket');

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'dispatcher_response') {
          console.log('[OrchestratorChat] Received dispatcher_response');
          setIsProcessing(false);
          addMessage('assistant', data.message);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => {
      console.log('[OrchestratorChat] Removing message listener');
      ws.removeEventListener('message', handleMessage);
    };
  }, [addMessage, connected]);

  // Save sessionId when it changes
  useEffect(() => {
    saveSessionId(sessionId);
  }, [sessionId]);

  const handleSend = async () => {
    if (!message.trim() || isProcessing || !connected) return;

    const userMessage = message.trim();
    setMessage('');
    addMessage('user', userMessage);
    setIsProcessing(true);

    // Generate session ID on first message if none exists
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      currentSessionId = generateSessionId();
      setSessionId(currentSessionId);
    }

    // Send to backend dispatcher with session ID
    send({ type: 'dispatcher_chat', message: userMessage, sessionId: currentSessionId });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewSession = () => {
    if (messages.length > 0) {
      setShowNewSessionConfirm(true);
    } else {
      // No messages, just reset session
      setSessionId(null);
    }
  };

  const confirmNewSession = () => {
    setMessages([]);
    setSessionId(null);
    localStorage.removeItem(STORAGE_KEY);
    setShowNewSessionConfirm(false);
  };

  const handleStop = () => {
    send({ type: 'dispatcher_stop' });
    // Don't set isProcessing to false here - let the backend response handle it
    // The backend will return "(Request cancelled)" which will clear isProcessing
  };

  return (
    <div className={`flex flex-col border-t border-gray-800 relative ${isExpanded ? 'flex-1 min-h-0 h-full' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 hover:bg-gray-800/50 transition-colors flex-shrink-0">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 flex-1"
        >
          <Sparkles className="text-purple-400" size={16} />
          <span className="text-sm font-medium">Dispatcher</span>
          {!connected && (
            <span className="text-xs text-red-400">(disconnected)</span>
          )}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewSession}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
            title="Start new session (clears history)"
          >
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setIsExpanded(!isExpanded)} className="p-1">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>

      {/* New session confirmation dialog */}
      {showNewSessionConfirm && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50 p-2">
          <div className="bg-gray-800 rounded-lg p-4 max-w-xs border border-gray-700">
            <p className="text-sm text-gray-200 mb-3">Start a new session? This will clear the conversation history.</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowNewSessionConfirm(false)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={confirmNewSession}
                className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded"
              >
                New Session
              </button>
            </div>
          </div>
        </div>
      )}

      {isExpanded && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Messages - grows to fill available space */}
          <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-2 border-t border-gray-800/50 min-h-0">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs text-center px-2 py-4">
                <Sparkles size={24} className="mb-2 opacity-50 text-purple-400" />
                <p>I'm your AI dispatcher.</p>
                <p className="mt-1">Ask me anything about tickets,</p>
                <p>or tell me to sync, start work, add labels...</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                >
                  <div className={`
                    w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5
                    ${msg.role === 'user' ? 'bg-blue-600' : 'bg-purple-600'}
                  `}>
                    {msg.role === 'user' ? <User size={12} /> : <Sparkles size={12} />}
                  </div>
                  <div className={`
                    rounded-lg px-2 py-1.5 text-xs max-w-[85%]
                    ${msg.role === 'user' ? 'bg-blue-600' : 'bg-gray-700'}
                  `}>
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                </div>
              ))
            )}
            {isProcessing && (
              <div className="flex gap-2">
                <div className="w-5 h-5 rounded-full flex items-center justify-center bg-purple-600 mt-0.5">
                  <Sparkles size={12} />
                </div>
                <div className="rounded-lg px-2 py-1.5 text-xs bg-gray-700 flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-2 border-t border-gray-800/50 flex-shrink-0">
            <div className="flex gap-1.5">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me anything..."
                disabled={!connected || isProcessing}
                className="flex-1 bg-gray-800 text-white rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:opacity-50"
              />
              {isProcessing ? (
                <button
                  onClick={handleStop}
                  className="px-2 py-1.5 rounded transition-colors bg-red-600 hover:bg-red-500 text-white"
                  title="Stop"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!message.trim() || !connected}
                  className={`
                    px-2 py-1.5 rounded transition-colors
                    ${message.trim() && connected
                      ? 'bg-purple-600 hover:bg-purple-500 text-white'
                      : 'bg-gray-700 text-gray-500 cursor-not-allowed'}
                  `}
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
