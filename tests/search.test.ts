import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderSearchOptions, RawSearchHit, SearchProvider } from '../src/server/search/providers.js';
import { SourceRegistry, WebSearchExecutor } from '../src/server/search/tool.js';

class MockSearchProvider implements SearchProvider {
  name = 'mock-search';
  calls: ProviderSearchOptions[] = [];

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    this.calls.push(opts);
    if (opts.query.includes('HubSpot')) {
      return [
        {
          url: 'https://www.hubspot.com/pricing/sales?utm_source=google',
          title: 'HubSpot Sales Hub Pricing',
          snippet: 'Starter $20/seat/mo, Professional $100/seat/mo.',
          rawContent: 'HubSpot Sales Hub Pricing: Starter $20/seat/mo, Professional $100/seat/mo.',
          publishedDate: '2026-11-10',
        },
        {
          url: 'https://blog.hubspot.com/old-post',
          title: 'Old HubSpot Post',
          snippet: 'Old announcement.',
          rawContent: 'Old announcement from October.',
          publishedDate: '2026-10-15',
        },
      ];
    }
    if (opts.query.includes('Pipedrive')) {
      return [
        {
          url: 'https://hubspot.com/pricing/sales/', // Duplicate canonical URL to verify dedup
          title: 'HubSpot Sales Hub Pricing',
          snippet: 'Duplicate ref check.',
          rawContent: 'HubSpot Sales Hub Pricing: Starter $20/seat/mo.',
          publishedDate: '2026-11-10',
        },
        {
          url: 'https://www.pipedrive.com/en/pricing',
          title: 'Pipedrive Pricing',
          snippet: 'Essential $14/seat, Advanced $39/seat.',
          rawContent: 'Pipedrive Pricing: Essential $14/seat, Advanced $39/seat.',
          publishedDate: '2026-11-11',
        },
      ];
    }
    return [
      {
        url: `https://example.com/${encodeURIComponent(opts.query)}`,
        title: `Result for ${opts.query}`,
        snippet: `Details for ${opts.query}`,
        rawContent: `Full details for ${opts.query}`,
        publishedDate: '2026-11-11',
      },
    ];
  }
}

test('batches parallel queries, deduplicates canonical URLs, tags pre-baseline dates, and caches', async () => {
  const provider = new MockSearchProvider();
  const executor = new WebSearchExecutor(provider);
  const registry = new SourceRegistry();

  const res1 = await executor.execute({
    rawArgs: {
      queries: [
        { query: 'HubSpot Sales Hub pricing 2026', freshness: 'week', purpose: 'HubSpot pricing' },
        { query: 'Pipedrive pricing 2026', freshness: 'week', purpose: 'Pipedrive pricing' },
        { query: 'Close CRM pricing 2026', freshness: 'week', purpose: 'Close pricing' },
        { query: 'Attio pricing 2026', freshness: 'week', purpose: 'Attio pricing' },
        { query: 'Salesforce pricing 2026', freshness: 'week', purpose: 'Salesforce pricing' },
      ],
      depth: 'fast',
    },
    round: 1,
    registry,
    sinceDate: '2026-11-09',
  });

  assert.equal(provider.calls.length, 5);
  assert.equal(res1.roundTrace.cacheHits, 0);
  assert.match(res1.observationText, /\[PRE-BASELINE < 2026-11-09\]/);
  assert.match(res1.observationText, /PRIMARY/);

  const hubspotSources = registry.all().filter((s) => s.domain === 'hubspot.com');
  assert.equal(hubspotSources.length, 1);

  // Repeat identical query -> served from TTL cache
  const res2 = await executor.execute({
    rawArgs: { query: 'HubSpot Sales Hub pricing 2026', freshness: 'week' },
    round: 2,
    registry,
    sinceDate: '2026-11-09',
  });
  assert.equal(res2.roundTrace.cacheHits, 1);
  assert.equal(provider.calls.length, 5);
});

test('deep mode fetches missing page HTML, extracts pricing table, and caches extracted page', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(
      `<html><head><title>Neon Pricing</title><meta property="article:modified_time" content="2026-11-11" /></head>
       <body><main><table><tr><th>Plan</th><th>Cost</th></tr><tr><td>Launch</td><td>$19/mo</td></tr></table></main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }) as typeof fetch;

  try {
    const provider: SearchProvider = {
      name: 'mock-serp',
      async search() {
        return [
          {
            url: 'https://neon.tech/pricing',
            title: 'Neon Pricing',
            snippet: 'Serverless Postgres pricing...',
          },
        ];
      },
    };

    const executor = new WebSearchExecutor(provider);
    const registry = new SourceRegistry();

    const res = await executor.execute({
      rawArgs: { queries: [{ query: 'Neon pricing 2026' }], depth: 'deep' },
      round: 1,
      registry,
    });

    assert.equal(fetchCount, 1);
    assert.equal(res.roundTrace.pagesFetched, 1);
    assert.match(res.observationText, /\| Launch \| \$19\/mo \|/);
    assert.equal(registry.all()[0]?.publishedDate, '2026-11-11');
    assert.equal(registry.all()[0]?.fetchedFullContent, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
