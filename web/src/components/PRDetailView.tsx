import { useEffect, useState } from 'react';
import { X, GitPullRequest, ExternalLink, CheckCircle2, XCircle, Clock, MessageSquare } from 'lucide-react';
import { useTicketsStore } from '../stores/tickets';
import { Spinner } from './Spinner';
import type { PRDetails, Ticket } from '../lib/types';

interface PRDetailViewProps {
  ticket: Ticket;
  onClose: () => void;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderMarkdownSimple(text: string): string {
  // Very simple markdown rendering - just handle code blocks and bold
  return text
    .replace(/```[\s\S]*?```/g, (match) => {
      const code = match.slice(3, -3).replace(/^\w+\n/, '');
      return `<pre class="bg-gray-900 p-2 rounded text-xs overflow-x-auto my-2">${code}</pre>`;
    })
    .replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-xs">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

export function PRDetailView({ ticket, onClose }: PRDetailViewProps) {
  const [prDetails, setPRDetails] = useState<PRDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const connected = useTicketsStore(state => state.connected);

  useEffect(() => {
    if (!connected) return;

    let cancelled = false;

    // Listen for response
    const handleMessage = (event: MessageEvent) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pr_details' && data.ticketId === ticket.id) {
          setPRDetails(data.prDetails);
          setLoading(false);
        }
        if (data.type === 'error') {
          setError(data.message);
          setLoading(false);
        }
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    };

    const ws = (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.addEventListener('message', handleMessage);
      // Send directly on this websocket
      ws.send(JSON.stringify({ type: 'get_pr_details', ticketId: ticket.id }));
    } else {
      setError('Not connected to server');
      setLoading(false);
    }

    return () => {
      cancelled = true;
      if (ws) {
        ws.removeEventListener('message', handleMessage);
      }
    };
  }, [ticket.id, connected]);

  const getCIStatusIcon = () => {
    if (!prDetails) return null;
    switch (prDetails.ciStatus) {
      case 'success':
        return <CheckCircle2 className="text-green-400" size={16} />;
      case 'failure':
        return <XCircle className="text-red-400" size={16} />;
      case 'pending':
        return <Clock className="text-yellow-400 animate-pulse" size={16} />;
      default:
        return <Clock className="text-gray-400" size={16} />;
    }
  };

  const getScoreColor = (score: number | null) => {
    if (score === null) return 'text-gray-400';
    if (score >= 90) return 'text-green-400';
    if (score >= 70) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg w-full max-w-3xl max-h-[80vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <GitPullRequest className="text-purple-400" size={20} />
            <div>
              <h2 className="font-semibold">Pull Request</h2>
              <p className="text-sm text-gray-400">
                #{ticket.github_issue_number} - {ticket.title}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded">
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
            <Spinner size="lg" className="text-blue-400" />
            <div className="text-gray-400">Loading PR details...</div>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-red-400">{error}</div>
          </div>
        ) : !prDetails ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-gray-400">Could not load PR details</div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
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
                    <span>Created {formatDate(prDetails.created_at)}</span>
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
                  {getCIStatusIcon()}
                  <span className="text-sm">
                    CI: {prDetails.ciStatus === 'success' ? 'Passed' :
                         prDetails.ciStatus === 'failure' ? 'Failed' :
                         prDetails.ciStatus === 'pending' ? 'Running' : 'Unknown'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span className={`text-lg font-bold ${getScoreColor(prDetails.reviewScore)}`}>
                    {prDetails.reviewScore !== null ? `${prDetails.reviewScore}/100` : '—'}
                  </span>
                  <span className="text-sm text-gray-400">Review Score</span>
                </div>
              </div>
            </div>

            {/* PR Body */}
            {prDetails.body && (
              <div className="p-4 border-b border-gray-700">
                <h4 className="text-sm font-semibold text-gray-400 mb-2">Description</h4>
                <div
                  className="text-sm text-gray-300 prose prose-invert prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownSimple(prDetails.body) }}
                />
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
                        <span className="text-xs text-gray-500">{formatDate(comment.created_at)}</span>
                      </div>
                      <div
                        className="text-sm text-gray-300"
                        dangerouslySetInnerHTML={{ __html: renderMarkdownSimple(comment.body) }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
