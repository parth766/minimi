import React from 'react';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import type { Conversation, SystemStatus } from '../../shared/types.js';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  status: SystemStatus | null;
  open: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeId,
  status,
  open,
  onNewChat,
  onSelect,
  onDelete,
}) => {
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand-row">
        <div className="brand-title">
          <span className="brand-dot" />
          <span>Chronos</span>
        </div>
      </div>

      <button type="button" className="new-chat-btn" onClick={onNewChat}>
        <Plus size={15} />
        <span>New chat</span>
      </button>

      <div className="sidebar-section-label">Threads (Shared Memory)</div>

      <div className="conv-list">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`conv-item ${conv.id === activeId ? 'active' : ''}`}
          >
            <button
              type="button"
              className="conv-item-title"
              onClick={() => onSelect(conv.id)}
              title={conv.title}
            >
              <MessageSquare size={12} style={{ verticalAlign: 'middle', marginRight: 6, opacity: 0.7 }} />
              {conv.title}
            </button>
            <button
              type="button"
              className="conv-delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conv.id);
              }}
              aria-label="Delete thread"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {status && (
        <div className="sidebar-footer">
          <div className="status-pill">
            <span className={`status-indicator ${status.ready ? 'ok' : 'warn'}`} />
            <span>
              {status.ready ? `${status.llmProvider} · ${status.llmModel}` : 'LLM key missing'}
            </span>
          </div>
          <div style={{ paddingLeft: 13 }}>
            Search: {status.searchProvider} · {status.episodeCount} episodes
          </div>
        </div>
      )}
    </aside>
  );
};
