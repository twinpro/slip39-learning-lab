// Read-only audit of every distinct market snapshot reachable through local refs
// and reflogs. Fetch production history before running; no network or file writes.
// Usage: node scripts/audit-btc-etf-history.mjs [baseline-ref] [saved-archives.jsonl]
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {validateSnapshot, validateEtfReading, historicalEtfReading, computeSourceHealth, assessEtfFreshness} from './btc-lib.mjs';
import {reusablePreviousEtf} from './btc-etf-lib.mjs';
import {preserveVerifiedReadings, assessPublication} from './btc-publication-lib.mjs';
import {buildHistoryRow, validateHistoryRows} from './btc-history-lib.mjs';

const git = (...args) => execFileSync('git',args,{encoding:'utf8',maxBuffer:256*1024*1024});
const baselineRef = process.argv[2] || 'origin/main';
const baselineSha = git('rev-parse',baselineRef).trim();
const baseline = await import('data:text/javascript;base64,' + Buffer.from(git('show',`${baselineSha}:scripts/btc-lib.mjs`)).toString('base64'));
const cached = process.argv[3] ? readFileSync(process.argv[3], 'utf8').trim().split('\n').map(line => JSON.parse(line)) : null;
const ids = cached ? cached.map(row => row.oid) : [...new Set(git('rev-list','--objects','--all','--reflog','--','data/btc-market.json').trim().split('\n')
  .filter(line => line.endsWith(' data/btc-market.json')).map(line => line.split(' ')[0]))];
const batch = cached ? null : execFileSync('git',['cat-file','--batch'],{input:ids.join('\n')+'\n',maxBuffer:256*1024*1024});
const template = JSON.parse(git('show',`${baselineSha}:data/btc-market.json`));
const now = Math.max(Date.now(),Date.parse(template.generated_at)+86400000);
function candidate(at) {
  const d = structuredClone(template);
  d.generated_at = new Date(at).toISOString();
  for (const part of [d.spot,...Object.values(d.derivatives?.venues || {})]) if (part?.observed_at) part.observed_at = d.generated_at;
  d.etf = {status:'unavailable',error:'audit fixture: provider unavailable'};
  d.health = computeSourceHealth(d);
  return d;
}
const report = {baselineSha,distinctSnapshots:ids.length,baselineValid:0,currentValid:0,
  baselineValidRejectedByFreshnessFix:0,legacySchemaReadings:0,validEtfReadings:0,noEtfReading:0,
  preservedFirstCycle:0,preservedSecondCycle:0,eligibleAtOriginalTime:0,retainedNotScored:0,
  corruptEtfReadings:[],failures:[],schemas:{},classification:{},baselineFailureCategories:{}};
let offset=0;
for (const [index, oid] of ids.entries()) {
  let text;
  if (!cached) {
    const end=batch.indexOf(10,offset);const size=Number(batch.subarray(offset,end).toString().split(' ')[2]);
    text=batch.subarray(end+1,end+1+size).toString();offset=end+size+2;
  }
  try {
    const d=cached ? cached[index].snapshot : JSON.parse(text), original=JSON.stringify(d);
    report.schemas[d.schema]=(report.schemas[d.schema]||0)+1;
    const before=baseline.validateSnapshot(d), after=validateSnapshot(d);
    for (const error of before.errors) {
      const category = error.replace(/\d+(\.\d+)?/g, '#');
      report.baselineFailureCategories[category]=(report.baselineFailureCategories[category]||0)+1;
    }
    if(before.ok)report.baselineValid++;
    if(after.ok)report.currentValid++;
    if(before.ok&&!after.ok)report.baselineValidRejectedByFreshnessFix++;
    const reading=historicalEtfReading(d,now);
    if(!reading){
      if(d.etf?.status==='ok')report.corruptEtfReadings.push({oid,errors:validateEtfReading(d.etf,d.generated_at,{legacy:d.schema<12}).errors});
      else report.noEtfReading++;
      continue;
    }
    report.validEtfReadings++;
    if(d.schema<12)report.legacySchemaReadings++;
    const key=d.schema<12?'legacy schema, intact observations':before.ok&&!after.ok?'derived freshness incompatibility':before.ok?'accepted by earlier current validator':'intact ETF section; whole-snapshot validation differs';
    report.classification[key]=(report.classification[key]||0)+1;
    const first=candidate(now);
    preserveVerifiedReadings(first,d);first.health=computeSourceHealth(first);
    assert.deepEqual(first.etf.last_verified,reading);
    assert.deepEqual(first.etf.last_verified.value,d.etf);
    assert.equal(first.etf.status,'unavailable');
    assert.equal(first.health.sections.etf.quality,'unknown');
    assert.equal(assessPublication(first,null,now).publish,true,JSON.stringify(validateSnapshot(first)));
    const history=buildHistoryRow(first);
    assert.equal(history.etf.flow_5_sessions_usd,null);
    const historyCheck=validateHistoryRows([history], {nowMs: now});
    assert.equal(historyCheck.ok,true,JSON.stringify(historyCheck));
    report.preservedFirstCycle++;report.retainedNotScored++;
    // JSON publication round trip before the next collector's preservation path.
    const published=JSON.parse(JSON.stringify(first)), second=candidate(now+86400000);
    preserveVerifiedReadings(second,published);second.health=computeSourceHealth(second);
    assert.deepEqual(second.etf.last_verified,reading);
    assert.equal(assessPublication(second,null,now+86400000).publish,true);
    report.preservedSecondCycle++;
    const at=Date.parse(d.generated_at), reused=reusablePreviousEtf(d,at,d.generated_at);
    if(reused){
      const fresh=assessEtfFreshness(Date.parse(d.etf.latest_date+'T00:00:00Z'),at);
      assert.ok(fresh.ok);assert.equal(reused.freshness_status,fresh.status);
      assert.equal(reused.expected_latest_session,fresh.expectedLatestSession);
      assert.deepEqual(reused.history,d.etf.history);
      assert.equal(reused.fetched_at,d.etf.fetched_at||d.generated_at);
      const active=candidate(at);active.etf=reused;active.health=computeSourceHealth(active);
      assert.equal(validateSnapshot(active).ok,true,JSON.stringify(validateSnapshot(active)));
      report.eligibleAtOriginalTime++;
    }
    assert.equal(JSON.stringify(d),original,'archive mutated');
  } catch(error) {report.failures.push({oid,message:error.message});}
}
console.log(JSON.stringify(report,null,2));
if(report.failures.length||report.corruptEtfReadings.length)process.exitCode=1;
