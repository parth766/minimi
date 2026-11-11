import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentTrace,
  ChatSSEEvent,
  Conversation,
  Freshness,
  Message,
  SearchDepth,
  SourceRef,
  SystemStatus,
  TemporalResolution,
} from '../../shared/types.js';

export interface LiveActivity {
  phase: string;
  label: string;
  queries: Array<{ query: string; purpose?: string; freshness?: Freshness }>;
  depth?: SearchDepth;
  memoryStatus?: AgentTrace['memoryStatus'];
  memoryHits?: AgentTrace['memoryHits'];
  temporal?: TemporalResolution;
  sources: SourceRef[];
}

export function useChat() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [liveActivity, setLiveActivity] = useState<LiveActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        setStatus((await res.json()) as SystemStatus);
      }
    } catch {
      // ignore transient network check
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = (await res.json()) as { conversations: Conversation[] };
        setConversations(data.conversations);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshConversations();
  }, [refreshStatus, refreshConversations]);

  const selectConversation = useCallback(async (id: string) => {
    setError(null);
    setActiveConversationId(id);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`);
      if (res.ok) {
        const data = (await res.json()) as { messages: Message[] };
        setMessages(data.messages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, []);

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setStreamingContent('');
    setLiveActivity(null);
    setError(null);
    setActiveConversationId(null);
    setMessages([]);
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationId === id) {
        startNewChat();
      }
    },
    [activeConversationId, startNewChat],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      setError(null);
      setIsStreaming(true);
      setStreamingContent('');
      setLiveActivity({
        phase: 'hydrating_memory',
        label: 'Checking episodic memory...',
        queries: [],
        sources: [],
      });

      const tempUserMsg: Message = {
        id: `temp_${Date.now()}`,
        conversationId: activeConversationId ?? 'pending',
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
        localDate: new Date().toISOString().slice(0, 10),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      setMessages((prev) => [...prev, tempUserMsg]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(activeConversationId ? { conversationId: activeConversationId } : {}),
            message: trimmed,
            timezone: timeZone,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `Request failed (${res.status})`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let buffer = '';
        let resolvedConvId = activeConversationId;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const block of lines) {
            const dataLine = block
              .split('\n')
              .find((l) => l.startsWith('data: '));
            if (!dataLine) continue;

            const event = JSON.parse(dataLine.slice(6)) as ChatSSEEvent;
            if (event.type === 'meta') {
              resolvedConvId = event.conversationId;
              setActiveConversationId(event.conversationId);
            } else if (event.type === 'status') {
              setLiveActivity((prev) =>
                prev ? { ...prev, phase: event.phase, label: event.label } : prev,
              );
            } else if (event.type === 'memory') {
              setLiveActivity((prev) =>
                prev
                  ? {
                      ...prev,
                      memoryStatus: event.status,
                      memoryHits: event.hits,
                      temporal: event.temporal,
                    }
                  : prev,
              );
            } else if (event.type === 'tool_start') {
              setLiveActivity((prev) =>
                prev
                  ? {
                      ...prev,
                      queries: [...prev.queries, ...event.queries],
                      depth: event.depth,
                    }
                  : prev,
              );
            } else if (event.type === 'sources') {
              setLiveActivity((prev) => (prev ? { ...prev, sources: event.sources } : prev));
            } else if (event.type === 'delta') {
              setStreamingContent((prev) => prev + event.text);
            } else if (event.type === 'done') {
              setMessages((prev) => [...prev, event.message]);
              setStreamingContent('');
              setLiveActivity(null);
            } else if (event.type === 'error') {
              setError(event.message);
            }
          }
        }

        if (resolvedConvId) {
          await refreshConversations();
          await refreshStatus();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to stream response');
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // Refresh title shortly after turn 1 async title generation completes
        setTimeout(() => {
          void refreshConversations();
        }, 1200);
      }
    },
    [activeConversationId, isStreaming, refreshConversations, refreshStatus],
  );

  return {
    status,
    conversations,
    activeConversationId,
    messages,
    isStreaming,
    streamingContent,
    liveActivity,
    error,
    selectConversation,
    startNewChat,
    deleteConversation,
    sendMessage,
    stopStreaming,
  };
}
