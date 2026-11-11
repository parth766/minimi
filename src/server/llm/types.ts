export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type LLMMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LLMToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: LLMToolCall }
  | { type: 'finish'; stopReason: 'stop' | 'tool_calls' | 'length' | 'error' };

export interface LLMClient {
  readonly providerName: string;
  streamChat(params: {
    model: string;
    system: string;
    messages: LLMMessage[];
    tools: LLMToolDefinition[];
    signal?: AbortSignal;
  }): AsyncGenerator<LLMStreamEvent>;

  completeText(params: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string>;
}
