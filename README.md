# Chronos — Web Search Chat Agent

A fast, grounded streaming chat agent in TypeScript/Node with **one tool (`web_search`)** and **bi-temporal cross-session episodic memory**.

See [DESIGN.md](./DESIGN.md) for the one-page architectural overview, trade-offs, and design rationale.

## Quick Start

```bash
npm install
cp .env.example .env
# Add at least one LLM key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY)
# and optionally a search key (TAVILY_API_KEY recommended; DuckDuckGo fallback works zero-key)
npm run dev
```

Open **http://localhost:3000**.

## Requirements

- **Node.js `>= 22.5.0`** (uses built-in `node:sqlite` + FTS5 with zero native compilation).

## Configuration (`.env.example`)

- **LLM Provider** (auto-detected, or pinned via `LLM_PROVIDER` / `LLM_MODEL`):
  - `OPENAI_API_KEY` (plus optional `OPENAI_BASE_URL` for OpenAI-compatible endpoints)
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`
  - Local **Ollama** (`OLLAMA_MODEL`, optional `OLLAMA_BASE_URL` / `OLLAMA_NUM_CTX` — no API key needed; use a tool-capable model such as `qwen3:8b`, `qwen2.5:7b`, or `llama3.1`)
- **Web Search Provider** (auto-detected):
  - `TAVILY_API_KEY` -> `EXA_API_KEY` -> `SERPER_API_KEY` -> `BRAVE_SEARCH_API_KEY` -> built-in DuckDuckGo + Readability fallback.

## Scripts

- `npm run dev` — Starts unified Express API + Vite React dev server on `http://localhost:3000`.
- `npm test` — Runs unit and end-to-end mocked orchestrator tests (`tsx --test`).
- `npm run typecheck` — Runs `tsc --noEmit`.
- `npm run build` — Builds production client (`dist/client`) and server (`dist/server`).
- `npm start` — Runs production server.
