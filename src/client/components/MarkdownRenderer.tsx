import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SourceRef } from '../../shared/types.js';

interface MarkdownRendererProps {
  content: string;
  sources?: SourceRef[];
}

function linkifyCitations(text: string, sourceMap: Map<number, SourceRef>): string {
  if (sourceMap.size === 0) return text;
  // Turn standalone [1] or [1, 2] into markdown links pointing to verified URLs
  // Skip existing markdown links like [1](url)
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (full, inner: string) => {
    const nums = inner
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && sourceMap.has(n));
    if (nums.length === 0) return full;
    return nums
      .map((n) => {
        const src = sourceMap.get(n)!;
        return `[cite:${n}](${src.url})`;
      })
      .join(' ');
  });
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, sources = [] }) => {
  const sourceMap = useMemo(() => {
    const map = new Map<number, SourceRef>();
    for (const s of sources) map.set(s.index, s);
    return map;
  }, [sources]);

  const processed = useMemo(() => linkifyCitations(content, sourceMap), [content, sourceMap]);

  return (
    <div className="msg-assistant-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const label = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : '';
            if (label.startsWith('cite:')) {
              const num = label.slice(5);
              const src = sourceMap.get(Number(num));
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cite-pill"
                  title={src ? `${src.title} (${src.domain})` : href}
                >
                  {num}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
};
