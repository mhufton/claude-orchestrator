import { useState, useEffect, useRef } from 'react';
import { Send, Clock, User, Bot, Zap, Loader2, AlertTriangle } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { useWebSocket } from '../hooks/useWebSocket';
import type { ChatMessage } from '../lib/types';

interface ChatViewProps {
  ticketId: number;
}

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChatView({ ticketId }: ChatViewProps) {
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { send } = useWebSocket();

  const messages = useTicketsStore(state => state.chatMessages.get(ticketId) || []);
  const ticket = useTicketsStore(state => state.tickets.find(t => t.id === ticketId));

  // Load messages on mount
  useEffect(() => {
    send({ type: 'get_chat_messages', ticketId });
    setIsLoading(false);
  }, [ticketId, send]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!message.trim()) return;

    send({
      type: 'send_chat_message',
      ticketId,
      content: message.trim()
    });

    setMessage('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const pendingCount = messages.filter(m => m.pending).length;
  const canInterrupt = pendingCount > 0 && ticket?.state === 'in_progress';
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);

  const handleInterrupt = () => {
    if (!canInterrupt || isInterrupting) return;
    setShowInterruptConfirm(false);
    setIsInterrupting(true);
    send({ type: 'interrupt_for_message', ticketId });
    // Reset after a short delay (the agent will respawn and messages will be delivered)
    setTimeout(() => setIsInterrupting(false), 3000);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with pending indicator */}
      {pendingCount > 0 && (
        <div className="px-3 py-2 bg-yellow-900/30 border-b border-yellow-700/50 text-sm">
          <div className="flex items-center justify-between text-yellow-300">
            <div className="flex items-center gap-2">
              <Clock size={14} />
              <span>{pendingCount} message{pendingCount > 1 ? 's' : ''} queued</span>
            </div>
            {canInterrupt && !showInterruptConfirm && (
              <button
                onClick={() => setShowInterruptConfirm(true)}
                disabled={isInterrupting}
                className={`
                  flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors
                  ${isInterrupting
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}
                `}
                title="Restart agent to deliver message immediately"
              >
                {isInterrupting ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Restarting...
                  </>
                ) : (
                  <>
                    <Zap size={12} />
                    Deliver Now
                  </>
                )}
              </button>
            )}
          </div>

          {/* Interrupt confirmation */}
          {showInterruptConfirm && (
            <div className="mt-2 p-2 bg-orange-900/50 border border-orange-700 rounded text-orange-200">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div className="text-xs">
                  <strong>This will stop the running agent</strong> and restart it with your message.
                  Current work may be lost. Message will be delivered on next natural retry anyway.
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowInterruptConfirm(false)}
                  className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  onClick={handleInterrupt}
                  className="px-2 py-1 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium"
                >
                  Stop & Restart
                </button>
              </div>
            </div>
          )}

          {!showInterruptConfirm && (
            <p className="text-xs text-yellow-400/70 mt-1">
              Will be delivered when agent finishes current task
            </p>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-gray-500">
            Loading messages...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500 text-center px-4">
            <Bot size={32} className="mb-2 opacity-50" />
            <p className="font-medium">Chat with the agent</p>
            <p className="text-xs mt-1 text-gray-600">
              Send a message and the agent will respond when it finishes its current task.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-gray-700">
        <div className="flex gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message to the agent..."
            className="flex-1 bg-gray-700 text-white rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[40px] max-h-[120px]"
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!message.trim()}
            className={`
              px-3 py-2 rounded-lg transition-colors
              ${message.trim()
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'}
            `}
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Agent will respond when it finishes its current task
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className={`
        w-8 h-8 rounded-full flex items-center justify-center shrink-0
        ${isUser ? 'bg-blue-600' : 'bg-purple-600'}
      `}>
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* Message */}
      <div className={`flex flex-col max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`
          rounded-lg px-3 py-2 text-sm
          ${isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-700 text-gray-100'}
          ${message.pending ? 'opacity-70' : ''}
        `}>
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
          <span>{formatTime(message.created_at)}</span>
          {isUser && message.pending && (
            <span className="flex items-center gap-1 text-yellow-500">
              <Clock size={10} />
              Queued
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
