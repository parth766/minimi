import { z } from 'zod';
import type { Freshness, SearchDepth, SearchRoundTrace, SourceRef } from '../../shared/types.js';
import { TTLCache } from './cache.js';
import { compressMarkdownForQuery, fetchAndExtractPage, type ExtractedPage } from './extractor.js';
import type { RawSearchHit, SearchProvider } from './providers.js';
import { canonicalizeUrl, extractDomain, scoreResultAuthority } from './ranker.js';

export const WEB_SEARCH_TOOL_SCHEMA = {
  name: 'web_search',
  description: [
    'Search the live web for current facts, pricing, changelogs, releases, news, and documentation.',
    'Batch multiple independent lookups into `queries` in a SINGLE call (up to 6 queries run in parallel) rather than making serial calls.',
    'Use `depth: "deep"` when exact pricing tables, plans, specs, or recent release details are needed (fetches & extracts primary web pages).',
    'Set `freshness` when checking changes since a recent date.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: '1 to 6 focused search queries executed concurrently.',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Concise keyword search query (3-10 words). Include product name, topic, and current year when helpful.',
            },
            freshness: {
              type: 'string',
              enum: ['day', 'week', 'month', 'year', 'all'],
              description: 'Optional recency filter.',
            },
            includeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional domain restriction (e.g. ["hubspot.com", "pipedrive.com"]).',
            },
            purpose: {
              type: 'string',
              description: 'Brief 3-6 word label describing what this query checks.',
            },
          },
          required: ['query'],
        },
        minItems: 1,
        maxItems: 6,
      },
      depth: {
        type: 'string',
        enum: ['fast', 'deep'],
        description: '"fast" uses search snippets/highlights; "deep" also extracts full primary pages to Markdown (best for pricing & changelogs).',
      },
    },
    required: ['queries'],
  },
} as const;

const QueryItemSchema = z.object({
  query: z.string().min(1).max(300),
  freshness: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
  includeDomains: z.array(z.string().min(1)).max(5).optional(),
  purpose: z.string().max(120).optional(),
});

const BatchArgsSchema = z.object({
  queries: z.array(QueryItemSchema).min(1).max(6),
  depth: z.enum(['fast', 'deep']).optional(),
});

const FlatArgsSchema = z.object({
  query: z.string().min(1).max(300),
  freshness: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
  includeDomains: z.array(z.string().min(1)).max(5).optional(),
  depth: z.enum(['fast', 'deep']).optional(),
  purpose: z.string().max(120).optional(),
});

export interface NormalizedSearchArgs {
  queries: Array<{
    query: string;
    freshness?: Freshness;
    includeDomains?: string[];
    purpose?: string;
  }>;
  depth: SearchDepth;
}

export function normalizeWebSearchArgs(raw: unknown): NormalizedSearchArgs {
  const batch = BatchArgsSchema.safeParse(raw);
  if (batch.success) {
    return {
      queries: batch.data.queries,
      depth: batch.data.depth ?? 'fast',
    };
  }
  const flat = FlatArgsSchema.safeParse(raw);
  if (flat.success) {
    return {
      queries: [
        {
          query: flat.data.query,
          freshness: flat.data.freshness,
          includeDomains: flat.data.includeDomains,
          purpose: flat.data.purpose,
        },
      ],
      depth: flat.data.depth ?? 'fast',
    };
  }
  throw new Error('Invalid web_search arguments: expected { queries: [{ query, ... }] }');
}

export class SourceRegistry {
  private readonly byCanonicalUrl = new Map<string, SourceRef>();
  private readonly ordered: SourceRef[] = [];

