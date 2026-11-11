import { z } from 'zod';
import type { ExtractedClaim, SourceRef } from '../../shared/types.js';
import type { LLMClient } from '../llm/types.js';
import { MemoryStore } from './store.js';

const DistillSchema = z.object({
  topic: z.string().min(1).max(160),
  assistantSummary: z.string().min(1).max(800),
  entities: z.array(z.string()).max(20),
  claims: z
    .array(
      z.object({
        entity: z.string().min(1),
        claim: z.string().min(1),
        category: z.enum(['pricing', 'release', 'fact', 'recommendation', 'other']),
        valueSnapshot: z.string().optional(),
      }),
    )
    .max(25),
});

export function distillEpisodeHeuristic(params: {
  userQuery: string;
  assistantContent: string;
  sources?: SourceRef[];
}): {
  topic: string;
  assistantSummary: string;
  entities: string[];
  claims: ExtractedClaim[];
} {
  const { userQuery, assistantContent, sources = [] } = params;
  const sourceUrls = sources.slice(0, 5).map((s) => s.url);

  const topic = userQuery
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const assistantSummary = assistantContent
    .replace(/\[(\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 480);

  const entitySet = new Set<string>();

  // Extract bolded names (**HubSpot**, **Supabase**, etc.) and numbered headings
  for (const m of assistantContent.matchAll(/\*\*([A-Z][\w.+-]{1,35}(?:\s+[A-Z][\w.+-]{1,25}){0,2})\*\*/g)) {
    const candidate = m[1]!.trim();
    if (!/^(Note|Summary|Bottom Line|Key|Price|Pricing|Plan|Result|Answer|Changes|Updated)$/i.test(candidate)) {
      entitySet.add(candidate);
    }
  }

  // Extract first-column Markdown table items (very common in tool comparisons!)
  for (const line of assistantContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && !trimmed.startsWith('| ---') && !trimmed.startsWith('|--')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      const firstCell = cells[0]?.replace(/\*\*/g, '').trim();
      if (
        firstCell &&
        firstCell.length >= 2 &&
        firstCell.length <= 40 &&
        !/^(Tool|Provider|CRM|Platform|Plan|Tier|Feature|Price|Name|Option|Service|Vendor|Item)$/i.test(firstCell) &&
        !/^[-:]+$/.test(firstCell)
      ) {
        entitySet.add(firstCell);
      }
    }
  }

  const entities = Array.from(entitySet).slice(0, 15);
  const claims: ExtractedClaim[] = [];

  // Extract pricing or factual bullet/table lines
  for (const line of assistantContent.split('\n')) {
    const cleaned = line.replace(/\*\*/g, '').replace(/\[(\d+)\]/g, '').trim();
    if (!cleaned || cleaned.length < 15) continue;

    const hasPricing = /(\$\d+|\€\d+|£\d+|free tier|per user|per seat|\/mo|\/month|pricing)/i.test(cleaned);
    const hasRelease = /(released|launched|shipped|version|v\d+\.\d+|announced|update)/i.test(cleaned);

    if (hasPricing || hasRelease) {
      const matchedEntity = entities.find((e) => cleaned.toLowerCase().includes(e.toLowerCase())) ?? entities[0] ?? 'General';
      const priceMatch = cleaned.match(/(?:\$|€|£)\s*\d+(?:[.,]\d+)?(?:\s*\/\s*(?:user|seat|mo|month|year))?/i);
      claims.push({
        entity: matchedEntity,
        claim: cleaned.slice(0, 220),
        category: hasPricing ? 'pricing' : 'release',
        valueSnapshot: priceMatch?.[0],
        sourceUrls: sourceUrls.length > 0 ? sourceUrls : undefined,
      });
    }
    if (claims.length >= 12) break;
  }

  return { topic, assistantSummary, entities, claims };
}

export async function distillEpisodeAsync(params: {
  store: MemoryStore;
  llm: LLMClient;
  model: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  localDate: string;
  userQuery: string;
  assistantContent: string;
  sources?: SourceRef[];
}): Promise<void> {
  try {
    const prompt = `Extract a structured episodic memory record from this conversation turn on ${params.localDate}.
Return STRICT JSON matching:
{
  "topic": "short 5-12 word description of what was asked/decided",
  "assistantSummary": "concise 2-3 sentence summary of the answer/recommendations",
  "entities": ["Exact product, company, tool, or concept names discussed"],
  "claims": [
    {
      "entity": "Entity name",
      "claim": "Specific atomic assertion made in the assistant answer (prices, tiers, versions, dates, recommendations)",
      "category": "pricing" | "release" | "fact" | "recommendation" | "other",
      "valueSnapshot": "exact number/price/version if applicable"
    }
  ]
}

User (${params.localDate}):
${params.userQuery.slice(0, 1500)}

Assistant:
${params.assistantContent.slice(0, 3500)}`;

    const rawText = await params.llm.completeText({
      model: params.model,
      system: 'You extract concise, factual JSON memory records from chat turns. Output valid JSON only, no markdown fences.',
      prompt,
      maxTokens: 700,
    });

    const jsonText = rawText
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');

    const parsed = DistillSchema.safeParse(JSON.parse(jsonText));
    if (!parsed.success) return;

    const sourceUrls = params.sources?.slice(0, 5).map((s) => s.url);
    params.store.upsertEpisode({
      conversationId: params.conversationId,
      userMessageId: params.userMessageId,
      assistantMessageId: params.assistantMessageId,
      createdAt: params.createdAt,
      localDate: params.localDate,
      topic: parsed.data.topic,
      userQuery: params.userQuery,
      assistantSummary: parsed.data.assistantSummary,
      entities: parsed.data.entities,
      claims: parsed.data.claims.map((c) => ({
        ...c,
        sourceUrls: sourceUrls && sourceUrls.length > 0 ? sourceUrls : undefined,
      })),
    });
  } catch {
    // Non-critical background enrichment: heuristic episode is already persisted synchronously.
  }
}
