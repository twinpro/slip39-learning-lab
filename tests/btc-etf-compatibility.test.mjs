import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {historicalEtfReading, validateEtfReading, validateSnapshot, computeSourceHealth, assessEtfFreshness} from '../scripts/btc-lib.mjs';
import {buildEtfSnapshot, reusablePreviousEtf} from '../scripts/btc-etf-lib.mjs';
import {preserveVerifiedReadings, assessPublication} from '../scripts/btc-publication-lib.mjs';
import * as time from '../assets/js/btc-dashboard-time.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const page = fs.readFileSync(path.join(root, 'pages/btc-real-vs-paper-v11b.html'), 'utf8');
const helpers = page.slice(page.indexOf('const A ='), page.indexOf('function updateHeaderPriceState'));
const render = page.slice(page.indexOf('function renderSnapshot(){'), page.indexOf('function drawGauge('));
function displayed(snapshot) {
  let model; const nodes = {};
  const context = vm.createContext({...time, performance: {now: () => 0},
    document: {getElementById: id => nodes[id] ||= {style: {}, classList: {toggle(){}}}},
    esc: String, syncMobileSnapshot: value => model = value, drawGauge(){}, fixtureSnapshot: snapshot,
    fixtureNow: Date.parse(snapshot.generated_at)});
  vm.runInContext(helpers + render + '\nS.snapshot=fixtureSnapshot;S.healthStatus=null;setTrustedClock(fixtureNow,"test");renderSnapshot();', context);
  return {model, nodes};
}
const rows = ['2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08'].map(date => ({timestamp: Date.parse(date+'T00:00:00Z'), flow_usd: 100000000}));
const stamp = '2026-10-09T01:00:00Z';
const reading = buildEtfSnapshot(rows, {source:'SoSoValue official API v2', fetchedAt:stamp, nowMs:Date.parse(stamp)});
function historical(value = reading) {
  return {schema:12, generated_at:'2026-10-13T19:48:23.164Z', sources:{sosovalue:'ok'}, etf:structuredClone(value)};
}

test('old derived metadata is preserved verbatim but recalculated for current eligibility', () => {
  const previous = historical();
  Object.assign(previous.etf, {expected_latest_session:'2026-10-09', sessions_behind:1, freshness_status:'reporting_lag'});
  const original = structuredClone(previous);
  const next = {generated_at:'2026-10-13T19:49:00Z', etf:{status:'unavailable'}};
  preserveVerifiedReadings(next, previous);
  assert.deepEqual(next.etf.last_verified.value, previous.etf);
  assert.deepEqual(next.etf.last_verified.provenance.sources, previous.sources);
  const reused = reusablePreviousEtf(previous, Date.parse(next.generated_at), next.generated_at);
  assert.equal(reused.expected_latest_session, '2026-10-12');
  assert.equal(reused.sessions_behind, 2);
  assert.equal(reused.fetched_at, stamp);
  assert.equal(reusablePreviousEtf(previous, Date.parse('2026-10-14T01:00:00Z'), '2026-10-14T01:00:00Z'), null);
  assert.deepEqual(previous, original);
});

test('legacy schema 9/10 ETF observations survive without upgrading historical data to current scoring', () => {
  for (const schema of [9,10]) {
    const old = historical(); old.schema = schema;
    old.etf.last_5_trading_days = old.etf.last_5_trading_sessions;
    delete old.etf.last_5_trading_sessions;
    const now = Date.parse('2026-11-01T12:00:00Z');
    const saved = historicalEtfReading(old, now);
    assert.deepEqual(saved.value, old.etf);
    assert.equal(saved.provenance.snapshot_schema, schema);
    assert.equal(reusablePreviousEtf(old, now, new Date(now).toISOString()), null);
    assert.deepEqual(historicalEtfReading({schema:12, generated_at:new Date(now).toISOString(), etf:{status:'unavailable',last_verified:saved}}, now), saved);
  }
});

test('JSON key order and extra observation provenance do not invalidate unchanged values', () => {
  const previous = historical();
  previous.etf.last_5_trading_sessions = previous.etf.last_5_trading_sessions.map(row => ({flow_usd:row.flow_usd, date:row.date, note:'original observation'}));
  const saved = historicalEtfReading(previous, Date.parse(previous.generated_at));
  assert.ok(saved);
  assert.deepEqual(saved.value, previous.etf);
});

