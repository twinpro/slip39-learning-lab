import test from 'node:test';
// Keep calendar regressions in the existing pipeline test command used by Actions.
import './btc-etf-freshness.test.mjs';
import './btc-etf-compatibility.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { getJson, observationTime } from '../scripts/btc-http.mjs';
import { validateSnapshot, computeSourceHealth } from '../scripts/btc-lib.mjs';
import { assessPublication, preserveVerifiedReadings } from '../scripts/btc-publication-lib.mjs';
import { outageState } from '../scripts/btc-alert-lib.mjs';
import { shouldRecoverMarketSnapshot } from '../scripts/btc-market-recovery-lib.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = new URL('./btc-pipeline-fixture.mjs', import.meta.url).href;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-fault-tests-'));
process.on('exit', () => fs.rmSync(temp, {recursive:true,force:true}));
let seq = 0;
function collect(mode='ok', previous=null) {
  const out = path.join(temp, `candidate-${seq++}.json`);
  const prior = path.join(temp, `previous-${seq++}.json`);
  if (previous) fs.writeFileSync(prior, JSON.stringify(previous));
  const r = spawnSync(process.execPath, ['--import',fixture,'scripts/update-btc-market.mjs'], {cwd:root,encoding:'utf8',env:{...process.env,BTC_TEST_SCENARIO:mode,BTC_MARKET_OUTPUT:out,BTC_MARKET_PREVIOUS:prior}});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(fs.readFileSync(out));
}
const good = collect();

