import type { AppConfig } from '../config.js';
import { AnthropicLLMClient } from './anthropic.js';
import { GeminiLLMClient } from './gemini.js';
import { OllamaLLMClient } from './ollama.js';
import { OpenAILLMClient } from './openai.js';
import type { LLMClient } from './types.js';

export function createLLMClient(config: AppConfig): LLMClient | null {
  if (!config.llmProvider) return null;

  switch (config.llmProvider) {
    case 'openai':
      if (!config.openaiApiKey) return null;
      return new OpenAILLMClient(config.openaiApiKey, config.openaiBaseUrl);
    case 'anthropic':
      if (!config.anthropicApiKey) return null;
      return new AnthropicLLMClient(config.anthropicApiKey);
    case 'gemini':
      if (!config.geminiApiKey) return null;
      return new GeminiLLMClient(config.geminiApiKey);
    case 'ollama':
      return new OllamaLLMClient(config.ollamaBaseUrl, config.ollamaNumCtx);
    default:
      return null;
  }
}
