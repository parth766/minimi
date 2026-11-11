const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
]);

const AGGREGATOR_DOMAINS = new Set([
  'g2.com', 'capterra.com', 'softwareadvice.com', 'getapp.com',
  'trustradius.com', 'sourceforge.net', 'alternativeto.net',
]);

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.hostname = host;
    let str = parsed.toString();
    if (str.endsWith('/') && parsed.pathname !== '/') {
      str = str.slice(0, -1);
    }
    return str;
  } catch {
    return rawUrl;
  }
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

export function scoreResultAuthority(params: {
  url: string;
  title: string;
  query: string;
  publishedDate?: string;
}): { authorityScore: number; isPrimarySource: boolean } {
  const domain = extractDomain(params.url);
  const pathLower = (() => {
    try {
      return new URL(params.url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();

  let score = 1.0;
  let isPrimarySource = false;

  // Check if domain base name appears in query (strong vendor/official signal)
  const domainRoot = domain.split('.')[0] ?? '';
  const queryLower = params.query.toLowerCase();
  if (domainRoot.length >= 3 && queryLower.includes(domainRoot)) {
    score += 1.5;
    isPrimarySource = true;
  }

  // Official pricing / changelog / docs / release paths
  if (/\/(pricing|plans|changelog|releases|release-notes|whats-new|docs)\b/i.test(pathLower) || domain.startsWith('docs.')) {
    score += 1.0;
    isPrimarySource = true;
  }

  if (domain === 'github.com' && /\/releases\b/i.test(pathLower)) {
    score += 1.2;
    isPrimarySource = true;
  }

  if (domain.endsWith('.gov') || domain.endsWith('.edu') || domain.endsWith('.org')) {
    score += 0.5;
  }

  if (AGGREGATOR_DOMAINS.has(domain)) {
    score -= 0.7;
  }

  if (params.publishedDate && /^\d{4}-\d{2}-\d{2}$/.test(params.publishedDate)) {
    score += 0.3;
  }

  return {
    authorityScore: Math.round(score * 100) / 100,
    isPrimarySource,
  };
}
