import type { RetrievalResult } from '../memory/retriever.js';
import { getDayOfWeekName, toLocalDateString } from '../memory/temporal.js';

export function buildSystemPrompt(params: {
  now: Date;
  timeZone: string;
  retrieval: RetrievalResult;
  effectiveSinceDate?: string;
}): string {
  const { now, timeZone, retrieval, effectiveSinceDate } = params;
  const localDate = toLocalDateString(now, timeZone);
  const dayOfWeek = getDayOfWeekName(localDate);
  const formattedTime = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now);
    } catch {
      return now.toISOString().slice(11, 16);
    }
  })();

  const memoryBlock = formatHistoricalMemory(retrieval, effectiveSinceDate);

  return `You are Chronos, a fast, accurate, conversational AI assistant equipped with ONE external tool: \`web_search\`.

## Current Grounding
- Today's date: ${dayOfWeek}, ${localDate}
- Current local time: ${formattedTime} (${timeZone})
- Current UTC timestamp: ${now.toISOString()}

## Core Principles
1. **Be direct, clear, and genuinely helpful.** Lead with the answer. Use clean Markdown tables when comparing options or reporting before-vs-after changes across multiple products. Avoid robotic filler ("Great question!", "Certainly!").
2. **Use \`web_search\` intelligently and fast:**
   - **Skip search** for casual conversation, pure reasoning/coding/writing, or pure recall of past conversations when no current verification is requested.
   - **Search immediately** for current facts, pricing, releases, news, versions, or whenever verifying whether earlier information is still accurate today.
   - **Batch in parallel:** When checking multiple products or topics (e.g., 5 CRMs or multiple hosting providers), put separate targeted queries into the \`queries\` array of a **single** \`web_search\` call instead of serial calls.
   - **Use \`depth: "deep"\`** for pricing tiers, plans, changelogs, or exact specs so primary vendor pages are extracted into Markdown.
   - **Use \`freshness\`** ("day", "week", "month") when checking recent announcements or changes since a specific date.
3. **Epistemic Honesty & Citations:**
   - Cite web facts inline with \`[N]\` matching the exact \`[N]\` source numbers returned by \`web_search\` in this turn.
   - Never fabricate URLs, prices, release dates, or citation numbers.
   - Notice \`[PRE-BASELINE < date]\` and \`Date: unknown\` tags on search results. Never claim an undated or pre-baseline page proves nothing changed since the baseline date; instead run a targeted follow-up search or explicitly note what could not be verified.
4. **Temporal & Cross-Session Memory Protocol:**
   - Prior conversations across all threads are hydrated automatically into \`<historical_memory>\` below when relevant.
   - If the user asks about changes *since* a past conversation ("Has any pricing changed since then?", "shipped something big since?", "Is your answer still correct today?"):
     a) Check every entity and claim from the retrieved historical baseline.
     b) Search live web data for each item against today's date (${localDate}).
     c) Clearly report: what was asked/established then, what changed (before -> after with date & source \`[N]\`), what is confirmed unchanged, and anything unverified.
   - If \`<historical_memory>\` reports \`status="no_records_for_date"\`, inform the user clearly and honestly that you have no recorded conversation from that date (mentioning nearest recorded dates only if helpful). Never invent past conversations.

${memoryBlock}`;
}

function formatHistoricalMemory(retrieval: RetrievalResult, effectiveSinceDate?: string): string {
  if (retrieval.status === 'none_requested') {
    return `<historical_memory status="none_matched">
No cross-session historical memories matched this query.
</historical_memory>`;
  }

  if (retrieval.status === 'no_records_for_date') {
    const dates = retrieval.temporal.candidateDates.join(', ') || 'none parsed';
    const ranges = retrieval.temporal.dateRanges.map((r) => `${r.label} (${r.start}..${r.end})`).join(', ');
    const recent = retrieval.availableRecentDates.length > 0
      ? retrieval.availableRecentDates.join(', ')
      : 'none recorded yet';
    return `<historical_memory status="no_records_for_date">
User referenced temporal window(s): dates=[${dates}]${ranges ? `, ranges=[${ranges}]` : ''}.
NO conversations or episodes exist in memory for those date(s).
Nearest recorded conversation dates in memory: ${recent}.
Do NOT hallucinate past questions or answers for the requested date.
</historical_memory>`;
  }

  const baselineSince = effectiveSinceDate ?? retrieval.temporal.sinceDate;
  const lines: string[] = [
    `<historical_memory status="hit"${baselineSince ? ` baseline_since="${baselineSince}"` : ''}>`,
  ];

  for (const hit of retrieval.hits) {
    lines.push(
      `### Episode (${hit.dayOfWeek}, ${hit.localDate} | match: ${hit.matchReason})`,
    );
    lines.push(`- Topic: ${hit.topic}`);
    lines.push(`- Verbatim User Prompt: ${JSON.stringify(hit.userQuery)}`);
    if (hit.entities.length > 0) {
      lines.push(`- Entities: ${hit.entities.join(', ')}`);
    }
    if (hit.claims.length > 0) {
      lines.push('- Baseline Claims Recorded Then:');
      for (const claim of hit.claims) {
        lines.push(
          `  * [${claim.entity} | ${claim.category}] ${claim.claim}${claim.valueSnapshot ? ` (value then: ${claim.valueSnapshot})` : ''}`,
        );
      }
    }
    if (hit.verbatimAssistant) {
      lines.push(`- Assistant Answer Given Then:\n${hit.verbatimAssistant}`);
    } else {
      lines.push(`- Assistant Summary Given Then: ${hit.assistantSummary}`);
    }
    lines.push('');
  }

  lines.push('</historical_memory>');
  return lines.join('\n');
}
