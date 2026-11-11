import React, { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, History, Zap } from 'lucide-react';
import type { Message } from '../../shared/types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';

interface MessageBubbleProps {
  message: Message;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const [traceOpen, setTraceOpen] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="msg-row">
        <div className="msg-user-wrap">
          <div className="msg-user-bubble">{message.content}</div>
        </div>
      </div>
    );
  }

  const sources = message.metadata?.sources ?? [];
  const trace = message.metadata?.trace;

  return (
    <div className="msg-row">
      <div className="msg-assistant-wrap">
        <MarkdownRenderer content={message.content} sources={sources} />

        {sources.length > 0 && (
          <div className="sources-grid">
            {sources.map((src) => (
              <a
                key={src.index}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="source-card"
                title={`${src.title}${src.publishedDate ? ` · ${src.publishedDate}` : ''}`}
              >
                <span className="source-idx">[{src.index}]</span>
                <span className="source-title">{src.domain}</span>
                <ExternalLink size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
              </a>
            ))}
          </div>
        )}

        {trace && (
          <div>
            <button
              type="button"
              className="trace-toggle"
              onClick={() => setTraceOpen((v) => !v)}
            >
              {traceOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Zap size={12} />
              <span>
                {(trace.totalDurationMs / 1000).toFixed(2)}s
                {trace.searchRounds.length > 0
                  ? ` · ${trace.searchRounds.reduce((n, r) => n + r.queries.length, 0)} searches · ${sources.length} sources`
                  : ' · direct answer'}
                {trace.memoryStatus === 'hit' ? ` · ${trace.memoryHits.length} memory hit(s)` : ''}
              </span>
            </button>

            {traceOpen && (
              <div className="trace-panel">
                <div>
                  <strong>Model:</strong> {trace.provider}/{trace.model} · <strong>Search:</strong> {trace.searchProvider}
                  {trace.firstTokenMs !== undefined ? ` · TTFT: ${trace.firstTokenMs}ms` : ''}
                </div>
                {trace.temporalResolution.hasTemporalReference && (
                  <div>
                    <History size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    <strong>Temporal resolution:</strong>{' '}
                    {trace.temporalResolution.expressions.join(', ')} → [
                    {trace.temporalResolution.candidateDates.join(', ')}]
                    {trace.memoryStatus === 'no_records_for_date' ? ' (no records on date)' : ''}
                  </div>
                )}
                {trace.memoryHits.map((hit, i) => (
                  <div key={i}>
                    <strong>Memory [{hit.localDate}]:</strong> {hit.topic} ({hit.matchReason}, {hit.entitiesCount} entities, {hit.claimsCount} claims)
                  </div>
                ))}
                {trace.searchRounds.map((round) => (
                  <div key={round.round}>
                    <strong>Round {round.round} ({round.depth}, {round.durationMs}ms, {round.pagesFetched} pages read, {round.cacheHits} cached):</strong>{' '}
                    {round.queries.map((q) => `"${q.query}"`).join(' | ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
