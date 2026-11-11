import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSSEEvent } from '../src/shared/types.js';
import { runAgentTurn } from '../src/server/agent/orchestrator.js';
import type { LLMClient, LLMMessage, LLMStreamEvent, LLMToolDefinition } from '../src/server/llm/types.js';
import { MemoryStore } from '../src/server/memory/store.js';
import type { ProviderSearchOptions, RawSearchHit, SearchProvider } from '../src/server/search/providers.js';
import { WebSearchExecutor } from '../src/server/search/tool.js';

class ScenarioMockLLM implements LLMClient {
  providerName = 'mock-llm';
  observedSystems: string[] = [];
  observedTools: LLMToolDefinition[][] = [];
  turnStep = 0;

  constructor(
    private readonly handler: (params: {
      system: string;
      messages: LLMMessage[];
      tools: LLMToolDefinition[];
      step: number;
    }) => LLMStreamEvent[],
  ) {}

  async *streamChat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: LLMToolDefinition[];
  }): AsyncGenerator<LLMStreamEvent> {
    this.turnStep += 1;
    this.observedSystems.push(params.system);
    this.observedTools.push(params.tools);
    const events = this.handler({
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      step: this.turnStep,
    });
    for (const ev of events) {
      yield ev;
    }
  }

  async completeText(): Promise<string> {
    return '{"topic":"mock","assistantSummary":"mock","entities":[],"claims":[]}';
  }
}

class MockSearch implements SearchProvider {
  name = 'mock-search';
  queriesRun: string[] = [];

  async search(opts: ProviderSearchOptions): Promise<RawSearchHit[]> {
    this.queriesRun.push(opts.query);
    return [
      {
        url: `https://official.example.com/${encodeURIComponent(opts.query.split(' ')[0] ?? 'item')}`,
        title: `Official ${opts.query}`,
        snippet: `Verified update for ${opts.query} as of 2026-11-11.`,
        rawContent: `Verified update for ${opts.query} as of 2026-11-11.`,
        publishedDate: '2026-11-11',
      },
    ];
  }
}

function seedPastTurn(params: {
  store: MemoryStore;
  convId: string;
  createdAt: string;
  localDate: string;
  userQuery: string;
  assistantReply: string;
  topic: string;
  entities: string[];
  claims: Array<{ entity: string; claim: string; category: 'pricing' | 'release' | 'fact' | 'recommendation' | 'other'; valueSnapshot?: string }>;
}) {
  params.store.createConversation(params.topic, params.convId, params.createdAt);
  const u = params.store.addMessage({
    conversationId: params.convId,
    role: 'user',
    content: params.userQuery,
    timezone: 'UTC',
    createdAt: params.createdAt,
  });
  const a = params.store.addMessage({
    conversationId: params.convId,
    role: 'assistant',
    content: params.assistantReply,
    timezone: 'UTC',
    createdAt: params.createdAt,
  });
  params.store.upsertEpisode({
    conversationId: params.convId,
    userMessageId: u.id,
    assistantMessageId: a.id,
    createdAt: params.createdAt,
    localDate: params.localDate,
    topic: params.topic,
    userQuery: params.userQuery,
    assistantSummary: params.assistantReply,
    entities: params.entities,
    claims: params.claims,
  });
}

test('Scenario 1: Monday 5 CRMs shortlist -> hydrates memory & executes 1 parallel batch search', async () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z'); // Wednesday

  seedPastTurn({
    store,
    convId: 'conv-mon',
    createdAt: '2026-11-09T10:00:00Z',
    localDate: '2026-11-09',
    topic: 'Shortlist 5 CRM tools for 20-person sales team',
    userQuery: 'Shortlist 5 CRM tools for a 20-person sales team.',
    assistantReply: 'Shortlist: HubSpot ($20/seat), Pipedrive ($14/seat), Close ($49/seat), Attio ($29/seat), Salesforce ($25/seat).',
    entities: ['HubSpot', 'Pipedrive', 'Close', 'Attio', 'Salesforce'],
    claims: [
      { entity: 'HubSpot', claim: 'Starter $20/seat', category: 'pricing', valueSnapshot: '$20/seat' },
      { entity: 'Pipedrive', claim: 'Essential $14/seat', category: 'pricing', valueSnapshot: '$14/seat' },
    ],
  });

  const searchProvider = new MockSearch();
  const executor = new WebSearchExecutor(searchProvider);
  const llm = new ScenarioMockLLM(({ step }) => {
    if (step === 1) {
      return [
        {
          type: 'tool_call',
          call: {
            id: 'call_1',
            name: 'web_search',
            arguments: {
              depth: 'deep',
              queries: [
                { query: 'HubSpot pricing changelog November 2026', freshness: 'week' },
                { query: 'Pipedrive pricing changelog November 2026', freshness: 'week' },
                { query: 'Close CRM pricing changelog November 2026', freshness: 'week' },
                { query: 'Attio pricing changelog November 2026', freshness: 'week' },
                { query: 'Salesforce pricing changelog November 2026', freshness: 'week' },
              ],
            },
          },
        },
        { type: 'finish', stopReason: 'tool_calls' },
      ];
    }
    return [
      { type: 'text_delta', text: 'Checked all 5 shortlisted CRMs from Monday (2026-11-09) [1].' },
      { type: 'finish', stopReason: 'stop' },
    ];
  });

  const events: ChatSSEEvent[] = [];
  const msg = await runAgentTurn({
    store,
    llm,
    model: 'mock-model',
    distillModel: 'mock-model',
    searchExecutor: executor,
    conversationId: 'conv-wed-new',
    userText: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    timeZone: 'UTC',
    now,
    emit: (ev) => events.push(ev),
  });

  // Strictly ONE tool exposed to LLM
  assert.equal(llm.observedTools[0]!.length, 1);
  assert.equal(llm.observedTools[0]![0]!.name, 'web_search');

  // Hydrated Monday episode into system prompt
  assert.match(llm.observedSystems[0]!, /2026-11-09/);
  assert.match(llm.observedSystems[0]!, /HubSpot, Pipedrive, Close, Attio, Salesforce/);

  // Single tool round dispatched 5 parallel searches
  assert.equal(searchProvider.queriesRun.length, 5);
  assert.equal(msg.metadata?.trace?.searchRounds.length, 1);
  assert.equal(msg.metadata?.trace?.memoryStatus, 'hit');
  assert.equal(msg.metadata?.sources?.length, 5);

  store.close();
});