const corruptions = {
  'null flow': e => e.last_5_trading_sessions[0].flow_usd = null,
  'boolean flow': e => e.last_5_trading_sessions[0].flow_usd = false,
  'infinite flow': e => e.last_5_trading_sessions[0].flow_usd = Infinity,
  'wrong sum': e => e.flow_5d_usd += 100,
  'duplicate date': e => e.last_5_trading_sessions[1].date = e.last_5_trading_sessions[0].date,
  'impossible date': e => e.last_5_trading_sessions[0].date = '2026-02-30',
  'future date': e => e.last_5_trading_sessions.at(-1).date = '2027-10-08',
  'missing row': e => e.last_5_trading_sessions.pop(),
  'wrong latest': e => e.latest_date = '2026-10-07',
  'mismatched aliases': e => e.last_5_trading_days[0].flow_usd += 100,
  'corrupt history': e => e.history[0].flow_usd += 100,
  'future fetched_at': e => e.fetched_at = '2027-01-01T00:00:00Z',
  'bad source status': e => e.source_status = 'tampered',
  'missing source': e => delete e.source,
};
for (const [name, change] of Object.entries(corruptions)) test(`historical corruption is rejected: ${name}`, () => {
  const old = historical(); change(old.etf);
  assert.equal(historicalEtfReading(old, Date.parse('2026-11-01T12:00:00Z')), null);
  const next = {generated_at:'2026-11-01T12:00:00Z', etf:{status:'unavailable'}};
  preserveVerifiedReadings(next, old);
  assert.equal(next.etf.last_verified, undefined);
});

test('carried history rejects changed values and forged provenance timestamps', () => {
  const saved = historicalEtfReading(historical(), Date.parse('2026-11-01T12:00:00Z'));
  for (const mutate of [s => s.value.flow_5d_usd++, s => s.observed_at = '2099-01-01T00:00:00Z',
    s => s.validated_at = 'invalid', s => s.provenance.generated_at = '2026-10-01T00:00:00Z',
    s => s.value.last_verified = structuredClone(saved)]) {
    const bad = structuredClone(saved); mutate(bad);
    assert.equal(historicalEtfReading({schema:12,generated_at:'2026-11-02T12:00:00Z',etf:{status:'unavailable',last_verified:bad}}, Date.parse('2026-11-02T12:00:00Z')), null);
  }
});

test('structurally valid but incomplete window is historical only, never current scoring', () => {
  const old = historical();
  old.etf.last_5_trading_sessions[0].date = '2026-10-01';
  old.etf.last_5_trading_days[0].date = '2026-10-01';
  old.etf.history[0].timestamp = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(validateEtfReading(old.etf, old.generated_at).ok, true);
  assert.ok(historicalEtfReading(old, Date.parse(old.generated_at)));
  assert.equal(reusablePreviousEtf(old, Date.parse(old.generated_at), old.generated_at), null);
  assert.throws(() => buildEtfSnapshot(old.etf.history, {source:'SoSoValue',fetchedAt:stamp,nowMs:Date.parse(stamp)}), /consecutive/);
});

