# DESIGN.md — Chronos Web Search Chat Agent

## 1. How It Works

Chronos is a streaming TypeScript/Node chat agent with **one tool (`web_search`)** and an out-of-band **bi-temporal episodic memory layer** stored in SQLite (`node:sqlite` + FTS5).

```
User Turn (+ timezone)
   │
   ▼
[1. Pre-flight Hydration (<10ms, 0 LLM calls)]
   ├─ Deterministic Temporal Parser ("On Monday", "3 Nov", "Last Tuesday")
   └─ Hybrid Retrieval: SQLite date/range lookup + FTS5 BM25 over Episodes & Claims
   │
   ▼
[2. Grounded Streaming Agent Loop (max 4 rounds)]
   ├─ System prompt injects current time + <historical_memory> (or negative evidence)
   ├─ Model streams directly OR calls single tool: web_search({ queries[], depth })
   └─ web_search runs up to 6 queries in parallel -> canonical URL dedup ->
      TTL cache -> parallel HTML-to-Markdown extraction (preserving pricing tables) ->
      authority & pre-baseline staleness tagging -> inline [N] citations
   │
   ▼
[3. Post-Turn Persistence]
   ├─ Persist message + verified SourceRef[] + AgentTrace to SQLite
   ├─ Sync (<1ms) heuristic Episode + Claim Ledger insert (zero race window)
   └─ Async background LLM distillation refines atomic claims for future diffs
```

## 2. Why I Built It This Way

1. **Deterministic Memory Hydration Outside the Tool Boundary:** The specification limits the agent to one tool (`web_search`). Rather than burning an extra LLM round-trip on a `memory_search` tool (or risking tool-budget confusion), temporal parsing and cross-session retrieval execute deterministically in `<10ms` before the first model call.
2. **Temporal + Claim-Ledger Memory Over Raw Chat Logs:** Evaluation prompts like *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"* fail in standard chat apps for two reasons: threads are isolated, and English weekday phrasing is ambiguous (e.g., on Wednesday Nov 11, *"last Tuesday"* can mean Nov 3 or Nov 10). Our parser emits candidate dates ordered with FTS5 keyword overlap to disambiguate, and our **Claim Ledger** pairs verbatim prior turns with baseline `claims` (`entity`, `valueSnapshot`, `localDate`) so the agent can diff *then vs. now* cleanly.
3. **Single-Round Parallel Fan-Out in `web_search`:** Checking 5 shortlisted CRMs serially takes 5 LLM turns (~10–15s). Designing `web_search` to accept `queries[]` lets the model fan out all 5 pricing/changelog checks concurrently in **one** round-trip, deduplicate canonical URLs, and guarantee per-query source coverage.
4. **Pricing-Aware Content Extraction:** Standard SERP snippets truncate pricing tiers, and Mozilla Readability strips SaaS pricing grids because they have high link density and short cells. Our extractor runs Readability on prose articles, switches to a semantic DOM-to-Markdown cleaner (`linkedom`) for pricing/changelog URLs to preserve Markdown `<table>`s, extracts JSON-LD/OpenGraph dates, and compresses passages by query + currency/date density.
5. **No Agent Framework:** Writing the ~240-line orchestrator and unified OpenAI/Anthropic/Gemini/Ollama streaming adapters directly eliminates framework bloat, keeps control flow transparent, and gives full control over TTFT, SSE streaming, and `[PRE-BASELINE]` staleness warnings.

## 3. What I Considered and Rejected

- **Exposing a `memory_search` / `read_url` tool alongside `web_search`:** Rejected to honor the single-tool constraint strictly and avoid serial tool-call latency. Page reading is folded transparently into `web_search(depth: "deep")`, and memory retrieval happens automatically in the harness.
- **Pure Vector RAG for Conversation History:** Rejected as the primary retriever. Vector embeddings do poorly on exact temporal anchors (*"3 November"*, *"On Monday"*) and silently drop negative evidence. SQLite calendar indexing + FTS5 BM25 is faster, deterministic, and explicitly surfaces `no_records_for_date` when nothing happened on a requested date so the model won't hallucinate.
- **Headless Browser (Playwright/Puppeteer) for Extraction:** Rejected for the hot path. Booting Chromium adds seconds of latency and heavy install/runtime footprint (`npm install && npm run dev`). Fast HTTP `fetch` with strict 3.8s per-URL timeouts + `linkedom` covers ~90% of vendor pricing/changelog pages in a fraction of a second.
- **Native-Compiled `better-sqlite3`:** Rejected in favor of Node's built-in `node:sqlite` (`DatabaseSync` with FTS5) to eliminate C++ toolchain build failures across Windows/macOS/Linux during `npm install`.

## 4. What I'd Do With Another Week

1. **Selective Browser Rendering Fallback:** Add an optional headless-browser pool solely for JS-hydrated pricing calculators when static HTML yields `<200` chars of useful text.
2. **Hybrid Semantic + Lexical Recall:** Add lightweight local/API embeddings alongside FTS5 so zero-date, heavily paraphrased cross-session callbacks (*"those backend tools we liked"* → *"Postgres hosting"*) recall reliably.
3. **Automated Multi-Day Replay Benchmark:** Expand the test suite with a live-model eval runner scoring citation precision, temporal diff recall, and latency p50/p95 across 30+ multi-session scenarios.
4. **In-Turn Claim Verification Guardrail:** Add a fast post-draft consistency pass verifying every cited `[N]` and price assertion directly against fetched source text before closing the stream.