  register(hit: {
    url: string;
    title: string;
    publishedDate?: string;
    snippet: string;
    authorityScore: number;
    isPrimarySource: boolean;
    fetchedFullContent?: boolean;
  }): SourceRef {
    const canonical = canonicalizeUrl(hit.url);
    const existing = this.byCanonicalUrl.get(canonical);
    if (existing) {
      if (!existing.publishedDate && hit.publishedDate) existing.publishedDate = hit.publishedDate;
      if (hit.fetchedFullContent) existing.fetchedFullContent = true;
      if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
      return existing;
    }

    const ref: SourceRef = {
      index: this.ordered.length + 1,
      url: hit.url,
      title: hit.title,
      domain: extractDomain(hit.url),
      publishedDate: hit.publishedDate,
      snippet: hit.snippet,
      isPrimarySource: hit.isPrimarySource,
      authorityScore: hit.authorityScore,
      fetchedFullContent: hit.fetchedFullContent,
    };
    this.byCanonicalUrl.set(canonical, ref);
    this.ordered.push(ref);
    return ref;
  }

  all(): SourceRef[] {
    return [...this.ordered];
  }
}

export class WebSearchExecutor {
  private readonly searchCache = new TTLCache<RawSearchHit[]>(300);
  private readonly pageCache = new TTLCache<ExtractedPage | null>(200);

