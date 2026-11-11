import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveMemory } from '../src/server/memory/retriever.js';
import { MemoryStore } from '../src/server/memory/store.js';

function seedEpisode(params: {
  store: MemoryStore;
  convId: string;
  createdAt: string;
  localDate: string;
  userQuery: string;
  assistantContent: string;
  topic: string;
  entities: string[];
  claims: Array<{ entity: string; claim: string; category: 'pricing' | 'release' | 'fact' | 'recommendation' | 'other'; valueSnapshot?: string }>;
}) {
  const { store, convId, createdAt, localDate } = params;
  if (!store.getConversation(convId)) {
    store.createConversation(params.topic, convId, createdAt);
  }
  const uMsg = store.addMessage({
    conversationId: convId,
    role: 'user',
    content: params.userQuery,
    timezone: 'UTC',
    createdAt,
  });
  const aMsg = store.addMessage({
    conversationId: convId,
    role: 'assistant',
    content: params.assistantContent,
    timezone: 'UTC',
    createdAt,
  });
  store.upsertEpisode({
    conversationId: convId,
    userMessageId: uMsg.id,
    assistantMessageId: aMsg.id,
    createdAt,
    localDate,
    topic: params.topic,
    userQuery: params.userQuery,
    assistantSummary: params.assistantContent.slice(0, 200),
    entities: params.entities,
    claims: params.claims,
  });
}

test('retrieves cross-session episodes by date and disambiguates ambiguous weekday by topic', () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z'); // Wednesday

  // Episode on Tuesday Nov 3: Postgres hosting
  seedEpisode({
    store,
    convId: 'conv-pg',
    createdAt: '2026-11-03T14:00:00Z',
    localDate: '2026-11-03',
    topic: 'Managed Postgres hosting pricing comparison',
    userQuery: 'Compare Postgres hosting options like Neon, Supabase, and Render.',
    assistantContent: 'Neon Pro starts at $19/mo; Supabase Pro is $25/mo; Render Postgres starts at $7/mo.',
    entities: ['Neon', 'Supabase', 'Render'],
    claims: [
      { entity: 'Neon', claim: 'Neon Launch/Pro plan starts at $19/mo', category: 'pricing', valueSnapshot: '$19/mo' },
      { entity: 'Supabase', claim: 'Supabase Pro plan is $25/mo', category: 'pricing', valueSnapshot: '$25/mo' },
    ],
  });

  // Episode on Tuesday Nov 10 (yesterday): unrelated topic
  seedEpisode({
    store,
    convId: 'conv-react',
    createdAt: '2026-11-10T10:00:00Z',
    localDate: '2026-11-10',
    topic: 'React 19 compiler memoization rules',
    userQuery: 'How does the React compiler optimize useMemo?',
    assistantContent: 'React compiler automatically memoizes components and hooks at build time.',
    entities: ['React'],
    claims: [],
  });

  // Query on Nov 11: "Last Tuesday I asked you about Postgres hosting."
  const res = retrieveMemory({
    store,
    query: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    now,
    timeZone: 'UTC',
  });

  assert.equal(res.status, 'hit');
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0]!.localDate, '2026-11-03');
  assert.equal(res.hits[0]!.matchReason, 'temporal+keyword');
  assert.deepEqual(res.hits[0]!.entities, ['Neon', 'Supabase', 'Render']);

  store.close();
});

test('returns negative evidence when no records exist on queried date', () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z');

  seedEpisode({
    store,
    convId: 'conv-monday',
    createdAt: '2026-11-09T11:00:00Z',
    localDate: '2026-11-09',
    topic: 'CRM shortlist',
    userQuery: 'Shortlist 5 CRM tools',
    assistantContent: 'HubSpot, Pipedrive, Salesforce, Close, Attio.',
    entities: ['HubSpot', 'Pipedrive', 'Salesforce', 'Close', 'Attio'],
    claims: [],
  });

  const res = retrieveMemory({
    store,
    query: 'What did I ask you on 3 November?',
    now,
    timeZone: 'UTC',
  });

  assert.equal(res.status, 'no_records_for_date');
  assert.equal(res.hits.length, 0);
  assert.deepEqual(res.availableRecentDates, ['2026-11-09']);

  store.close();
});

test('recalls cross-session episodes by keyword even without explicit date', () => {
  const store = new MemoryStore(':memory:');
  const now = new Date('2026-11-11T15:00:00Z');

  seedEpisode({
    store,
    convId: 'conv-crm',
    createdAt: '2026-11-09T11:00:00Z',
    localDate: '2026-11-09',
    topic: 'Shortlist 5 CRM tools for 20-person sales team',
    userQuery: 'Shortlist 5 CRM tools for our 20-person sales team',
    assistantContent: 'Shortlisted: HubSpot, Pipedrive, Close, Attio, Salesforce.',
    entities: ['HubSpot', 'Pipedrive', 'Close', 'Attio', 'Salesforce'],
    claims: [],
  });

  const res = retrieveMemory({
    store,
    query: 'Remember that CRM shortlist for our sales team?',
    now,
    timeZone: 'UTC',
  });

  assert.equal(res.status, 'hit');
  assert.equal(res.hits[0]!.conversationId, 'conv-crm');
  assert.equal(res.hits[0]!.matchReason, 'keyword');

  store.close();
});
