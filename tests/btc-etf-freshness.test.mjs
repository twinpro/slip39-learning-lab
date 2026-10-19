import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEtfFreshness, computeSourceHealth, validateSnapshot, CORE_VENUES } from '../scripts/btc-lib.mjs';
import { buildEtfSnapshot, reusablePreviousEtf } from '../scripts/btc-etf-lib.mjs';
import { preserveVerifiedReadings } from '../scripts/btc-publication-lib.mjs';

const day = 86400000;
const assess = (latest, now) => assessEtfFreshness(Date.parse(`${latest}T00:00:00Z`), Date.parse(now));

// Explicit UTC instants exercise the production America/New_York conversion.
const cases = [
  ['Thursday before cutoff', '2026-10-14', '2026-10-15T23:59:59Z', '2026-10-14', 0],
  ['Thursday at cutoff', '2026-10-14', '2026-10-16T00:00:00Z', '2026-10-15', 1],
  ['Friday morning keeps Thursday due', '2026-10-14', '2026-10-16T13:00:00Z', '2026-10-15', 1],
  ['Friday before cutoff', '2026-10-15', '2026-10-16T23:59:59Z', '2026-10-15', 0],
  ['Friday at cutoff', '2026-10-15', '2026-10-17T00:00:00Z', '2026-10-16', 1],
  ['Saturday midnight ET keeps Friday due', '2026-10-15', '2026-10-17T04:00:00Z', '2026-10-16', 1],
  ['Saturday noon keeps Friday due', '2026-10-15', '2026-10-17T16:00:00Z', '2026-10-16', 1],
  ['Sunday noon keeps Friday due', '2026-10-15', '2026-10-18T16:00:00Z', '2026-10-16', 1],
  ['Sunday evening keeps Friday due', '2026-10-15', '2026-10-19T01:00:00Z', '2026-10-16', 1],
  ['Monday morning keeps Friday due', '2026-10-15', '2026-10-19T13:00:00Z', '2026-10-16', 1],
  ['Monday at market close', '2026-10-15', '2026-10-19T20:00:00Z', '2026-10-16', 1],
  ['Monday before reporting cutoff', '2026-10-15', '2026-10-19T23:59:59Z', '2026-10-16', 1],
  ['Monday at reporting cutoff', '2026-10-15', '2026-10-20T00:00:00Z', '2026-10-19', 2],
  ['Tuesday cutoff exceeds existing lag allowance', '2026-10-15', '2026-10-21T00:00:00Z', '2026-10-20', 3],
  ['Labor Day morning keeps Friday due', '2026-09-03', '2026-09-07T13:00:00Z', '2026-09-04', 1],
  ['Labor Day evening keeps Friday due', '2026-09-03', '2026-09-08T01:00:00Z', '2026-09-04', 1],
  ['Tuesday after Labor Day before cutoff', '2026-09-03', '2026-09-08T23:59:59Z', '2026-09-04', 1],
  ['Tuesday after Labor Day at cutoff', '2026-09-03', '2026-09-09T00:00:00Z', '2026-09-08', 2],
  ['Good Friday has no report', '2026-04-01', '2026-04-04T01:00:00Z', '2026-04-02', 1],
  ['observed Independence Day has no report', '2026-07-01', '2026-07-04T01:00:00Z', '2026-07-02', 1],
  ['Thanksgiving morning keeps Wednesday due', '2026-11-24', '2026-11-26T15:00:00Z', '2026-11-25', 1],
  ['early-close Friday still uses 20 ET reporting cutoff', '2026-11-25', '2026-11-27T23:00:00Z', '2026-11-25', 0],
  ['early-close Friday report becomes due', '2026-11-25', '2026-11-28T01:00:00Z', '2026-11-27', 1],
  ['Christmas Eve early close before cutoff', '2026-12-23', '2026-12-24T23:00:00Z', '2026-12-23', 0],
  ['Christmas morning keeps Christmas Eve due', '2026-12-23', '2026-12-25T15:00:00Z', '2026-12-24', 1],
  ['Columbus Day is an equity session', '2026-10-09', '2026-10-13T00:00:00Z', '2026-10-12', 1],
  ['Veterans Day is an equity session', '2026-11-10', '2026-11-12T01:00:00Z', '2026-11-11', 1],
  ['January 9 2025 extraordinary market closure', '2025-01-08', '2025-01-10T02:00:00Z', '2025-01-08', 0],
  ['January 9 closure is excluded from lag count', '2025-01-08', '2025-01-11T02:00:00Z', '2025-01-10', 1],
  ['Saturday New Year does not close preceding Friday', '2027-12-30', '2028-01-01T01:00:00Z', '2027-12-31', 1],
  ['Sunday New Year is observed on Monday', '2022-12-29', '2023-01-03T02:00:00Z', '2022-12-30', 1],
  ['spring DST before jump', '2026-03-05', '2026-03-08T06:59:59Z', '2026-03-06', 1],
  ['spring DST after jump', '2026-03-05', '2026-03-08T07:00:00Z', '2026-03-06', 1],
  ['summer cutoff is 00 UTC', '2026-03-06', '2026-03-10T00:00:00Z', '2026-03-09', 1],
  ['fall DST before repeated hour', '2026-10-29', '2026-11-01T05:59:59Z', '2026-10-30', 1],
  ['fall DST after repeated hour', '2026-10-29', '2026-11-01T06:00:00Z', '2026-10-30', 1],
  ['winter before cutoff at 01 UTC', '2026-10-30', '2026-11-03T00:59:59Z', '2026-10-30', 0],
  ['winter cutoff at 01 UTC', '2026-10-30', '2026-11-03T01:00:00Z', '2026-11-02', 1],
];
for (const [name, latest, now, expected, behind] of cases) {
  test(`ETF freshness: ${name}`, () => {
    const actual = assess(latest, now);
    assert.equal(actual.expectedLatestSession, expected);
    assert.equal(actual.sessionsBehind, behind);
    assert.equal(actual.status, behind > 2 ? 'stale' : behind ? 'reporting_lag' : 'fresh');
  });
}

