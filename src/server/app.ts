import express from 'express';
import { z } from 'zod';
import type { ChatSSEEvent, SystemStatus } from '../shared/types.js';
import { runAgentTurn } from './agent/orchestrator.js';
import { loadConfig } from './config.js';
import { createLLMClient } from './llm/factory.js';
import { MemoryStore } from './memory/store.js';
import { createSearchProvider } from './search/providers.js';
import { WebSearchExecutor } from './search/tool.js';

const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(16000),
  timezone: z.string().min(1).max(100).optional(),
});

export function createApp() {
  const config = loadConfig();
  const store = new MemoryStore(config.dbPath);
  const llm = createLLMClient(config);
  const searchProvider = createSearchProvider(config);
  const searchExecutor = new WebSearchExecutor(searchProvider);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/status', (_req, res) => {
    const issues: string[] = [];
    if (!llm || !config.llmModel) {
      issues.push('No LLM provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OLLAMA_MODEL in .env.');
    }
    const stats = store.getStats();
    const status: SystemStatus = {
      ready: Boolean(llm && config.llmModel),
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
      searchProvider: searchProvider.name,
      issues,
      conversationCount: stats.conversationCount,
      episodeCount: stats.episodeCount,
    };
    res.json(status);
  });

  app.get('/api/conversations', (_req, res) => {
    res.json({ conversations: store.listConversations() });
  });

  app.post('/api/conversations', (req, res) => {
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New Chat';
    const conv = store.createConversation(title);
    res.status(201).json({ conversation: conv });
  });

  app.delete('/api/conversations/:id', (req, res) => {
    store.deleteConversation(req.params.id);
    res.status(204).end();
  });

  app.get('/api/conversations/:id/messages', (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation: conv, messages: store.getMessages(req.params.id) });
  });

  app.get('/api/episodes', (_req, res) => {
    const rows = store.db
      .prepare('SELECT id, conversation_id, local_date, day_of_week, topic, entities_json, claims_json, created_at FROM episodes ORDER BY created_at DESC LIMIT 50')
      .all() as Array<Record<string, unknown>>;
    res.json({
      episodes: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        localDate: r.local_date,
        dayOfWeek: r.day_of_week,
        topic: r.topic,
        entities: JSON.parse(String(r.entities_json ?? '[]')),
        claims: JSON.parse(String(r.claims_json ?? '[]')),
        createdAt: r.created_at,
      })),
    });
  });

  app.post('/api/chat', async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chat request', details: parsed.error.flatten() });
      return;
    }

    if (!llm || !config.llmModel || !config.distillModel) {
      res.status(503).json({
        error: 'No LLM provider configured. Copy .env.example to .env and add OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OLLAMA_MODEL.',
      });
      return;
    }

    const conversationId = parsed.data.conversationId ?? store.createConversation('New Chat').id;
    const timeZone = parsed.data.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const emit = (event: ChatSSEEvent) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      await runAgentTurn({
        store,
        llm,
        model: config.llmModel,
        distillModel: config.distillModel,
        searchExecutor,
        conversationId,
        userText: parsed.data.message,
        timeZone,
        signal: abortController.signal,
        emit,
      });
    } catch (err) {
      if (!abortController.signal.aborted) {
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : 'Unexpected agent error',
        });
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return { app, config, store };
}
