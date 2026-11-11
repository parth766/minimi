import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { OllamaLLMClient } from '../src/server/llm/ollama.js';
import { WEB_SEARCH_TOOL_SCHEMA } from '../src/server/search/tool.js';

test('config auto-detects Ollama when OLLAMA_MODEL is set and reuses model for distillation', () => {
  const cfg = loadConfig({ OLLAMA_MODEL: 'qwen3:8b', OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1/' });
  assert.equal(cfg.llmProvider, 'ollama');
  assert.equal(cfg.llmModel, 'qwen3:8b');
  assert.equal(cfg.distillModel, 'qwen3:8b');
  assert.equal(cfg.ollamaNumCtx, 16384);
});

test('OllamaLLMClient streams NDJSON tool calls, filters thinking chunks, and sets num_ctx', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    const ndjson = [
      JSON.stringify({ message: { role: 'assistant', thinking: 'internal reasoning' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: 'Checking ' }, done: false }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'web_search',
                arguments: { queries: [{ query: 'Neon Postgres pricing 2026' }], depth: 'deep' },
              },
            },
          ],
        },
        done: true,
        done_reason: 'stop',
      }),
    ].join('\n');

    return new Response(ndjson, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }) as typeof fetch;

  try {
    const client = new OllamaLLMClient('http://localhost:11434/v1/', 16384);
    const events = [];
    for await (const ev of client.streamChat({
      model: 'qwen3:8b',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Check Neon pricing' }],
      tools: [WEB_SEARCH_TOOL_SCHEMA],
    })) {
      events.push(ev);
    }

    assert.equal(capturedUrl, 'http://localhost:11434/api/chat');
    assert.equal((capturedBody.options as Record<string, unknown>).num_ctx, 16384);
    assert.deepEqual(events[0], { type: 'text_delta', text: 'Checking ' });
    assert.equal(events[1]?.type, 'tool_call');
    if (events[1]?.type === 'tool_call') {
      assert.equal(events[1].call.name, 'web_search');
      assert.deepEqual(events[1].call.arguments, {
        queries: [{ query: 'Neon Postgres pricing 2026' }],
        depth: 'deep',
      });
    }
    assert.deepEqual(events[2], { type: 'finish', stopReason: 'tool_calls' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaLLMClient surfaces actionable error when model lacks tool support', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}', {
      status: 400,
    })) as typeof fetch;

  try {
    const client = new OllamaLLMClient();
    await assert.rejects(
      async () => {
        for await (const _ of client.streamChat({
          model: 'gemma:2b',
          system: 'System',
          messages: [{ role: 'user', content: 'Hi' }],
          tools: [WEB_SEARCH_TOOL_SCHEMA],
        })) {
          // noop
        }
      },
      /does not support tool calling required for web_search/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