test('fixed ETF data never becomes fresher as time advances across weekends, holidays and DST', () => {
  const severity = { fresh: 0, reporting_lag: 1, stale: 2 };
  for (const latest of ['2026-10-15', '2026-09-03', '2026-03-05', '2026-10-29', '2026-12-23', '2025-01-08']) {
    let previous;
    const start = Date.parse(`${latest}T21:00:00Z`);
    for (let now = start; now <= start + 10 * day; now += 15 * 60000) {
      const result = assessEtfFreshness(Date.parse(`${latest}T00:00:00Z`), now);
      if (previous) {
        const label = `${latest} at ${new Date(now).toISOString()}`;
        assert.ok(result.expectedLatestSession >= previous.expectedLatestSession, label);
        assert.ok(result.sessionsBehind >= previous.sessionsBehind, label);
        assert.ok(severity[result.status] >= severity[previous.status], label);
        assert.ok(result.ageDays >= previous.ageDays, label);
      }
      previous = result;
    }
  }
});

const dates = ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
const rows = dates.map(date => ({ timestamp: Date.parse(`${date}T00:00:00Z`), flow_usd: 100000000 }));
const build = (data, now) => buildEtfSnapshot(data, { source: 'SoSoValue official API v2', fetchedAt: now, nowMs: Date.parse(now) });
function snapshot(etf, generated_at) {
  const result = { schema: 12, generated_at, sources: {}, etf, spot: {status: 'unavailable'},
    derivatives: {venues: {}, aggregate: {status: 'unavailable', core_expected_venues: [...CORE_VENUES]}},
    exchange_supply: {score: null} };
  result.health = computeSourceHealth(result);
  assert.equal(validateSnapshot(result).ok, true, JSON.stringify(validateSnapshot(result)));
  return result;
}

test('refetching or correcting historical flows cannot reset a missing Friday report', () => {
  const before = build(rows, '2026-10-17T01:00:00Z');
  const corrected = structuredClone(rows);
  corrected[0].flow_usd += 2000000;
  for (const data of [rows, corrected]) {
    const after = build(data, '2026-10-19T16:00:00Z');
    assert.equal(after.latest_date, '2026-10-15');
    assert.equal(after.freshness_status, 'reporting_lag');
    assert.equal(after.expected_latest_session, before.expected_latest_session);
    assert.equal(after.sessions_behind, before.sessions_behind);
  }
  assert.equal(rows[0].flow_usd, 100000000, 'historical input was not mutated');
});

test('verified delayed Friday publication restores freshness, then Monday cutoff ages it again', () => {
  const friday = [...rows, {timestamp: Date.parse('2026-10-16T00:00:00Z'), flow_usd: 0}];
  const recovered = build(friday, '2026-10-19T16:00:00Z');
  assert.equal(recovered.freshness_status, 'fresh');
  assert.equal(recovered.flow_5d_usd, 400000000, 'genuine zero remains in the same five-session sum');
  assert.equal(build(friday, '2026-10-20T00:00:00Z').freshness_status, 'reporting_lag');
});

test('preservation retains original verified values and timestamps while reporting missing Friday', () => {
  const when = '2026-10-16T01:00:00Z';
  const previous = snapshot(build(rows, when), when);
  const original = structuredClone(previous);
  for (const now of ['2026-10-17T16:00:00Z', '2026-10-18T16:00:00Z', '2026-10-19T16:00:00Z']) {
    const retained = reusablePreviousEtf(previous, Date.parse(now), now);
    assert.ok(retained);
    assert.equal(retained.freshness_status, 'reporting_lag');
    assert.equal(retained.expected_latest_session, '2026-10-16');
    assert.equal(retained.fetched_at, when);
    assert.equal(retained.flow_5d_usd, previous.etf.flow_5d_usd);
    const candidate = snapshot(retained, now);
    assert.equal(candidate.health.sections.etf.quality, 'partial');
  }
  assert.deepEqual(previous, original);
  const staleAt = '2026-10-21T01:00:00Z';
  assert.equal(reusablePreviousEtf(previous, Date.parse(staleAt), staleAt), null);
  const next = { ...structuredClone(previous), generated_at: staleAt, etf: {status: 'unavailable'} };
  next.health = computeSourceHealth(next);
  preserveVerifiedReadings(next, previous);
  assert.equal(next.etf.status, 'unavailable');
  assert.equal(next.health.sections.etf.quality, 'unknown');
  assert.deepEqual(next.etf.last_verified.value, previous.etf);
  assert.equal(next.etf.last_verified.observed_at, when);
});

test('absolute age limit and invalid input guards remain in force', () => {
  assert.equal(assess('2026-10-15', '2026-10-22T00:00:01Z').reason, 'absolute_age');
  assert.equal(assess('2026-10-20', '2026-10-19T16:00:00Z').status, 'invalid');
  assert.equal(assessEtfFreshness(NaN, Date.now()).status, 'invalid');
});
