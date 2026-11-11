import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  publishedDate?: string;
  modifiedDate?: string;
  wordCount: number;
}

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'template',
  'nav',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '.cookie-banner',
  '#cookie-banner',
  '.consent-banner',
];

function normalizeIsoDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const isoMatch = trimmed.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return undefined;
}

export function extractDatesFromDocument(doc: Document): { publishedDate?: string; modifiedDate?: string } {
  let publishedDate: string | undefined;
  let modifiedDate: string | undefined;

  const metaSelectors: Array<{ selector: string; kind: 'pub' | 'mod' }> = [
    { selector: 'meta[property="article:modified_time"]', kind: 'mod' },
    { selector: 'meta[property="og:updated_time"]', kind: 'mod' },
    { selector: 'meta[name="last-modified"]', kind: 'mod' },
    { selector: 'meta[itemprop="dateModified"]', kind: 'mod' },
    { selector: 'meta[property="article:published_time"]', kind: 'pub' },
    { selector: 'meta[name="pubdate"]', kind: 'pub' },
    { selector: 'meta[name="publishdate"]', kind: 'pub' },
    { selector: 'meta[name="date"]', kind: 'pub' },
    { selector: 'meta[itemprop="datePublished"]', kind: 'pub' },
  ];

  for (const { selector, kind } of metaSelectors) {
    const el = doc.querySelector(selector);
    const content = el?.getAttribute('content');
    const normalized = normalizeIsoDate(content);
    if (normalized) {
      if (kind === 'mod' && !modifiedDate) modifiedDate = normalized;
      if (kind === 'pub' && !publishedDate) publishedDate = normalized;
    }
  }

  // Parse JSON-LD structured data for datePublished / dateModified
  const ldScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    const raw = script.textContent;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (!modifiedDate && typeof rec.dateModified === 'string') {
            modifiedDate = normalizeIsoDate(rec.dateModified);
          }
          if (!publishedDate && typeof rec.datePublished === 'string') {
            publishedDate = normalizeIsoDate(rec.datePublished);
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  // Fallback to first <time datetime="...">
  if (!publishedDate && !modifiedDate) {
    const timeEl = doc.querySelector('main time[datetime], article time[datetime], time[datetime]');
    const dt = normalizeIsoDate(timeEl?.getAttribute('datetime') ?? timeEl?.textContent);
    if (dt) publishedDate = dt;
  }

  return { publishedDate, modifiedDate };
}

function cleanText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const matrix: string[][] = [];
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('th, td')).map((cell) =>
      cleanText(cell.textContent ?? '').replace(/\|/g, '\\|'),
    );
    if (cells.some((c) => c.length > 0)) {
      matrix.push(cells);
    }
  }
  if (matrix.length === 0) return '';

  const colCount = Math.max(...matrix.map((r) => r.length));
  if (colCount === 0) return '';

  const padded = matrix.map((r) => {
    const copy = [...r];
    while (copy.length < colCount) copy.push('');
    return copy;
  });

  const header = `| ${padded[0]!.join(' | ')} |`;
  const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const body = padded.slice(1).map((r) => `| ${r.join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === 3) {
    return (node.textContent ?? '').replace(/\s+/g, ' ');
  }
  if (node.nodeType !== 1) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === 'table') {
    const md = tableToMarkdown(el);
    return md ? `\n\n${md}\n\n` : '';
  }

  if (tag === 'pre') {
    const code = el.textContent?.trim() ?? '';
    return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : '';
  }

  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n\n---\n\n';

  const childrenMd = Array.from(el.childNodes).map(nodeToMarkdown).join('');
  const trimmed = cleanText(childrenMd);

  switch (tag) {
    case 'h1':
      return trimmed ? `\n\n# ${trimmed}\n\n` : '';
    case 'h2':
      return trimmed ? `\n\n## ${trimmed}\n\n` : '';
    case 'h3':
      return trimmed ? `\n\n### ${trimmed}\n\n` : '';
    case 'h4':
    case 'h5':
    case 'h6':
      return trimmed ? `\n\n#### ${trimmed}\n\n` : '';
    case 'p':
      return trimmed ? `\n\n${trimmed}\n\n` : '';
    case 'li':
      return trimmed ? `\n- ${trimmed}` : '';
    case 'ul':
    case 'ol':
      return childrenMd.trim() ? `\n\n${childrenMd.trim()}\n\n` : '';
    case 'blockquote':
      return trimmed ? `\n\n> ${trimmed}\n\n` : '';
    case 'strong':
    case 'b':
      return trimmed ? ` **${trimmed}** ` : '';
    case 'code':
      return trimmed ? `\`${trimmed}\`` : '';
    case 'section':
    case 'article':
    case 'div':
    case 'tr':
      return childrenMd.includes('\n') ? `\n${childrenMd}\n` : childrenMd;
    default:
      return childrenMd;
  }
}

