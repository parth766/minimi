import 'dotenv/config';
import path from 'node:path';

export type LLMProviderName = 'openai' | 'anthropic' | 'gemini' | 'ollama';
export type SearchProviderName = 'tavily' | 'exa' | 'serper' | 'brave' | 'duckduckgo';

export interface AppConfig {
  port: number;
  dbPath: string;
  llmProvider: LLMProviderName | null;
  llmModel: string | null;
  distillModel: string | null;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  ollamaBaseUrl: string;
  ollamaNumCtx: number;
  searchProvider: SearchProviderName;
  tavilyApiKey?: string;
  exaApiKey?: string;
  serperApiKey?: string;
  braveApiKey?: string;
}

const DEFAULT_MODELS: Record<LLMProviderName, { chat: string; distill: string }> = {
  openai: { chat: 'gpt-4.1', distill: 'gpt-4.1-mini' },
  anthropic: { chat: 'claude-sonnet-4-6', distill: 'claude-haiku-4-5' },
  gemini: { chat: 'gemini-2.5-flash', distill: 'gemini-2.5-flash' },
  ollama: { chat: 'llama3.1', distill: 'llama3.1' },
};

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function detectLLMProvider(env: NodeJS.ProcessEnv): LLMProviderName | null {
  const explicit = cleanEnv(env.LLM_PROVIDER)?.toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic' || explicit === 'gemini' || explicit === 'ollama') {
    return explicit;
  }
  if (cleanEnv(env.OPENAI_API_KEY)) return 'openai';
  if (cleanEnv(env.ANTHROPIC_API_KEY)) return 'anthropic';
  if (cleanEnv(env.GEMINI_API_KEY)) return 'gemini';
  if (cleanEnv(env.OLLAMA_MODEL) || cleanEnv(env.OLLAMA_BASE_URL)) return 'ollama';
  return null;
}

function detectSearchProvider(env: NodeJS.ProcessEnv): SearchProviderName {
  if (cleanEnv(env.TAVILY_API_KEY)) return 'tavily';
  if (cleanEnv(env.EXA_API_KEY)) return 'exa';
  if (cleanEnv(env.SERPER_API_KEY)) return 'serper';
  if (cleanEnv(env.BRAVE_SEARCH_API_KEY)) return 'brave';
  return 'duckduckgo';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(cleanEnv(env.PORT) ?? 3000);
  const dbPath = path.resolve(cleanEnv(env.DB_PATH) ?? './data/agent.db');
  const llmProvider = detectLLMProvider(env);
  const ollamaModel = cleanEnv(env.OLLAMA_MODEL);
  const modelOverride = cleanEnv(env.LLM_MODEL) ?? (llmProvider === 'ollama' ? ollamaModel : undefined);
  const distillOverride = cleanEnv(env.DISTILL_MODEL);

  const llmModel = llmProvider ? (modelOverride ?? DEFAULT_MODELS[llmProvider].chat) : null;
  const distillModel = llmProvider
    ? (distillOverride ?? (llmProvider === 'ollama' ? llmModel! : undefined) ?? DEFAULT_MODELS[llmProvider].distill)
    : null;

  const parsedNumCtx = Number(cleanEnv(env.OLLAMA_NUM_CTX) ?? 16384);

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    dbPath,
    llmProvider,
    llmModel,
    distillModel,
    openaiApiKey: cleanEnv(env.OPENAI_API_KEY),
    openaiBaseUrl: cleanEnv(env.OPENAI_BASE_URL),
    anthropicApiKey: cleanEnv(env.ANTHROPIC_API_KEY),
    geminiApiKey: cleanEnv(env.GEMINI_API_KEY),
    ollamaBaseUrl: cleanEnv(env.OLLAMA_BASE_URL) ?? 'http://localhost:11434',
    ollamaNumCtx: Number.isFinite(parsedNumCtx) && parsedNumCtx >= 2048 ? parsedNumCtx : 16384,
    searchProvider: detectSearchProvider(env),
    tavilyApiKey: cleanEnv(env.TAVILY_API_KEY),
    exaApiKey: cleanEnv(env.EXA_API_KEY),
    serperApiKey: cleanEnv(env.SERPER_API_KEY),
    braveApiKey: cleanEnv(env.BRAVE_SEARCH_API_KEY),
  };
}