  constructor(private readonly provider: SearchProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  private getSearchTtlMs(freshness?: Freshness): number {
    if (freshness === 'day') return 2 * 60_000;
    if (freshness === 'week') return 5 * 60_000;
    return 10 * 60_000;
  }

  async execute(params: {
    rawArgs: unknown;
    round: number;
    registry: SourceRegistry;
    sinceDate?: string;
  }): Promise<{
    observationText: string;
    roundTrace: SearchRoundTrace;
    newSources: SourceRef[];
  }> {
    const started = Date.now();
    const args = normalizeWebSearchArgs(params.rawArgs);
    let cacheHits = 0;

    // 1. Run all sub-queries concurrently
    const queryResults = await Promise.all(
      args.queries.map(async (q) => {
        const cacheKey = JSON.stringify([
          this.provider.name,
          q.query.trim().toLowerCase(),
          q.freshness ?? 'all',
          q.includeDomains ?? [],
          args.depth,
        ]);

        const cached = this.searchCache.get(cacheKey);
        if (cached) {
          cacheHits += 1;
          return { querySpec: q, hits: cached, error: undefined };
        }

        try {
          const hits = await this.provider.search({
            query: q.query,
            freshness: q.freshness,
            includeDomains: q.includeDomains,
            depth: args.depth,
            maxResults: args.queries.length > 2 ? 4 : 6,
          });
          this.searchCache.set(cacheKey, hits, this.getSearchTtlMs(q.freshness));
          return { querySpec: q, hits, error: undefined };
        } catch (err) {
          return {
            querySpec: q,
            hits: [] as RawSearchHit[],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    // 2. Score and pick top results per sub-query (preserving coverage across every parallel query)
    const perQuerySelected = queryResults.map((qr) => {
      const scored = qr.hits.map((hit) => {
        const { authorityScore, isPrimarySource } = scoreResultAuthority({
          url: hit.url,
          title: hit.title,
          query: qr.querySpec.query,
          publishedDate: hit.publishedDate,
        });
        return { hit, authorityScore, isPrimarySource };
      });
      scored.sort((a, b) => b.authorityScore - a.authorityScore);
      const keepPerQuery = args.queries.length >= 4 ? 3 : 4;
      return {
        querySpec: qr.querySpec,
        error: qr.error,
        selected: scored.slice(0, keepPerQuery),
      };
    });

    // 3. Identify candidate URLs for parallel deep extraction (deduplicated across batch)
    const urlsToFetch = new Map<string, { url: string; queryHint: string }>();
    for (const block of perQuerySelected) {
      for (const item of block.selected) {
        const canonical = canonicalizeUrl(item.hit.url);
        const needsFetch =
          !item.hit.rawContent &&
          (args.depth === 'deep' || (item.isPrimarySource && item.hit.snippet.length < 220));
        if (needsFetch && !urlsToFetch.has(canonical) && urlsToFetch.size < 8) {
          urlsToFetch.set(canonical, { url: item.hit.url, queryHint: block.querySpec.query });
        }
      }
    }

    const extractedByCanonical = new Map<string, ExtractedPage>();
    if (urlsToFetch.size > 0) {
      await Promise.all(
        Array.from(urlsToFetch.entries()).map(async ([canonical, info]) => {
          const cachedPage = this.pageCache.get(canonical);
          if (cachedPage !== undefined) {
            if (cachedPage) extractedByCanonical.set(canonical, cachedPage);
            return;
          }
          const page = await fetchAndExtractPage(info.url, info.queryHint);
          this.pageCache.set(canonical, page, 10 * 60_000);
          if (page) extractedByCanonical.set(canonical, page);
        }),
      );
    }

    // 4. Register citations & format compact, grounded observation blocks
    const outputSections: string[] = [];
    const seenSourcesInBatch = new Set<number>();
    const newSources: SourceRef[] = [];
    let totalResultCount = 0;

    for (const block of perQuerySelected) {
      const header = `### Query: "${block.querySpec.query}"${block.querySpec.purpose ? ` (${block.querySpec.purpose})` : ''}`;
      if (block.error) {
        outputSections.push(`${header}\n[Search Error]: ${block.error}`);
        continue;
      }
      if (block.selected.length === 0) {
        outputSections.push(`${header}\n[No results returned]`);
        continue;
      }

      const itemLines: string[] = [];
      for (const item of block.selected) {
        totalResultCount += 1;
        const canonical = canonicalizeUrl(item.hit.url);
        const extracted = extractedByCanonical.get(canonical);
        const effectiveDate = extracted?.modifiedDate ?? extracted?.publishedDate ?? item.hit.publishedDate;

        let bodyText = '';
        let fetchedFull = false;
        if (item.hit.rawContent) {
          bodyText = compressMarkdownForQuery(item.hit.rawContent, block.querySpec.query, 1600);
          fetchedFull = true;
        } else if (extracted && extracted.markdown.length > item.hit.snippet.length) {
          bodyText = compressMarkdownForQuery(extracted.markdown, block.querySpec.query, 1600);
          fetchedFull = true;
        } else {
          bodyText = item.hit.snippet;
        }

        const ref = params.registry.register({
          url: item.hit.url,
          title: item.hit.title,
          publishedDate: effectiveDate,
          snippet: item.hit.snippet || bodyText.slice(0, 240),
          authorityScore: item.authorityScore,
          isPrimarySource: item.isPrimarySource,
          fetchedFullContent: fetchedFull,
        });

        if (!seenSourcesInBatch.has(ref.index)) {
          seenSourcesInBatch.add(ref.index);
          newSources.push(ref);
        }

        const dateTag = effectiveDate ? `Date: ${effectiveDate}` : 'Date: unknown';
        const staleFlag =
          params.sinceDate && effectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) && effectiveDate < params.sinceDate
            ? ` [PRE-BASELINE < ${params.sinceDate}]`
            : '';
        const primaryTag = item.isPrimarySource ? ' | PRIMARY' : '';

        itemLines.push(
          `[${ref.index}] ${ref.title} (${ref.domain}${primaryTag} | ${dateTag}${staleFlag})\nURL: ${ref.url}\n${bodyText}`,
        );
      }

      outputSections.push(`${header}\n\n${itemLines.join('\n\n')}`);
    }

    const durationMs = Date.now() - started;
    const roundTrace: SearchRoundTrace = {
      round: params.round,
      queries: args.queries,
      depth: args.depth,
      resultCount: totalResultCount,
      pagesFetched: extractedByCanonical.size,
      cacheHits,
      durationMs,
    };

    return {
      observationText: outputSections.join('\n\n---\n\n'),
      roundTrace,
      newSources,
    };
  }
}
