import React from 'react';
import { Globe, History, Loader2 } from 'lucide-react';
import type { LiveActivity } from '../hooks/useChat.js';

interface SearchActivityProps {
  activity: LiveActivity;
}

export const SearchActivity: React.FC<SearchActivityProps> = ({ activity }) => {
  return (
    <div className="activity-box">
      <div className="activity-header">
        <Loader2 size={14} className="spin" />
        <span>{activity.label}</span>
      </div>

      {activity.memoryHits && activity.memoryHits.length > 0 && (
        <div className="query-chips">
          {activity.memoryHits.map((hit, idx) => (
            <span key={idx} className="query-chip">
              <History size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {hit.localDate}: {hit.topic}
            </span>
          ))}
        </div>
      )}

      {activity.queries.length > 0 && (
        <div className="query-chips">
          {activity.queries.map((q, idx) => (
            <span key={idx} className="query-chip" title={q.query}>
              <Globe size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {q.purpose || q.query}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
