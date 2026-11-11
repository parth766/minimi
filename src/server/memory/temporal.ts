import type { TemporalResolution } from '../../shared/types.js';

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function toLocalDateString(date: Date, timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

export function getDayOfWeekNumber(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function getDayOfWeekName(dateStr: string): string {
  return DAY_NAMES[getDayOfWeekNumber(dateStr)] ?? 'Unknown';
}

export function shiftDays(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function resolveMonthDay(year: number | undefined, month: number, day: number, todayStr: string): string | null {
  const todayYear = Number(todayStr.slice(0, 4));
  let resolvedYear = year ?? todayYear;
  if (!isValidCalendarDate(resolvedYear, month, day)) return null;

  let candidate = formatDateParts(resolvedYear, month, day);
  if (year === undefined && candidate > todayStr) {
    resolvedYear -= 1;
    if (!isValidCalendarDate(resolvedYear, month, day)) return null;
    candidate = formatDateParts(resolvedYear, month, day);
  }
  return candidate;
}

export function parseTemporalReferences(
  text: string,
  now: Date = new Date(),
  timeZone = 'UTC',
): TemporalResolution {
  const todayStr = toLocalDateString(now, timeZone);
  const todayDow = getDayOfWeekNumber(todayStr);
  const currentWeekMonday = shiftDays(todayStr, -((todayDow + 6) % 7));

  const expressions: string[] = [];
  const candidateDates: string[] = [];
  const dateRanges: Array<{ start: string; end: string; label: string }> = [];
  let isAmbiguousWeekday = false;

  const addCandidate = (dateStr: string | null) => {
    if (dateStr && !candidateDates.includes(dateStr)) {
      candidateDates.push(dateStr);
    }
  };

  // 1. ISO explicit dates (YYYY-MM-DD)
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    const iso = m[1]!;
    const [yy, mm, dd] = iso.split('-').map(Number);
    if (yy && mm && dd && isValidCalendarDate(yy, mm, dd)) {
      expressions.push(m[0]);
      addCandidate(iso);
    }
  }

  // 2. Day + Month ("3 November", "3rd Nov 2026")
  const monthPattern = Object.keys(MONTHS).join('|');
  const dayFirstRe = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})(?:\\s*,?\\s*(\\d{4}))?\\b`,
    'gi',
  );
  for (const m of text.matchAll(dayFirstRe)) {
    const day = Number(m[1]);
    const month = MONTHS[m[2]!.toLowerCase()];
    const year = m[3] ? Number(m[3]) : undefined;
    if (month) {
      const resolved = resolveMonthDay(year, month, day, todayStr);
      if (resolved) {
        expressions.push(m[0]);
        addCandidate(resolved);
      }
    }
  }

  // 3. Month + Day ("November 3", "Nov 3rd, 2026")
  const monthFirstRe = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`,
    'gi',
  );
  for (const m of text.matchAll(monthFirstRe)) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : undefined;
    if (month) {
      const resolved = resolveMonthDay(year, month, day, todayStr);
      if (resolved) {
        expressions.push(m[0]);
        addCandidate(resolved);
      }
    }
  }

  // 4. Relative day expressions (avoid treating "still correct today?" as a historical lookup)
  if (/\byesterday\b/i.test(text)) {
    expressions.push('yesterday');
    addCandidate(shiftDays(todayStr, -1));
  }

  const historicalTodayRe = /\b(?:earlier\s+today|today\s+(?:i|we)\s+(?:asked|discussed|talked|shortlisted|mentioned|looked))\b/i;
  const historicalTodayMatch = text.match(historicalTodayRe);
  if (historicalTodayMatch) {
    expressions.push(historicalTodayMatch[0]);
    addCandidate(todayStr);
  }

  for (const m of text.matchAll(/\b(\d+)\s+days?\s+ago\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 3650) {
      expressions.push(m[0]);
      addCandidate(shiftDays(todayStr, -n));
    }
  }

  if (/\b(?:a\s+)?couple\s+(?:of\s+)?days?\s+ago\b/i.test(text)) {
    expressions.push('couple days ago');
    addCandidate(shiftDays(todayStr, -2));
    addCandidate(shiftDays(todayStr, -3));
  }

  if (/\ba\s+few\s+days?\s+ago\b/i.test(text)) {
    expressions.push('a few days ago');
    dateRanges.push({
      start: shiftDays(todayStr, -5),
      end: shiftDays(todayStr, -2),
      label: 'a few days ago',
    });
  }

  // 5. Weekdays ("On Monday", "Last Tuesday", "since Friday")
  const weekdayRe = /\b(?:(last|this|on|since|from)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
  for (const m of text.matchAll(weekdayRe)) {
    const modifier = m[1]?.toLowerCase();
    const dayName = m[2]!.toLowerCase();
    const targetDow = WEEKDAYS[dayName];
    if (targetDow === undefined) continue;

    expressions.push(m[0]);
    let diff = (todayDow - targetDow + 7) % 7;
    if (diff === 0) diff = 7; // Assume past occurrence rather than today unless "today" specified
    const mostRecentPast = shiftDays(todayStr, -diff);
    const weekPrior = shiftDays(mostRecentPast, -7);

    if (modifier === 'last' && mostRecentPast >= currentWeekMonday) {
      // English ambiguity: e.g. on Wed Nov 11, "last Tuesday" means Nov 3 (prev week) OR Nov 10 (yesterday)
      isAmbiguousWeekday = true;
      addCandidate(weekPrior);
      addCandidate(mostRecentPast);
    } else {
      addCandidate(mostRecentPast);
      if (modifier === 'last' || !modifier) {
        addCandidate(weekPrior);
      }
    }
  }

  // 6. Week / Month windows
  if (/\blast\s+week\b/i.test(text)) {
    expressions.push('last week');
    const prevWeekMon = shiftDays(currentWeekMonday, -7);
    const prevWeekSun = shiftDays(currentWeekMonday, -1);
    dateRanges.push({ start: prevWeekMon, end: prevWeekSun, label: 'last week' });
  }

  if (/\bthis\s+week\b/i.test(text)) {
    expressions.push('this week');
    dateRanges.push({ start: currentWeekMonday, end: todayStr, label: 'this week' });
  }

  for (const m of text.matchAll(/\b(\d+)\s+weeks?\s+ago\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 104) {
      expressions.push(m[0]);
      dateRanges.push({
        start: shiftDays(todayStr, -7 * n - 3),
        end: shiftDays(todayStr, -7 * n + 3),
        label: m[0],
      });
    }
  }

  if (/\blast\s+month\b/i.test(text)) {
    expressions.push('last month');
    const [yy, mm] = todayStr.split('-').map(Number);
    const prevMonthYear = mm === 1 ? yy! - 1 : yy!;
    const prevMonth = mm === 1 ? 12 : mm! - 1;
    const lastDay = new Date(Date.UTC(prevMonthYear, prevMonth, 0)).getUTCDate();
    dateRanges.push({
      start: formatDateParts(prevMonthYear, prevMonth, 1),
      end: formatDateParts(prevMonthYear, prevMonth, lastDay),
      label: 'last month',
    });
  }

  const allStarts = [
    ...candidateDates,
    ...dateRanges.map((r) => r.start),
  ].sort();

  return {
    hasTemporalReference: expressions.length > 0,
    expressions,
    candidateDates,
    dateRanges,
    sinceDate: allStarts[0],
    isAmbiguousWeekday,
  };
}

/**
 * Computes approximate number of days since a YYYY-MM-DD baseline date relative to `now`.
 */
export function daysSinceDate(baselineDateStr: string, now: Date = new Date(), timeZone = 'UTC'): number {
  const todayStr = toLocalDateString(now, timeZone);
  const [by, bm, bd] = baselineDateStr.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const baseMs = Date.UTC(by!, bm! - 1, bd!);
  const todayMs = Date.UTC(ty!, tm! - 1, td!);
  return Math.max(0, Math.round((todayMs - baseMs) / 86_400_000));
}
