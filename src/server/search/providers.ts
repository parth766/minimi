import { parseHTML } from 'linkedom';
import type { Freshness, SearchDepth } from '../../shared/types.js';
import type { AppConfig } from '../config.js';

export interface RawSearchHit {
  url: string;
  title: string;
  snippet: string;
  rawContent?: string;
  publishedDate?: string;
}

export interface ProviderSearchOptions {
  query: string;
  freshness?: Freshness;
  includeDomains?: string[];
  depth?: SearchDepth;
  maxResults?: number;
}

export interface SearchProvider {
  name: string;
  search(opts: ProviderSearchOptions): Promise<RawSearchHit[]>;
}

function freshnessToDays(freshness: Freshness | undefined): number | undefined {
  switch (freshness) {
    case 'day': return 2;
    case 'week': return 8;
    case 'month': return 32;
    case 'year': return 365;
    default: return undefined;
  }
}

export class TavilySearchProvider implements SearchProvider {
  name = 'tavily';
  constructor(private readonly apiKey: string) {}

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query: opts.query,
      search_depth: opts.depth === 'deep' ? 'advanced' : 'basic',
      max_results: opts.maxResults ?? 6,
      include_raw_content: opts.depth === 'deep' ? 'markdown' : false,
      include_answer: false,
    };

    if (opts.freshness && opts.freshness !== 'all') {
      body.time_range = opts.freshness;
    }
    if (opts.includeDomains && opts.includeDomains.length > 0) {
      body.include_domains = opts.includeDomains;
    }

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        url?: string;
        title?: string;
        content?: string;
        raw_content?: string;
        published_date?: string;
      }>;
    };

    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        url: r.url!,
        title: r.title!,
        snippet: r.content ?? '',
        rawContent: r.raw_content ?? undefined,
        publishedDate: r.published_date ? r.published_date.slice(0, 10) : undefined,
      }));
  }
}

export class ExaSearchProvider implements SearchProvider {
  name = 'exa';
  constructor(private readonly apiKey: string) {}

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    const days = freshnessToDays(opts.freshness);
    const startPublishedDate = days
      ? new Date(Date.now() - days * 86_400_000).toISOString()
      : undefined;

    const body: Record<string, unknown> = {
      query: opts.query,
      numResults: opts.maxResults ?? 6,
      type: 'auto',
      contents: {
        highlights: { maxCharacters: 1200 },
        ...(opts.depth === 'deep' ? { text: { maxCharacters: 3500 } } : {}),
      },
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
    };

    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Exa search failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        url?: string;
        title?: string;
        publishedDate?: string;
        highlights?: string[];
        text?: string;
      }>;
    };

    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        url: r.url!,
        title: r.title || r.url!,
        snippet: r.highlights?.join('\n...\n') ?? r.text?.slice(0, 600) ?? '',
        rawContent: r.text ?? undefined,
        publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : undefined,
      }));
  }
}

export class SerperSearchProvider implements SearchProvider {
  name = 'serper';
  constructor(private readonly apiKey: string) {}

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    const domainFilter = opts.includeDomains?.length
      ? ` (${opts.includeDomains.map((d) => `site:${d}`).join(' OR ')})`
      : '';
    const tbsMap: Partial<Record<Freshness, string>> = {
      day: 'qdr:d',
      week: 'qdr:w',
      month: 'qdr:m',
      year: 'qdr:y',
    };

    const body: Record<string, unknown> = {
      q: `${opts.query}${domainFilter}`,
      num: opts.maxResults ?? 6,
      ...(opts.freshness && tbsMap[opts.freshness] ? { tbs: tbsMap[opts.freshness] } : {}),
    };

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Serper search failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      organic?: Array<{
        link?: string;
        title?: string;
        snippet?: string;
        date?: string;
      }>;
    };

    return (data.organic ?? [])
      .filter((r) => r.link && r.title)
      .map((r) => ({
        url: r.link!,
        title: r.title!,
        snippet: r.snippet ?? '',
        publishedDate: r.date,
      }));
  }
}