// Real collector and real atomic publisher, fixture HTTP only, isolated temp data.
// Includes repeated outages, stale retention, recovery, revisions and total outage.
const scenarios = [
  ['missing Friday', '2026-10-15', ['2026-10-17T01:00:00Z','2026-10-17T16:00:00Z','2026-10-18T16:00:00Z','2026-10-19T16:00:00Z','2026-10-21T01:00:00Z']],
  ['Labor Day', '2026-09-03', ['2026-09-05T01:00:00Z','2026-09-07T16:00:00Z','2026-09-08T16:00:00Z','2026-09-10T01:00:00Z']],
  ['spring DST', '2026-03-05', ['2026-03-07T02:00:00Z','2026-03-08T06:59:00Z','2026-03-08T07:01:00Z','2026-03-09T16:00:00Z','2026-03-11T01:00:00Z']],
  ['fall DST', '2026-10-29', ['2026-10-31T02:00:00Z','2026-11-01T05:59:00Z','2026-11-01T06:01:00Z','2026-11-02T16:00:00Z','2026-11-04T02:00:00Z']],
];
function sessionRows(latest) {
  // An independent explicit holiday list for the cycle fixture, not production's selector.
  const holidays = new Set(['2026-09-07']);
  const dates = [];
  for (let date = Date.parse(latest+'T00:00:00Z'); dates.length < 5; date -= 86400000) {
    const key = new Date(date).toISOString().slice(0,10);
    if (![0,6].includes(new Date(date).getUTCDay()) && !holidays.has(key)) dates.unshift(key);
  }
  return dates.map(date => ({date,totalNetInflow:100000000}));
}
for (const [name, latest, checks] of scenarios) test(`full collector/publication cycle: ${name}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'btc-etf-cycle-'));
  const fixture = new URL('./btc-etf-cycle-fixture.mjs', import.meta.url).href;
  function publish(now, mode, data) {
    const run = spawnSync(process.execPath, ['scripts/publish-btc-market.mjs'], {cwd:root,encoding:'utf8',
      env:{...process.env, BTC_DATA_DIR:dir, NODE_OPTIONS:`--import=${fixture}`, BTC_TEST_NOW:now,
        BTC_TEST_SCENARIO:mode, BTC_TEST_ETF_ROWS:data ? JSON.stringify(data) : '', GITHUB_STEP_SUMMARY:''}});
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir,'btc-market.json'),'utf8'));
  }
  try {
    const fetched = latest+'T23:00:00Z';
    let current = publish(fetched, 'ok', sessionRows(latest));
    assert.equal(validateSnapshot(current).ok,true);
    const originalRows = structuredClone(current.etf.last_5_trading_sessions);
    let saved;
    for (const [i, now] of checks.entries()) {
      // Alternate source unavailable and source responding with delayed observations.
      current = publish(now, i % 2 ? 'ok' : 'http-403', i % 2 ? sessionRows(latest) : null);
      const eligibility = assessEtfFreshness(Date.parse(latest+'T00:00:00Z'),Date.parse(now));
      assert.equal(validateSnapshot(current).ok,true, JSON.stringify(validateSnapshot(current)));
      assert.equal(assessPublication(current,null,Date.parse(now)).publish,true);
      const {model,nodes} = displayed(current);
      assert.equal(model.spotScore,50); assert.ok(model.levHealth>0);
      if (eligibility.ok) {
        assert.equal(current.etf.freshness_status,eligibility.status);
        assert.equal(model.etfScore,75);
        assert.deepEqual(current.etf.last_5_trading_sessions,originalRows);
        if (eligibility.status==='reporting_lag') {
          assert.match(nodes['b-etf'].innerHTML, current.etf.source_status === 'preserved_after_refresh_failure'
            ? /source warning.*last known good/ : /normal reporting lag/);
          assert.ok(nodes['b-etf'].innerHTML.includes(`${eligibility.sessionsBehind} sessions behind`));
        }
      } else {
        assert.equal(current.etf.status,'unavailable');
        assert.equal(model.etfScore,null); assert.equal(model.demand,null);
        assert.match(nodes['b-etf'].innerHTML,/Last verified:.*STALE; not scored/);
        saved = current.etf.last_verified;
        assert.deepEqual(saved.value.last_5_trading_sessions, originalRows);
      }
    }
    assert.ok(saved);
    const staleAgain = new Date(Date.parse(checks.at(-1))+86400000).toISOString();
    current = publish(staleAgain,'http-403');
    assert.deepEqual(current.etf.last_verified,saved);
    assert.equal(displayed(current).model.etfScore,null);
    const corruptCandidate = structuredClone(current);
    corruptCandidate.etf.last_verified.value.flow_5d_usd++;
    assert.equal(assessPublication(corruptCandidate,null,Date.parse(staleAgain)).publish,false,
      'corrupt retained values must fail publication even when unrelated sources work');
    const beforeOutage = fs.readFileSync(path.join(dir,'btc-market.json'),'utf8');
    const history = fs.readFileSync(path.join(dir,'btc-market-history.jsonl'),'utf8');
    publish(new Date(Date.parse(staleAgain)+60000).toISOString(),'all-down');
    assert.equal(fs.readFileSync(path.join(dir,'btc-market.json'),'utf8'),beforeOutage);
    assert.equal(fs.readFileSync(path.join(dir,'btc-market-history.jsonl'),'utf8'),history);
    const recovery = new Date(Date.parse(staleAgain)+3600000).toISOString();
    const due = assessEtfFreshness(Date.parse(latest+'T00:00:00Z'),Date.parse(recovery)).expectedLatestSession;
    current = publish(recovery,'ok',sessionRows(due));
    assert.equal(current.etf.freshness_status,'fresh');
    assert.equal(current.etf.last_verified,undefined);
    assert.equal(displayed(current).model.etfScore,75);
    const revised = sessionRows(due); revised[0].totalNetInflow = 0;
    current = publish(new Date(Date.parse(recovery)+60000).toISOString(),'ok',revised);
    assert.equal(current.etf.flow_5d_usd,400000000);
    assert.equal(current.etf.freshness_status,'fresh');
    assert.equal(displayed(current).model.etfScore,70);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