test('all sources working: full verified snapshot and unchanged scoring inputs',()=>{
  assert.equal(validateSnapshot(good).ok,true,JSON.stringify(validateSnapshot(good)));
  assert.equal(good.health.overall.quality,'verified');
  assert.equal(good.etf.flow_5d_usd,500000000);
  assert.equal(good.spot.us_spot_premium_percent,0);
  assert.equal(good.derivatives.aggregate.funding_venue_count,5);
});
for (const mode of ['etf-down','spot-down','derivatives-down','http-403','http-429','http-500','malformed','empty','stale','future','bad-unit']) {
  test(`${mode}: isolate failure and retain unrelated verified sections`,()=>{
    const d = collect(mode);
    assert.equal(validateSnapshot(d).ok,true,JSON.stringify(validateSnapshot(d)));
    if (['etf-down','http-403','http-429','http-500','malformed','empty'].includes(mode)) {
      assert.equal(d.etf.status,'unavailable'); assert.equal(d.spot.status,'ok'); assert.equal(d.derivatives.aggregate.status,'ok');
    } else if (mode==='spot-down') { assert.equal(d.spot.status,'error'); assert.equal(d.etf.status,'ok'); }
    else if (mode==='derivatives-down') { assert.equal(d.derivatives.aggregate.status,'insufficient'); assert.equal(d.spot.status,'ok'); }
    else if (mode==='bad-unit') { assert.equal(d.derivatives.venues.kraken.status,'error'); assert.equal(d.spot.status,'ok'); }
    else { assert.equal(d.spot.status,'error'); assert.equal(d.derivatives.venues.okx.status,'error'); }
  });
}
test('403 is not retried; 429 and 500 retry once then recover', async()=>{
  for(const code of [403,429,500]) {
    let calls=0;
    const promise=getJson('fixture',{}, {sleep:async()=>{},fetchImpl:async()=>++calls===1?new Response('',{status:code}):Response.json({ok:true})});
    if(code===403) {await assert.rejects(promise,/403/);assert.equal(calls,1);}
    else {assert.deepEqual(await promise,{ok:true});assert.equal(calls,2);}
  }
});
test('body timeout remains active after response headers, bounded to two attempts',async()=>{
  let calls=0;
  await assert.rejects(getJson('fixture',{}, {timeoutMs:10,sleep:async()=>{},fetchImpl:async(u,{signal})=>{
    calls++; return {ok:true,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError'))))};
  }}),/timeout/);
  assert.equal(calls,2);
});
test('source timestamps reject future, stale, invalid values',()=>{
  for (const stamp of ['garbage',Date.now()+86400000,Date.now()-86400000]) assert.throws(()=>observationTime(stamp,new Date().toISOString()));
});
test('preserved readings keep original timestamps and cannot enter current scoring',()=>{
  const d=collect('spot-down',good);
  assert.equal(d.spot.last_verified.observed_at,good.spot.observed_at);
  assert.equal(d.spot.status,'error'); assert.equal(d.health.sections.spot.quality,'unknown');
  const again=collect('spot-down',d);
  assert.deepEqual(again.spot.last_verified,d.spot.last_verified);
  const restored=collect('ok',again);
  assert.equal(restored.spot.status,'ok');assert.equal(restored.spot.last_verified,undefined);
});
test('corrupt or future previous snapshot is never reused',()=>{
  for(const prior of [{schema:12}, {...good,generated_at:new Date(Date.now()+86400000).toISOString()}]) {
    const d=collect('spot-down',prior);assert.equal(d.spot.last_verified,undefined);
  }
});
test('total outage fails publication and preserves last successful timestamp',()=>{
  const d=collect('all-down');
  const a=assessPublication(d,{last_successful_at:good.generated_at});
  assert.equal(a.publish,false);assert.equal(a.status.last_successful_at,good.generated_at);
});
test('future candidate and impossible spot values cannot publish',()=>{
  let d=structuredClone(good);d.generated_at=new Date(Date.now()+86400000).toISOString();d.health=computeSourceHealth(d);assert.equal(assessPublication(d).publish,false);
  d=structuredClone(good);d.spot.coinbase_usd=-1;d.health=computeSourceHealth(d);assert.equal(assessPublication(d).publish,false);
});
test('publisher recovers missing/corrupt snapshot and preserves history during total outage',()=>{
  for(const initial of [null,'{broken']) {
    const dir=path.join(temp,`pub-${seq++}`);fs.mkdirSync(dir);
    if(initial)fs.writeFileSync(path.join(dir,'btc-market.json'),initial);
    function publish(mode) {
      const r=spawnSync(process.execPath,['scripts/publish-btc-market.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,BTC_DATA_DIR:dir,NODE_OPTIONS:`--import=${fixture}`,BTC_TEST_SCENARIO:mode}});
      assert.equal(r.status,0,r.stderr);
    }
    publish('ok');
    const before=fs.readFileSync(path.join(dir,'btc-market.json'),'utf8');
    const history=fs.readFileSync(path.join(dir,'btc-market-history.jsonl'),'utf8');
    // Expire the ETF as well so complete loss cannot reuse a still-valid report.
    const old=JSON.parse(before);old.etf.status='unavailable';old.health=computeSourceHealth(old);
    fs.writeFileSync(path.join(dir,'btc-market.json'),JSON.stringify(old));
    publish('all-down');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'btc-market.json'))),old);
    assert.equal(fs.readFileSync(path.join(dir,'btc-market-history.jsonl'),'utf8'),history);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'btc-market-health.json'))).snapshot_valid,false);
    publish('ok');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'btc-market-health.json'))).snapshot_valid,true);
  }
});
test('recovery detects missing, corrupt and future timestamps; recent attempts throttle it',()=>{
  for(const snapshot of [null,{}, {generated_at:new Date(Date.now()+86400000).toISOString()}]) assert.equal(shouldRecoverMarketSnapshot({snapshot}).shouldRecover,true);
  assert.equal(shouldRecoverMarketSnapshot({snapshot:null,lastAttemptAt:new Date().toISOString()}).shouldRecover,false);
});
test('alerts wait 24 hours and recognize recovery',()=>{
  const now=Date.now(), since=new Date(now-24*3600000).toISOString();
  const health={snapshot_valid:true,health:{overall:{quality:'unknown'}},unhealthy_since:since};
  assert.equal(outageState(good,health,now-1).alert,false);
  assert.equal(outageState(good,health,now).alert,true);
  health.health.overall.quality='partial';assert.equal(outageState(good,health,now).healthy,true);
});
test('main and recovery share one writer lock; no completion-triggered retry cascade',()=>{
  const main=fs.readFileSync(path.join(root,'.github/workflows/btc-market-data.yml'),'utf8');
  const recovery=fs.readFileSync(path.join(root,'.github/workflows/btc-market-recovery.yml'),'utf8');
  assert.match(main,/uses: \.\/.github\/workflows\/btc-market-recovery.yml/);
  assert.match(recovery,/group: btc-market-writer/);assert.doesNotMatch(recovery,/workflow_run|continue-on-error/);
  assert.match(main,/7,37 \* \* \* \*/);assert.match(recovery,/ref: main/);
});