export function htmlToCompactMarkdown(html: string, url: string, queryHint = ''): ExtractedPage {
  const { document } = parseHTML(html);
  const { publishedDate, modifiedDate } = extractDatesFromDocument(document);
  const title = cleanText(document.querySelector('title')?.textContent ?? '') || url;

  const isStructuredIntent =
    /pricing|plans|changelog|release|whats-new|features|tiers|compare/i.test(url) ||
    /pricing|cost|price|plan|tier|changelog|shipped|release|version/i.test(queryHint);

  let markdown = '';

  // Try Readability first on prose/article pages (unless clearly a pricing/changelog grid)
  if (!isStructuredIntent) {
    try {
      const cloned = parseHTML(html).document;
      const article = new Readability(cloned as unknown as Document).parse();
      if (article?.content && article.textContent && article.textContent.trim().length >= 350) {
        const parsedArticle = parseHTML(article.content).document;
        markdown = nodeToMarkdown(parsedArticle.body ?? parsedArticle.documentElement);
      }
    } catch {
      // Fallback to semantic DOM walker below
    }
  }

  if (markdown.trim().length < 250) {
    for (const sel of NOISE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        el.remove();
      }
    }
    const root = document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body ?? document.documentElement;
    markdown = nodeToMarkdown(root);
  }

  const normalized = markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  return {
    url,
    title,
    markdown: normalized,
    publishedDate,
    modifiedDate,
    wordCount,
  };
}

/**
 * Compresses full-page Markdown down to the highest-signal excerpts for a query,
 * preserving headings, pricing tables, version strings, and date markers in order.
 */
export function compressMarkdownForQuery(
  markdown: string,
  query: string,
  maxChars = 1800,
): string {
  if (markdown.length <= maxChars) return markdown;

  const queryTerms = Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    ),
  );

  // Split into sections keeping Markdown tables & headings cohesive
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 12);

  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (lower.includes(term)) score += 3;
    }
    if (/(\$|€|£)\s*\d+|\/mo|\/month|\/user|\/seat|free tier|enterprise|pricing/i.test(block)) {
      score += 4;
    }
    if (/(2025|2026|january|february|march|april|may|june|july|august|september|october|november|december|released|launched|changelog|updated)/i.test(block)) {
      score += 3;
    }
    if (block.startsWith('|') && block.includes('---')) {
      score += 4; // Pricing / spec tables are dense high-value facts
    }
    if (block.startsWith('#')) {
      score += 1.5;
    }
    // Slight preference for lead summary near top
    if (index <= 2) score += 1;

    return { block, index, score };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: Array<{ block: string; index: number }> = [];
  let totalChars = 0;

  for (const item of scored) {
    const addition = item.block.length + 2;
    if (totalChars + addition > maxChars) {
      if (selected.length === 0) {
        selected.push({ block: item.block.slice(0, maxChars), index: item.index });
      }
      continue;
    }
    selected.push({ block: item.block, index: item.index });
    totalChars += addition;
  }

  selected.sort((a, b) => a.index - b.index);
  return selected.map((s) => s.block).join('\n\n');
}

export async function fetchAndExtractPage(
  url: string,
  queryHint = '',
  timeoutMs = 3800,
): Promise<ExtractedPage | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChronosSearchAgent/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
    });

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('xhtml')) {
      return null;
    }

    // Cap response body at 1.5MB so huge pages never blow memory or latency
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const maxBytes = 1_500_000;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const html = Buffer.concat(chunks).toString('utf8');
    if (contentType.includes('text/plain')) {
      return {
        url,
        title: url,
        markdown: html.slice(0, 8000),
        wordCount: html.split(/\s+/).length,
      };
    }

    return htmlToCompactMarkdown(html, url, queryHint);
  } catch {
    return null;
  }
}
