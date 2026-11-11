import type { LLMClient, LLMMessage, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './types.js';

interface OllamaChatChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

export class OllamaLLMClient implements LLMClient {
  public readonly providerName = 'ollama';
  private readonly baseUrl: string;
  private readonly numCtx: number;

  constructor(baseUrl = 'http://localhost:11434', numCtx = 16384) {
    // Normalize trailing slash or accidental /v1 suffix to base Ollama host URL
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    this.numCtx = numCtx;
  }

  private mapMessages(system: string, messages: LLMMessage[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

    for (const msg of messages) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: msg.content,
          ...(msg.toolCalls && msg.toolCalls.length > 0
            ? {
                tool_calls: msg.toolCalls.map((tc) => ({
                  function: {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                })),
              }
            : {}),
        });
      } else if (msg.role === 'tool') {
        out.push({
          role: 'tool',
          tool_name: msg.toolName,
          content: msg.content,
        });
      }
    }

    return out;
  }

  private parseToolArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return raw;
  }

  async *streamChat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: LLMToolDefinition[];
    signal?: AbortSignal;
  }): AsyncGenerator<LLMStreamEvent> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        stream: true,
        messages: this.mapMessages(params.system, params.messages),
        ...(params.tools.length > 0
          ? {
              tools: params.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        options: {
          temperature: 0.2,
          num_ctx: this.numCtx,
        },
      }),
      signal: params.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      if (/does not support tools/i.test(errText)) {
        throw new Error(
          `Ollama model "${params.model}" does not support tool calling required for web_search. Use a tool-capable model such as qwen3, qwen2.5, llama3.1, or mistral.`,
        );
      }
      throw new Error(`Ollama request failed (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Ollama returned an empty response stream.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const collectedCalls: LLMToolCall[] = [];
    let stopReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    const processLine = function* (
      line: string,
      parseArgs: (raw: Record<string, unknown> | string | undefined) => Record<string, unknown>,
    ): Generator<LLMStreamEvent> {
      const trimmed = line.trim();
      if (!trimmed) return;
      const chunk = JSON.parse(trimmed) as OllamaChatChunk;
      if (chunk.error) {
        throw new Error(`Ollama stream error: ${chunk.error}`);
      }
      if (chunk.message?.content) {
        yield { type: 'text_delta', text: chunk.message.content };
      }
      if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
        for (const tc of chunk.message.tool_calls) {
          if (tc.function?.name) {
            collectedCalls.push({
              id: tc.id ?? `ollama_call_${Date.now()}_${collectedCalls.length}`,
              name: tc.function.name,
              arguments: parseArgs(tc.function.arguments),
            });
          }
        }
      }
      if (chunk.done) {
        if (collectedCalls.length > 0) stopReason = 'tool_calls';
        else if (chunk.done_reason === 'length') stopReason = 'length';
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield* processLine(line, (r) => this.parseToolArgs(r));
      }
    }

    if (buffer.trim()) {
      yield* processLine(buffer, (r) => this.parseToolArgs(r));
    }

    for (const call of collectedCalls) {
      yield { type: 'tool_call', call };
    }

    yield {
      type: 'finish',
      stopReason: collectedCalls.length > 0 ? 'tool_calls' : stopReason,
    };
  }

  async completeText(params: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.prompt },
        ],
        options: {
          temperature: 0.1,
          num_ctx: this.numCtx,
          ...(params.maxTokens ? { num_predict: params.maxTokens } : {}),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama completion failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatChunk;
    return data.message?.content ?? '';
  }
}
