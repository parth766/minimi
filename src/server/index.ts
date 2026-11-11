import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.js';

async function start() {
  const { app, config } = createApp();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist/client');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(config.port, () => {
    const llmLabel = config.llmProvider
      ? config.llmProvider === 'ollama'
        ? `ollama (${config.llmModel} @ ${config.ollamaBaseUrl})`
        : `${config.llmProvider} (${config.llmModel})`
      : 'NOT CONFIGURED (set API key or OLLAMA_MODEL in .env)';
    console.log('');
    console.log(`  Chronos Search Agent running at http://localhost:${config.port}`);
    console.log(`  LLM:    ${llmLabel}`);
    console.log(`  Search: ${config.searchProvider}${config.searchProvider === 'duckduckgo' ? ' (zero-key fallback)' : ''}`);
    console.log(`  Memory: SQLite + FTS5 (${config.dbPath})`);
    console.log('');
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