export class BraveSearchProvider implements SearchProvider {
  name = 'brave';
  constructor(private readonly apiKey: string) {}

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    const domainFilter = opts.includeDomains?.length
      ? ` (${opts.includeDomains.map((d) => `site:${d}`).join(' OR ')})`
      : '';
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', `${opts.query}${domainFilter}`);
    url.searchParams.set('count', String(opts.maxResults ?? 6));

    const freshnessMap: Partial<Record<Freshness, string>> = {
      day: 'pd',
      week: 'pw',
      month: 'pm',
      year: 'py',
    };
    if (opts.freshness && freshnessMap[opts.freshness]) {
      url.searchParams.set('freshness', freshnessMap[opts.freshness]!);
    }

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Brave search failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      web?: {
        results?: Array<{
          url?: string;
          title?: string;
          description?: string;
          page_age?: string;
        }>;
      };
    };

    return (data.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        url: r.url!,
        title: r.title!,
        snippet: r.description ?? '',
        publishedDate: r.page_age ? r.page_age.slice(0, 10) : undefined,
      }));
  }
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  name = 'duckduckgo';

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    const domainFilter = opts.includeDomains?.length
      ? ` (${opts.includeDomains.map((d) => `site:${d}`).join(' OR ')})`
      : '';
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', `${opts.query}${domainFilter}`);

    const dfMap: Partial<Record<Freshness, string>> = {
      day: 'd',
      week: 'w',
      month: 'm',
      year: 'y',
    };
    if (opts.freshness && dfMap[opts.freshness]) {
      url.searchParams.set('df', dfMap[opts.freshness]!);
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(7000),
    });

    if (res.status === 202 || res.status === 403 || res.status === 429) {
      throw new Error(
        `DuckDuckGo fallback rate-limited/challenged this request (HTTP ${res.status}). Configure TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY, or BRAVE_SEARCH_API_KEY in .env for reliable search.`,
      );
    }
    if (!res.ok) {
      throw new Error(`DuckDuckGo fallback failed (${res.status})`);
    }

    const html = await res.text();
    if (/anomaly-modal|challenge/i.test(html) && !html.includes('result__a')) {
      throw new Error(
        'DuckDuckGo fallback received a bot challenge page. Configure TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY, or BRAVE_SEARCH_API_KEY in .env for reliable search.',
      );
    }

    const { document } = parseHTML(html);
    const hits: RawSearchHit[] = [];
    const results = document.querySelectorAll('.result');

    for (const el of results) {
      const linkEl = el.querySelector('.result__a');
      const snippetEl = el.querySelector('.result__snippet');
      const rawHref = linkEl?.getAttribute('href') ?? '';
      const resolvedUrl = unwrapDuckDuckGoUrl(rawHref);
      const title = linkEl?.textContent?.trim() ?? '';
      const snippet = snippetEl?.textContent?.trim() ?? '';

      if (resolvedUrl && title && !resolvedUrl.includes('duckduckgo.com')) {
        hits.push({ url: resolvedUrl, title, snippet });
      }
      if (hits.length >= (opts.maxResults ?? 6)) break;
    }

    return hits;
  }
}

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const full = href.startsWith('//') ? `https:${href}` : href.startsWith('/') ? `https://duckduckgo.com${href}` : href;
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : full;
  } catch {
    return href;
  }
}

export function createSearchProvider(config: AppConfig): SearchProvider {
  if (config.tavilyApiKey) return new TavilySearchProvider(config.tavilyApiKey);
  if (config.exaApiKey) return new ExaSearchProvider(config.exaApiKey);
  if (config.serperApiKey) return new SerperSearchProvider(config.serperApiKey);
  if (config.braveApiKey) return new BraveSearchProvider(config.braveApiKey);
  return new DuckDuckGoSearchProvider();
}
