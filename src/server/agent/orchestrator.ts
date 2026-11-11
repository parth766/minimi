import { randomUUID } from 'node:crypto';
import type {
  AgentTrace,
  ChatSSEEvent,
  Message,
  SearchRoundTrace,
} from '../../shared/types.js';
import type { LLMClient, LLMMessage, LLMToolCall } from '../llm/types.js';
import { distillEpisodeAsync, distillEpisodeHeuristic } from '../memory/distiller.js';
import { retrieveMemory } from '../memory/retriever.js';
import { MemoryStore } from '../memory/store.js';
import { normalizeWebSearchArgs, SourceRegistry, WEB_SEARCH_TOOL_SCHEMA, WebSearchExecutor } from '../search/tool.js';
import { buildSystemPrompt } from './prompt.js';

export interface RunAgentTurnParams {
  store: MemoryStore;
  llm: LLMClient;
  model: string;
  distillModel: string;
  searchExecutor: WebSearchExecutor;
  conversationId: string;
  userText: string;
  timeZone: string;
  now?: Date;
  signal?: AbortSignal;
  emit: (event: ChatSSEEvent) => void;
}

const MAX_CONTEXT_TURNS = 12;
const MAX_TOOL_ROUNDS = 4;

export async function runAgentTurn(params: RunAgentTurnParams): Promise<Message> {
  const startedAt = Date.now();
  const now = params.now ?? new Date();
  const { store, llm, model, distillModel, searchExecutor, conversationId, userText, timeZone, signal, emit } = params;

  const existingConv = store.getConversation(conversationId);
  if (!existingConv) {
    store.createConversation('New Chat', conversationId, now.toISOString());
  }

  const priorMessages = store.getMessages(conversationId);
  const recentWindow = priorMessages.slice(-MAX_CONTEXT_TURNS);
  const excludeIds = new Set(recentWindow.filter((m) => m.role === 'assistant').map((m) => m.id));

  const userMessage = store.addMessage({
    conversationId,
    role: 'user',
    content: userText,
    timezone: timeZone,
    createdAt: now.toISOString(),
  });
  const assistantMessageId = randomUUID();

  emit({
    type: 'meta',
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId,
  });

  // 1. Pre-flight temporal + episodic memory hydration (sub-10ms, zero LLM calls)
  emit({ type: 'status', phase: 'hydrating_memory', label: 'Checking episodic memory...' });
  const retrieval = retrieveMemory({
    store,
    query: userText,
    now,
    timeZone,
    excludeAssistantMessageIds: excludeIds,
  });

  const memoryHitsTrace: AgentTrace['memoryHits'] = retrieval.hits.map((h) => ({
    localDate: h.localDate,
    topic: h.topic,
    matchReason: h.matchReason,
    entitiesCount: h.entities.length,
    claimsCount: h.claims.length,
  }));

  const isDiffQuery = /\b(since|changed|change|updated|still|correct|shipped|new)\b/i.test(userText);
  const effectiveSinceDate =
    retrieval.temporal.sinceDate ??
    (isDiffQuery && retrieval.hits.length > 0 ? retrieval.hits[0]!.localDate : undefined);

  emit({
    type: 'memory',
    status: retrieval.status,
    hits: memoryHitsTrace,
    temporal: retrieval.temporal,
  });

  // 2. Construct grounded prompt + windowed conversation history
  const systemPrompt = buildSystemPrompt({
    now,
    timeZone,
    retrieval,
    effectiveSinceDate,
  });
  const llmMessages: LLMMessage[] = [
    ...recentWindow.map((m): LLMMessage => ({
      role: m.role,
      content: m.role === 'user' ? `[${m.localDate}] ${m.content}` : m.content,
    })),
    { role: 'user', content: userText },
  ];

  // 3. Streaming Agent Loop (single tool: web_search)
  const registry = new SourceRegistry();
  const searchRounds: SearchRoundTrace[] = [];
  let finalText = '';
  let firstTokenMs: number | undefined;

  emit({ type: 'status', phase: 'thinking', label: 'Thinking...' });

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break;

    let roundText = '';
    const roundToolCalls: LLMToolCall[] = [];

    for await (const event of llm.streamChat({
      model,
      system: systemPrompt,
      messages: llmMessages,
      tools: [WEB_SEARCH_TOOL_SCHEMA],
      signal,
    })) {
      if (event.type === 'text_delta') {
        if (firstTokenMs === undefined && event.text.length > 0) {
          firstTokenMs = Date.now() - startedAt;
        }
        // Separate pre-tool preamble from post-tool answer cleanly
        if (roundText.length === 0 && finalText.length > 0 && !finalText.endsWith('\n')) {
          const separator = '\n\n';
          finalText += separator;
          emit({ type: 'delta', text: separator });
        }
        roundText += event.text;
        finalText += event.text;
        emit({ type: 'delta', text: event.text });
      } else if (event.type === 'tool_call') {
        roundToolCalls.push(event.call);
      }
    }

    if (roundToolCalls.length === 0) {
      break;
    }

    llmMessages.push({
      role: 'assistant',
      content: roundText,
      toolCalls: roundToolCalls,
    });

    // Execute any emitted web_search calls in parallel
    const validCalls = roundToolCalls.filter((c) => c.name === 'web_search');
    if (validCalls.length === 0) break;

    // Emit live search activity preview for UI
    try {
      const previewQueries = validCalls.flatMap((c) => {
        try {
          return normalizeWebSearchArgs(c.arguments).queries;
        } catch {
          return [];
        }
      });
      const firstDepth = (() => {
        try {
          return normalizeWebSearchArgs(validCalls[0]!.arguments).depth;
        } catch {
          return 'fast' as const;
        }
      })();
      emit({
        type: 'tool_start',
        round,
        queries: previewQueries.map((q) => ({
          query: q.query,
          purpose: q.purpose,
          freshness: q.freshness,
        })),
        depth: firstDepth,
      });
    } catch {
      // Ignore UI preview normalization issue
    }

    emit({
      type: 'status',
      phase: 'searching',
      label: `Searching web (round ${round})...`,
    });

    const executions = await Promise.all(
      validCalls.map(async (call) => {
        try {
          const res = await searchExecutor.execute({
            rawArgs: call.arguments,
            round,
            registry,
            sinceDate: effectiveSinceDate,
          });
          return { call, result: res, error: undefined };
        } catch (err) {
          return {
            call,
            result: undefined,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    for (const ex of executions) {
      if (ex.result) {
        searchRounds.push(ex.result.roundTrace);
        llmMessages.push({
          role: 'tool',
          toolCallId: ex.call.id,
          toolName: ex.call.name,
          content: ex.result.observationText,
        });
      } else {
        llmMessages.push({
          role: 'tool',
          toolCallId: ex.call.id,
          toolName: ex.call.name,
          content: `[web_search error]: ${ex.error ?? 'Unknown failure'}`,
        });
      }
    }

    emit({ type: 'sources', sources: registry.all() });
    emit({ type: 'status', phase: 'synthesizing', label: 'Synthesizing answer...' });

    // If this was the final allowed search round, force synthesis with no tools next
    if (round === MAX_TOOL_ROUNDS && !signal?.aborted) {
      for await (const event of llm.streamChat({
        model,
        system: systemPrompt,
        messages: llmMessages,
        tools: [],
        signal,
      })) {
        if (event.type === 'text_delta') {
          if (firstTokenMs === undefined && event.text.length > 0) {
            firstTokenMs = Date.now() - startedAt;
          }
          if (finalText.length > 0 && !finalText.endsWith('\n')) {
            finalText += '\n\n';
            emit({ type: 'delta', text: '\n\n' });
          }
          finalText += event.text;
          emit({ type: 'delta', text: event.text });
        }
      }
    }
  }

  const sources = registry.all();
  const trace: AgentTrace = {
    provider: llm.providerName,
    model,
    searchProvider: searchExecutor.providerName,
    temporalResolution: retrieval.temporal,
    memoryStatus: retrieval.status,
    memoryHits: memoryHitsTrace,
    searchRounds,
    totalDurationMs: Date.now() - startedAt,
    firstTokenMs,
  };

  const assistantMessage = store.addMessage({
    id: assistantMessageId,
    conversationId,
    role: 'assistant',
    content: finalText.trim(),
    timezone: timeZone,
    createdAt: new Date().toISOString(),
    metadata: { sources, trace },
  });

  // 4. Synchronous fast heuristic episode persistence (zero latency gap!)
  const heuristic = distillEpisodeHeuristic({
    userQuery: userText,
    assistantContent: assistantMessage.content,
    sources,
  });

  store.upsertEpisode({
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    createdAt: userMessage.createdAt,
    localDate: userMessage.localDate,
    topic: heuristic.topic,
    userQuery: userText,
    assistantSummary: heuristic.assistantSummary,
    entities: heuristic.entities,
    claims: heuristic.claims,
  });

  // 5. Async background LLM enrichment + concise conversation title on first turn
  void distillEpisodeAsync({
    store,
    llm,
    model: distillModel,
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    createdAt: userMessage.createdAt,
    localDate: userMessage.localDate,
    userQuery: userText,
    assistantContent: assistantMessage.content,
    sources,
  });

  if (priorMessages.length === 0) {
    void generateConversationTitle(store, llm, distillModel, conversationId, userText);
  }

  emit({ type: 'done', message: assistantMessage });
  return assistantMessage;
}

async function generateConversationTitle(
  store: MemoryStore,
  llm: LLMClient,
  model: string,
  conversationId: string,
  userText: string,
): Promise<void> {
  try {
    const conv = store.getConversation(conversationId);
    if (!conv || conv.title !== 'New Chat') return;
    const title = await llm.completeText({
      model,
      system: 'Write a crisp 3-6 word chat title. Output only the title, no quotes or trailing punctuation.',
      prompt: userText.slice(0, 400),
      maxTokens: 24,
    });
    const cleaned = title.replace(/^["']|["']$/g, '').trim().slice(0, 80);
    if (cleaned) {
      store.updateConversationTitle(conversationId, cleaned);
    }
  } catch {
    const fallback = userText.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (fallback) store.updateConversationTitle(conversationId, fallback);
  }
}
