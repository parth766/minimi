import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, Menu, Square } from 'lucide-react';
import { MarkdownRenderer } from './components/MarkdownRenderer.js';
import { MessageBubble } from './components/MessageBubble.js';
import { SearchActivity } from './components/SearchActivity.js';
import { Sidebar } from './components/Sidebar.js';
import { useChat } from './hooks/useChat.js';

const STARTER_PROMPTS = [
  'Shortlist 5 CRM tools for a 20-person sales team with current pricing.',
  'Compare managed Postgres hosting options (Neon, Supabase, RDS, Render) and pricing today.',
  'What are the biggest Node.js or TypeScript releases shipped this month?',
  'Check what we discussed earlier and verify if any details changed today.',
];

export const App: React.FC = () => {
  const {
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
  } = useChat();

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, liveActivity]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isStreaming) return;
    const text = input;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  return (
    <div className="app-shell">
      <Sidebar
        conversations={conversations}
        activeId={activeConversationId}
        status={status}
        open={sidebarOpen}
        onNewChat={() => {
          startNewChat();
          setSidebarOpen(false);
        }}
        onSelect={(id) => {
          void selectConversation(id);
          setSidebarOpen(false);
        }}
        onDelete={(id) => void deleteConversation(id)}
      />

      <main className="main-pane" onClick={() => sidebarOpen && setSidebarOpen(false)}>
        <header className="top-bar">
          <div className="top-bar-left">
            <button
              type="button"
              className="mobile-menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setSidebarOpen((v) => !v);
              }}
              aria-label="Toggle sidebar"
            >
              <Menu size={18} />
            </button>
            <span>Chronos Search Agent</span>
            <span className="top-badge">1 tool: web_search</span>
          </div>
          {status && (
            <span className="top-badge">
              {status.searchProvider === 'duckduckgo' ? 'DDG fallback' : status.searchProvider}
            </span>
          )}
        </header>

        {status && !status.ready && (
          <div className="config-banner">
            <AlertTriangle size={16} />
            <span>{status.issues[0]}</span>
          </div>
        )}

        <div className="messages-scroll">
          {messages.length === 0 && !isStreaming ? (
            <div className="empty-state">
              <h1>Fast, grounded web search with temporal memory</h1>
              <p>
                Ask anything about live pricing, changelogs, or current events — or follow up across
                threads about what we discussed days or weeks ago.
              </p>
              <div className="starter-grid">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="starter-card"
                    onClick={() => void sendMessage(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-container">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {isStreaming && (
                <div className="msg-row">
                  <div className="msg-assistant-wrap">
                    {liveActivity && <SearchActivity activity={liveActivity} />}
                    {streamingContent && (
                      <MarkdownRenderer
                        content={streamingContent}
                        sources={liveActivity?.sources}
                      />
                    )}
                  </div>
                </div>
              )}

              {error && (
                <div className="config-banner" style={{ margin: 0, borderColor: 'rgba(239,68,68,0.4)', color: '#fca5a5', background: 'rgba(239,68,68,0.1)' }}>
                  <AlertTriangle size={16} />
                  <span>{error}</span>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <form className="composer-wrap" onSubmit={(e) => void handleSubmit(e)}>
          <div className="composer-box">
            <textarea
              ref={textareaRef}
              rows={1}
              className="composer-textarea"
              placeholder="Ask a question or check what changed since an earlier chat..."
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
            />
            {isStreaming ? (
              <button
                type="button"
                className="composer-stop-btn"
                onClick={stopStreaming}
                title="Stop generating"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="composer-send-btn"
                disabled={!input.trim()}
                title="Send message"
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
};
