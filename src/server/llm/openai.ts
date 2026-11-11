import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMClient, LLMMessage, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './types.js';

export class OpenAILLMClient implements LLMClient {
  public readonly providerName = 'openai';
  private readonly client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  private mapMessages(system: string, messages: LLMMessage[]): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

    for (const msg of messages) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: msg.content || null,
          ...(msg.toolCalls && msg.toolCalls.length > 0
            ? {
                tool_calls: msg.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        });
      } else if (msg.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }
    return out;
  }

  async *streamChat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: LLMToolDefinition[];
    signal?: AbortSignal;
  }): AsyncGenerator<LLMStreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: params.model,
        messages: this.mapMessages(params.system, params.messages),
        ...(params.tools.length > 0
          ? {
              tools: params.tools.map((t) => ({
                type: 'function' as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
        stream: true,
        temperature: 0.2,
      },
      { signal: params.signal },
    );

    const pendingCalls = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const entry = pendingCalls.get(tc.index) ?? { id: '', name: '', argsRaw: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.argsRaw += tc.function.arguments;
          pendingCalls.set(tc.index, entry);
        }
      }

      if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
      else if (choice.finish_reason === 'length') finishReason = 'length';
      else if (choice.finish_reason === 'stop') finishReason = 'stop';
    }

    for (const [, entry] of Array.from(pendingCalls.entries()).sort((a, b) => a[0] - b[0])) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(entry.argsRaw || '{}') as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }
      const call: LLMToolCall = {
        id: entry.id || `call_${Date.now()}`,
        name: entry.name,
        arguments: parsedArgs,
      };
      yield { type: 'tool_call', call };
    }

    yield { type: 'finish', stopReason: finishReason };
  }

  async completeText(params: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: params.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.prompt },
      ],
      max_tokens: params.maxTokens ?? 500,
      temperature: 0.1,
    });
    return res.choices[0]?.message?.content ?? '';
  }
}
