import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LLMClient, LLMMessage, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './types.js';

export class AnthropicLLMClient implements LLMClient {
  public readonly providerName = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private mapMessages(messages: LLMMessage[]): MessageParam[] {
    const out: MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const blocks: ContentBlockParam[] = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        if (blocks.length > 0) {
          out.push({ role: 'assistant', content: blocks });
        }
      } else if (msg.role === 'tool') {
        // Anthropic expects consecutive tool results grouped in one 'user' message
        const toolResults: ContentBlockParam[] = [];
        let j = i;
        while (j < messages.length && messages[j]!.role === 'tool') {
          const tm = messages[j]! as Extract<LLMMessage, { role: 'tool' }>;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tm.toolCallId,
            content: tm.content,
          });
          j += 1;
        }
        out.push({ role: 'user', content: toolResults });
        i = j - 1;
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
    const tools: Tool[] = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Tool.InputSchema,
    }));

    const stream = this.client.messages.stream(
      {
        model: params.model,
        max_tokens: 4096,
        system: params.system,
        messages: this.mapMessages(params.messages),
        ...(tools.length > 0 ? { tools } : {}),
        temperature: 0.2,
      },
      { signal: params.signal },
    );

    const activeToolBlocks = new Map<number, { id: string; name: string; jsonBuf: string }>();
    let stopReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          activeToolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            jsonBuf: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const entry = activeToolBlocks.get(event.index);
          if (entry) entry.jsonBuf += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        const entry = activeToolBlocks.get(event.index);
        if (entry) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(entry.jsonBuf || '{}') as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          const call: LLMToolCall = { id: entry.id, name: entry.name, arguments: parsed };
          yield { type: 'tool_call', call };
          activeToolBlocks.delete(event.index);
        }
      } else if (event.type === 'message_delta') {
        if (event.delta.stop_reason === 'tool_use') stopReason = 'tool_calls';
        else if (event.delta.stop_reason === 'max_tokens') stopReason = 'length';
        else if (event.delta.stop_reason === 'end_turn') stopReason = 'stop';
      }
    }

    yield { type: 'finish', stopReason };
  }

  async completeText(params: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> {
    const res = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 500,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
      temperature: 0.1,
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}
