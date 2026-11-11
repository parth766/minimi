import { GoogleGenAI, type Content, type Part } from '@google/genai';
import type { LLMClient, LLMMessage, LLMStreamEvent, LLMToolCall, LLMToolDefinition } from './types.js';

export class GeminiLLMClient implements LLMClient {
  public readonly providerName = 'gemini';
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  private mapContents(messages: LLMMessage[]): Content[] {
    const out: Content[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === 'user') {
        out.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                id: tc.id,
                name: tc.name,
                args: tc.arguments,
              },
              ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            });
          }
        }
        if (parts.length > 0) {
          out.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        const parts: Part[] = [];
        let j = i;
        while (j < messages.length && messages[j]!.role === 'tool') {
          const tm = messages[j]! as Extract<LLMMessage, { role: 'tool' }>;
          parts.push({
            functionResponse: {
              id: tm.toolCallId,
              name: tm.toolName,
              response: { output: tm.content },
            },
          });
          j += 1;
        }
        out.push({ role: 'user', parts });
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
    const stream = await this.ai.models.generateContentStream({
      model: params.model,
      contents: this.mapContents(params.messages),
      config: {
        systemInstruction: params.system,
        temperature: 0.2,
        ...(params.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: params.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
            }
          : {}),
        ...(params.signal ? { abortSignal: params.signal } : {}),
      },
    });

    const emittedCalls: LLMToolCall[] = [];

    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.thought) continue;
        if (part.text) {
          yield { type: 'text_delta', text: part.text };
        }
        if (part.functionCall && part.functionCall.name) {
          emittedCalls.push({
            id: part.functionCall.id ?? `gemini_call_${Date.now()}_${emittedCalls.length}`,
            name: part.functionCall.name,
            arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          });
        }
      }
    }

    for (const call of emittedCalls) {
      yield { type: 'tool_call', call };
    }

    yield {
      type: 'finish',
      stopReason: emittedCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  async completeText(params: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> {
    const res = await this.ai.models.generateContent({
      model: params.model,
      contents: params.prompt,
      config: {
        systemInstruction: params.system,
        maxOutputTokens: params.maxTokens ?? 500,
        temperature: 0.1,
      },
    });
    return res.text ?? '';
  }
}
