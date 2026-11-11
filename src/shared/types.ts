export type Role = 'user' | 'assistant';

export type Freshness = 'day' | 'week' | 'month' | 'year' | 'all';
export type SearchDepth = 'fast' | 'deep';

export interface ExtractedClaim {
  entity: string;
  claim: string;
  category: 'pricing' | 'release' | 'fact' | 'recommendation' | 'other';
  valueSnapshot?: string;
  sourceUrls?: string[];
}

export interface Episode {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  localDate: string; // YYYY-MM-DD in user's local timezone at time of interaction
  dayOfWeek: string;
  topic: string;
  userQuery: string;
  assistantSummary: string;
  entities: string[];
  claims: ExtractedClaim[];
}

export interface SourceRef {
  index: number;
  url: string;
  title: string;
  domain: string;
  publishedDate?: string;
  snippet: string;
  isPrimarySource: boolean;
  authorityScore: number;
  fetchedFullContent?: boolean;
}

export interface MemoryHit {
  episodeId: string;
  conversationId: string;
  localDate: string;
  dayOfWeek: string;
  createdAt: string;
  topic: string;
  userQuery: string;
  assistantSummary: string;
  verbatimAssistant?: string;
  entities: string[];
  claims: ExtractedClaim[];
  matchReason: 'temporal' | 'keyword' | 'temporal+keyword';
  score: number;
}

export interface TemporalResolution {
  hasTemporalReference: boolean;
  expressions: string[];
  candidateDates: string[]; // YYYY-MM-DD ordered by confidence
  dateRanges: Array<{ start: string; end: string; label: string }>;
  sinceDate?: string; // Earliest baseline date for change/diff queries
  isAmbiguousWeekday: boolean;
}

export interface SearchRoundTrace {
  round: number;
  queries: Array<{
    query: string;
    freshness?: Freshness;
    includeDomains?: string[];
    purpose?: string;
  }>;
  depth: SearchDepth;
  resultCount: number;
  pagesFetched: number;
  cacheHits: number;
  durationMs: number;
}

export interface AgentTrace {
  provider: string;
  model: string;
  searchProvider: string;
  temporalResolution: TemporalResolution;
  memoryStatus: 'hit' | 'none_requested' | 'no_records_for_date';
  memoryHits: Array<{
    localDate: string;
    topic: string;
    matchReason: string;
    entitiesCount: number;
    claimsCount: number;
  }>;
  searchRounds: SearchRoundTrace[];
  totalDurationMs: number;
  firstTokenMs?: number;
}

export interface MessageMetadata {
  sources?: SourceRef[];
  trace?: AgentTrace;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  localDate: string;
  timezone: string;
  metadata?: MessageMetadata;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemStatus {
  ready: boolean;
  llmProvider: string | null;
  llmModel: string | null;
  searchProvider: string;
  issues: string[];
  conversationCount: number;
  episodeCount: number;
}

export type ChatSSEEvent =
  | { type: 'meta'; conversationId: string; userMessageId: string; assistantMessageId: string }
  | { type: 'status'; phase: 'hydrating_memory' | 'thinking' | 'searching' | 'reading_sources' | 'synthesizing'; label: string }
  | { type: 'memory'; status: AgentTrace['memoryStatus']; hits: AgentTrace['memoryHits']; temporal: TemporalResolution }
  | { type: 'tool_start'; round: number; queries: Array<{ query: string; purpose?: string; freshness?: Freshness }>; depth: SearchDepth }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; message: string };
