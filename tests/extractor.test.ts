import assert from 'node:assert/strict';
import test from 'node:test';
import { compressMarkdownForQuery, htmlToCompactMarkdown } from '../src/server/search/extractor.js';

test('preserves pricing tables and extracts published/modified dates from HTML', () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>AcmeDB Pricing</title>
        <meta property="article:modified_time" content="2026-11-10T09:00:00Z" />
        <script type="application/ld+json">
          {"@type": "WebPage", "datePublished": "2026-01-15"}
        </script>
      </head>
      <body>
        <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
        <main>
          <h1>AcmeDB Plans & Pricing</h1>
          <p>Updated November 2026.</p>
          <table>
            <thead>
              <tr><th>Plan</th><th>Price</th><th>Storage</th></tr>
            </thead>
            <tbody>
              <tr><td>Free</td><td>$0/mo</td><td>1 GB</td></tr>
              <tr><td>Pro</td><td>$29/mo</td><td>50 GB</td></tr>
            </tbody>
          </table>
        </main>
        <footer>Copyright 2026 AcmeDB</footer>
      </body>
    </html>
  `;

  const extracted = htmlToCompactMarkdown(html, 'https://acmedb.dev/pricing', 'AcmeDB pricing');
  assert.equal(extracted.title, 'AcmeDB Pricing');
  assert.equal(extracted.modifiedDate, '2026-11-10');
  assert.equal(extracted.publishedDate, '2026-01-15');
  assert.match(extracted.markdown, /\| Plan \| Price \| Storage \|/);
  assert.match(extracted.markdown, /\| Pro \| \$29\/mo \| 50 GB \|/);
  assert.equal(extracted.markdown.includes('Copyright 2026 AcmeDB'), false);
});

test('query-aware compression keeps pricing table and release dates within budget', () => {
  const filler = Array.from({ length: 12 }, (_, i) => `Background paragraph ${i}: general marketing overview without numbers.`).join('\n\n');
  const doc = `# Overview\n\n${filler}\n\n## November 2026 Pricing Update\n\n| Plan | Cost |\n| --- | --- |\n| Pro | $35/mo |\n\nReleased new autoscaling on 2026-11-10.`;

  const compressed = compressMarkdownForQuery(doc, 'Pro plan pricing update 2026', 400);
  assert.ok(compressed.length <= 400);
  assert.match(compressed, /\$35\/mo/);
  assert.match(compressed, /2026-11-10/);
});
