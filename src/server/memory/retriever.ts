import type { Episode, MemoryHit, TemporalResolution } from '../../shared/types.js';
import { MemoryStore } from './store.js';
import { parseTemporalReferences } from './temporal.js';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their', 'it', 'its',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how',
  'on', 'in', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'of', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'can', 'just', 'now', 'since', 'still', 'today', 'yesterday',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'last', 'week', 'month', 'day', 'days', 'ago', 'ask', 'asked', 'tell', 'told',
  'answer', 'correct', 'right', 'true', 'changed', 'change', 'anything', 'something',
  'big', 'new', 'update', 'updated', 'remember', 'earlier',
]);

export interface RetrievalResult {
  temporal: TemporalResolution;
  status: 'hit' | 'none_requested' | 'no_records_for_date';
  hits: MemoryHit[];
  availableRecentDates: string[];
}

export function extractTopicKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 12);
}

function buildFtsQuery(keywords: string[]): string {
  if (keywords.length === 0) return '';
  return keywords
    .map((kw) => kw.replace(/["'*:-]/g, ''))
    .filter((kw) => kw.length >= 2)
    .map((kw) => `"${kw}"*`)
    .join(' OR ');
}

function computeKeywordOverlap(episode: Episode, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = [
    episode.topic,
    episode.userQuery,
    episode.assistantSummary,
    episode.entities.join(' '),
    episode.claims.map((c) => `${c.entity} ${c.claim} ${c.valueSnapshot ?? ''}`).join(' '),
  ]
    .join(' ')
    .toLowerCase();

  let matched = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw)) matched += 1;
  }
  return matched / keywords.length;
}

export function retrieveMemory(params: {
  store: MemoryStore;
  query: string;
  now?: Date;
  timeZone?: string;
  excludeAssistantMessageIds?: Set<string>;
  maxHits?: number;
}): RetrievalResult {
  const {
    store,
    query,
    now = new Date(),
    timeZone = 'UTC',
    excludeAssistantMessageIds = new Set<string>(),
    maxHits = 6,
  } = params;

  const temporal = parseTemporalReferences(query, now, timeZone);
  const keywords = extractTopicKeywords(query);

  const scored = new Map<string, { episode: Episode; score: number; reason: MemoryHit['matchReason'] }>();

  // 1. Temporal retrieval (handles exact dates, relative offsets, ambiguous weekdays, ranges)
  if (temporal.hasTemporalReference) {
    const dateMatchedEpisodes: Array<{ episode: Episode; dateIndex: number }> = [];

    if (temporal.candidateDates.length > 0) {
      const eps = store.getEpisodesByDates(temporal.candidateDates);
      for (const ep of eps) {
        const idx = temporal.candidateDates.indexOf(ep.localDate);
        dateMatchedEpisodes.push({ episode: ep, dateIndex: idx >= 0 ? idx : 99 });
      }
    }

    for (const range of temporal.dateRanges) {
      const eps = store.getEpisodesByDateRange(range.start, range.end);
      for (const ep of eps) {
        if (!dateMatchedEpisodes.some((x) => x.episode.id === ep.id)) {
          dateMatchedEpisodes.push({ episode: ep, dateIndex: 1 });
        }
      }
    }

    for (const { episode, dateIndex } of dateMatchedEpisodes) {
      // Allow recalling earlier turns in the same thread if explicitly requested by date,
      // but still prefer matches outside the immediate active window unless no others exist.
      const overlap = computeKeywordOverlap(episode, keywords);
      const datePriorityBonus = dateIndex === 0 ? 1.5 : 1.0;
      const keywordBonus = overlap * 4.0;
      const inCurrentWindowPenalty = excludeAssistantMessageIds.has(episode.assistantMessageId) ? -0.3 : 0;
      const totalScore = datePriorityBonus + keywordBonus + inCurrentWindowPenalty;

      scored.set(episode.id, {
        episode,
        score: totalScore,
        reason: overlap > 0 ? 'temporal+keyword' : 'temporal',
      });
    }

    if (scored.size === 0) {
      return {
        temporal,
        status: 'no_records_for_date',
        hits: [],
        availableRecentDates: store.getRecentEpisodeDates(5),
      };
    }
  }

  // 2. FTS5 Cross-Session Keyword Recall (always runs if keywords exist, supplements temporal or catches un-dated callbacks)
  const ftsQuery = buildFtsQuery(keywords);
  if (ftsQuery) {
    try {
      const ftsMatches = store.searchEpisodesFts(ftsQuery, 10);
      for (const { episode } of ftsMatches) {
        if (excludeAssistantMessageIds.has(episode.assistantMessageId) && !temporal.hasTemporalReference) {
          continue;
        }
        const overlap = computeKeywordOverlap(episode, keywords);
        // Require meaningful keyword match for un-dated cross-session injection to prevent irrelevant chatter
        if (!temporal.hasTemporalReference && overlap < 0.25 && keywords.length >= 2) {
          continue;
        }
        const existing = scored.get(episode.id);
        if (existing) {
          existing.score += overlap * 2.0;
          existing.reason = 'temporal+keyword';
        } else if (!temporal.hasTemporalReference || overlap >= 0.5) {
          scored.set(episode.id, {
            episode,
            score: overlap * 3.0,
            reason: 'keyword',
          });
        }
      }
    } catch {
      // Ignore malformed FTS syntax edge cases gracefully
    }
  }

  if (scored.size === 0) {
    return {
      temporal,
      status: 'none_requested',
      hits: [],
      availableRecentDates: [],
    };
  }

  const ranked = Array.from(scored.values())
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.15) return b.score - a.score;
      return a.episode.createdAt.localeCompare(b.episode.createdAt);
    })
    .slice(0, maxHits);

  const hits: MemoryHit[] = ranked.map(({ episode, score, reason }) => {
    const assistantMsg = store.getMessageById(episode.assistantMessageId);
    const verbatimAssistant = assistantMsg
      ? assistantMsg.content.slice(0, 2600)
      : undefined;

    return {
      episodeId: episode.id,
      conversationId: episode.conversationId,
      localDate: episode.localDate,
      dayOfWeek: episode.dayOfWeek,
      createdAt: episode.createdAt,
      topic: episode.topic,
      userQuery: episode.userQuery,
      assistantSummary: episode.assistantSummary,
      verbatimAssistant,
      entities: episode.entities,
      claims: episode.claims,
      matchReason: reason,
      score,
    };
  });

  return {
    temporal,
    status: 'hit',
    hits,
    availableRecentDates: [],
  };
}