test('real non-fast-forward push regenerates against latest main and retains remote history',()=>{
  const bare=path.join(temp,'remote.git'), a=path.join(temp,'writer-a'), b=path.join(temp,'writer-b');
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  fs.mkdirSync(bare);git(bare,'init','--bare','--initial-branch=main');
  git(temp,'clone',bare,a);fs.mkdirSync(path.join(a,'scripts'));fs.mkdirSync(path.join(a,'data'));
  for(const file of ['commit-btc-market.mjs','publish-btc-market.mjs','update-btc-market.mjs','btc-publication-lib.mjs','btc-http.mjs','btc-lib.mjs','btc-etf-lib.mjs','btc-history-lib.mjs']) fs.copyFileSync(path.join(root,'scripts',file),path.join(a,'scripts',file));
  fs.writeFileSync(path.join(a,'data/btc-market.json'),JSON.stringify(good));
  fs.writeFileSync(path.join(a,'data/btc-market-health.json'),JSON.stringify(assessPublication(good).status));
  fs.writeFileSync(path.join(a,'data/btc-market-history.jsonl'),'');
  git(a,'config','user.name','Test');git(a,'config','user.email','test@example.invalid');git(a,'add','.');git(a,'commit','-m','baseline');git(a,'push','origin','main');
  git(temp,'clone',bare,b);git(b,'config','user.name','Test');git(b,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(b,'remote-note.txt'),'Preserve concurrent work');
  // Concurrent writer advances market data and unrelated files before A pushes.
  fs.writeFileSync(path.join(b,'data/btc-market-health.json'),JSON.stringify({...assessPublication(good).status,remote_marker:true}));
  git(b,'add','.');git(b,'commit','-m','concurrent writer');git(b,'push','origin','main');
  fs.writeFileSync(path.join(a,'data/btc-market.json'),JSON.stringify({...good,attempt_marker:true}));
  const r=spawnSync(process.execPath,['scripts/commit-btc-market.mjs'],{cwd:a,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true',GITHUB_WORKSPACE:a,NODE_OPTIONS:`--import=${fixture}`,BTC_TEST_SCENARIO:'ok'}});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
  assert.match(r.stderr,/rejected/);assert.equal(fs.readFileSync(path.join(a,'remote-note.txt'),'utf8'),'Preserve concurrent work');
  assert.equal(git(a,'rev-parse','HEAD'),git(a,'rev-parse','origin/main'));
  assert.equal(git(a,'status','--porcelain'),'');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a,'data/btc-market.json'))).attempt_marker,undefined);
  assert.ok(fs.readFileSync(path.join(a,'data/btc-market-history.jsonl'),'utf8').length>0);
});

// Execute the actual production renderer with a minimal DOM, not a copied scoring formula.
test('actual dashboard renderer gates only affected scores and preserves 65/35 methodology',async()=>{
  const vm=await import('node:vm');
  const time=await import('../assets/js/btc-dashboard-time.mjs');
  const page=fs.readFileSync(path.join(root,'pages/btc-real-vs-paper-v11b.html'),'utf8');
  const helpers=page.slice(page.indexOf('const A ='),page.indexOf('function updateHeaderPriceState'));
  const render=page.slice(page.indexOf('function renderSnapshot(){'),page.indexOf('function drawGauge('));
  function run(snapshot,minutes=0,sidecar=null){
    const nodes={};let model;
    const ctx=vm.createContext({...time,performance:{now:()=>0},document:{getElementById:id=>nodes[id]||=( {style:{},classList:{toggle(){}}} )},esc:String,syncMobileSnapshot:m=>model=m,drawGauge(){},fixtureSnapshot:snapshot,fixtureSidecar:sidecar,fixtureNow:Date.parse(snapshot.generated_at)+minutes*60000});
    vm.runInContext(helpers+render+'\nS.snapshot=fixtureSnapshot;S.healthStatus=fixtureSidecar;setTrustedClock(fixtureNow,"test");renderSnapshot();',ctx);
    return {model,nodes};
  }
  const active=run(good).model;
  assert.equal(active.etfScore,75);assert.equal(active.spotScore,50);assert.equal(active.demand,66.25);assert.ok(active.levHealth>0);
  const delayed=run(good,61);assert.equal(delayed.model.demand,66.25);assert.match(delayed.nodes['snapshotAge'].textContent,/DELAYED/);
  for(const minutes of [181,-5]){const m=run(good,minutes).model;assert.equal(m.demand,null);assert.equal(m.etfScore,null);assert.equal(m.spotScore,null);assert.equal(m.levHealth,null);}
  const d=structuredClone(good);d.etf={status:'unavailable'};d.health=computeSourceHealth(d);
  const degraded=run(d).model;assert.equal(degraded.demand,null);assert.equal(degraded.etfBadge,'UNAVAILABLE');assert.equal(degraded.spotScore,50);assert.ok(degraded.levHealth>0);
  const sidecar={schema:1,attempted_at:good.generated_at,snapshot_valid:false,health:{schema:1,sections:{publication:{quality:'conflict'}}}};
  assert.equal(run(good,0,sidecar).model.demand,66.25);
  const lost=structuredClone(good);lost.spot={status:'error'};preserveVerifiedReadings(lost,good);lost.health=computeSourceHealth(lost);
  const stale=run(lost).model;assert.equal(stale.spotBadge,'STALE');assert.equal(stale.spotScore,null);assert.match(stale.spotNote,/Last verified:/);
});