test('Scenario 2 & 3: 3 November recall + Last Tuesday Postgres disambiguation', async () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z');

  seedPastTurn({
    store,
    convId: 'conv-nov3',
    createdAt: '2026-11-03T16:00:00Z',
    localDate: '2026-11-03',
    topic: 'Postgres hosting pricing',
    userQuery: 'What are the best managed Postgres hosting providers and their Pro tier pricing?',
    assistantReply: 'Neon Pro is $19/mo and Supabase Pro is $25/mo.',
    entities: ['Neon', 'Supabase'],
    claims: [{ entity: 'Neon', claim: 'Pro $19/mo', category: 'pricing', valueSnapshot: '$19/mo' }],
  });

  // Also add an episode on Nov 10 to test weekday disambiguation
  seedPastTurn({
    store,
    convId: 'conv-nov10',
    createdAt: '2026-11-10T10:00:00Z',
    localDate: '2026-11-10',
    topic: 'CSS Grid subgrid support',
    userQuery: 'Does Safari support CSS subgrid?',
    assistantReply: 'Yes, Safari supports CSS subgrid.',
    entities: ['Safari'],
    claims: [],
  });

  const searchProvider = new MockSearch();
  const executor = new WebSearchExecutor(searchProvider);
  const llm = new ScenarioMockLLM(({ step }) => {
    if (step === 1) {
      return [
        {
          type: 'tool_call',
          call: {
            id: 'call_pg',
            name: 'web_search',
            arguments: {
              depth: 'deep',
              queries: [
                { query: 'Neon Postgres pricing November 2026', freshness: 'month' },
                { query: 'Supabase pricing November 2026', freshness: 'month' },
              ],
            },
          },
        },
        { type: 'finish', stopReason: 'tool_calls' },
      ];
    }
    return [
      { type: 'text_delta', text: 'On 3 November you asked about managed Postgres hosting [1][2].' },
      { type: 'finish', stopReason: 'stop' },
    ];
  });

  const msg = await runAgentTurn({
    store,
    llm,
    model: 'mock-model',
    distillModel: 'mock-model',
    searchExecutor: executor,
    conversationId: 'conv-check',
    userText: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    timeZone: 'UTC',
    now,
    emit: () => {},
  });

  assert.equal(msg.metadata?.trace?.memoryHits[0]?.localDate, '2026-11-03');
  assert.match(llm.observedSystems[0]!, /Neon Pro is \$19\/mo/);
  assert.equal(searchProvider.queriesRun.length, 2);

  store.close();
});

test('Scenario 4: Missing historical date reports no_records_for_date without hallucinating', async () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z');
  const searchProvider = new MockSearch();
  const executor = new WebSearchExecutor(searchProvider);

  const llm = new ScenarioMockLLM(() => [
    { type: 'text_delta', text: 'I do not have any record of a conversation on 3 November.' },
    { type: 'finish', stopReason: 'stop' },
  ]);

  const msg = await runAgentTurn({
    store,
    llm,
    model: 'mock-model',
    distillModel: 'mock-model',
    searchExecutor: executor,
    conversationId: 'conv-empty',
    userText: 'What did I ask you on 3 November?',
    timeZone: 'UTC',
    now,
    emit: () => {},
  });

  assert.match(llm.observedSystems[0]!, /status="no_records_for_date"/);
  assert.equal(msg.metadata?.trace?.memoryStatus, 'no_records_for_date');
  assert.equal(searchProvider.queriesRun.length, 0);

  store.close();
});
