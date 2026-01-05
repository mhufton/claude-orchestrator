import { useEffect, useCallback } from 'react';
import { useTicketsStore, handleServerMessage } from '../stores/tickets';
import type { ClientMessage, ServerMessage } from '../lib/types';

const WS_URL = `ws://${window.location.hostname}:3456/ws`;
const RECONNECT_DELAY = 3000;

// Singleton WebSocket manager - survives React Strict Mode
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimeout: number | null = null;
  private connecting = false;
  private listeners = new Set<() => void>();

  connect(): void {
    // Prevent multiple simultaneous connection attempts
    if (this.connecting || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.connecting = true;
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      this.connecting = false;
      useTicketsStore.getState().setConnected(true);
      // Expose globally for components that need direct access
      (window as unknown as { __orchestratorWs?: WebSocket }).__orchestratorWs = ws;
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(message);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.connecting = false;
      this.ws = null;
      useTicketsStore.getState().setConnected(false);

      // Only reconnect if we still have listeners
      if (this.listeners.size > 0) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.connecting = false;
    };

    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.listeners.size > 0) {
        console.log('Attempting to reconnect...');
        this.connect();
      }
    }, RECONNECT_DELAY);
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, cannot send message');
    }
  }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);

    // Connect if this is the first subscriber
    if (this.listeners.size === 1) {
      this.connect();
    }

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback);

      // Don't disconnect on unsubscribe - keep connection alive
      // This prevents issues with React Strict Mode
    };
  }

  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}

// Single global instance
const wsManager = new WebSocketManager();

export function useWebSocket() {
  const connected = useTicketsStore(state => state.connected);

  useEffect(() => {
    // Subscribe to keep connection alive while component is mounted
    const unsubscribe = wsManager.subscribe(() => {});
    return unsubscribe;
  }, []);

  const send = useCallback((message: ClientMessage) => {
    wsManager.send(message);
  }, []);

  return { send, connected };
}
