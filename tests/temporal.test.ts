import assert from 'node:assert/strict';
import test from 'node:test';
import {
  daysSinceDate,
  parseTemporalReferences,
  shiftDays,
  toLocalDateString,
} from '../src/server/memory/temporal.js';

test('resolves explicit dates and handles year wraparound', () => {
  const nov11 = new Date('2026-11-11T15:00:00Z');
  const res = parseTemporalReferences('What did I ask you on 3 November? Is your answer still correct today?', nov11, 'UTC');

  assert.equal(res.hasTemporalReference, true);
  assert.deepEqual(res.candidateDates, ['2026-11-03']);
  assert.equal(res.sinceDate, '2026-11-03');
  // Ensure "correct today?" did not inject 2026-11-11 into historical candidateDates
  assert.equal(res.candidateDates.includes('2026-11-11'), false);

  // If current date is Jan 5, 2027, "3 November" should resolve to 2026-11-03
  const jan5 = new Date('2027-01-05T12:00:00Z');
  const wrapped = parseTemporalReferences('Check what we discussed on November 3rd', jan5, 'UTC');
  assert.deepEqual(wrapped.candidateDates, ['2026-11-03']);
});

test('resolves "On Monday" and disambiguates "Last Tuesday"', () => {
  // 2026-11-11 is a Wednesday
  const wedNov11 = new Date('2026-11-11T15:00:00Z');

  const onMonday = parseTemporalReferences(
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
    wedNov11,
    'UTC',
  );
  assert.equal(onMonday.hasTemporalReference, true);
  assert.equal(onMonday.candidateDates[0], '2026-11-09');
  assert.equal(onMonday.isAmbiguousWeekday, false);

  const lastTuesday = parseTemporalReferences(
    'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    wedNov11,
    'UTC',
  );
  assert.equal(lastTuesday.hasTemporalReference, true);
  assert.equal(lastTuesday.isAmbiguousWeekday, true);
  // Previous week's Tuesday (Nov 3) and yesterday's Tuesday (Nov 10) both included
  assert.deepEqual(lastTuesday.candidateDates, ['2026-11-03', '2026-11-10']);
  assert.equal(lastTuesday.sinceDate, '2026-11-03');
});

test('handles timezone local date boundaries accurately', () => {
  // 2026-11-03 20:00 UTC is already 2026-11-04 01:30 in Asia/Kolkata (+05:30),
  // while still 2026-11-03 15:00 in America/New_York (-05:00).
  const utcInstant = new Date('2026-11-03T20:00:00Z');
  assert.equal(toLocalDateString(utcInstant, 'Asia/Kolkata'), '2026-11-04');
  assert.equal(toLocalDateString(utcInstant, 'America/New_York'), '2026-11-03');
  assert.equal(shiftDays('2026-11-01', -1), '2026-10-31');
  assert.equal(daysSinceDate('2026-11-03', new Date('2026-11-11T12:00:00Z'), 'UTC'), 8);
});

test('handles relative dates like yesterday and last week', () => {
  const wedNov11 = new Date('2026-11-11T15:00:00Z');
  const yest = parseTemporalReferences('What did we compare yesterday?', wedNov11, 'UTC');
  assert.deepEqual(yest.candidateDates, ['2026-11-10']);

  const lastWeek = parseTemporalReferences('Did anything ship since last week?', wedNov11, 'UTC');
  assert.equal(lastWeek.dateRanges.length, 1);
  assert.deepEqual(lastWeek.dateRanges[0], {
    start: '2026-11-02',
    end: '2026-11-08',
    label: 'last week',
  });
});
