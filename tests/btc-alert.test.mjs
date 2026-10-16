import test from 'node:test';
import assert from 'node:assert/strict';
import { outageState, reconcileOutageIssues, OUTAGE_TITLE } from '../scripts/btc-alert-lib.mjs';
const since = '2026-10-15T12:00:00.000Z';
const now = Date.parse('2026-10-16T12:00:00.000Z');
const snapshot = { generated_at: new Date(now).toISOString() };
const health = { snapshot_valid: true, unhealthy_since: since, health: { overall: { quality: 'unavailable' } } };
const down = outageState(snapshot, health, now);
const up = outageState(snapshot, {...health, health: {overall: {quality:'partial'}}}, now);
const managed = (number=1, state='open', date=since) => ({number,state,title:OUTAGE_TITLE,body:`<!-- btc-outage:${date} -->`});
function fake(initial=[]) {
  const issues = structuredClone(initial), comments = new Map(), writes = [];
  let failClose = false;
  async function api(endpoint, method='GET', body) {
    const url = new URL(endpoint, 'https://example.test/');
    const parts = url.pathname.split('/').filter(Boolean);
    const number = Number(parts[1]);
    if(method==='GET') {
      const items = parts[2]==='comments' ? comments.get(number)||[] : issues;
      const start = (Number(url.searchParams.get('page')||1)-1)*100;
      return structuredClone(items.slice(start,start+100));
    }
    writes.push({endpoint,method,body});
    if(method==='PATCH') {
      if(failClose){failClose=false;throw new Error('transient close failure');}
      Object.assign(issues.find(i=>i.number===number),body);
    } else if(parts[2]==='comments') {
      comments.set(number,[...(comments.get(number)||[]),{body:body.body}]);
    } else issues.push({number:issues.length+1,state:'open',...body});
  }
  return {api,issues,comments,writes,failNextClose(){failClose=true;}};
}
const run = (f,state=down,s=snapshot) => reconcileOutageIssues(f.api,state,s,health,'owner/repo');
test('24-hour threshold, fresh partial recovery, stale and invalid snapshots',()=>{
  assert.equal(outageState(snapshot,health,now-1).alert,false);
  assert.equal(down.alert,true); assert.equal(up.healthy,true);
  assert.equal(outageState(snapshot,{...health,snapshot_valid:false},now).healthy,false);
  assert.equal(outageState({generated_at:since},{...health,health:{overall:{quality:'verified'}}},now).healthy,false);
});
test('repeated degraded runs create one issue and no repeated comments',async()=>{
  const f=fake(); await run(f); await run(f); await run(f);
  assert.equal(f.writes.length,1); assert.equal(f.issues.length,1);
});
test('pre-threshold degradation makes no API requests',async()=>{
  await reconcileOutageIssues(()=>{throw new Error('unexpected request');},{healthy:false,alert:false},snapshot,health,'owner/repo');
});
for(const state of ['open','closed']) test(`page-two ${state} outage prevents duplicate`,async()=>{
  const f=fake([...Array.from({length:100},(_,i)=>({number:i+1,title:'unrelated',state:'closed'})),managed(101,state)]);
  await run(f); assert.equal(f.writes.length,0);
});
test('renamed managed issue still prevents duplicate',async()=>{
  const f=fake([{...managed(),title:'Renamed by owner'}]); await run(f); assert.equal(f.writes.length,0);
});
test('unmanaged same-title issue and pull request do not suppress alert',async()=>{
  const f=fake([{number:1,state:'open',title:OUTAGE_TITLE},{...managed(2),pull_request:{}}]);
  await run(f); assert.equal(f.issues.length,3);
});
test('closed earlier episode permits a new outage issue',async()=>{
  const f=fake([managed(1,'closed','2026-10-01T00:00:00Z')]); await run(f); assert.equal(f.issues.length,2);
});
test('recovery closes managed issues across pages exactly once',async()=>{
  const f=fake([...Array.from({length:100},(_,i)=>({number:i+1,title:'unrelated',state:'closed'})),managed(101)]);
  await run(f,up); await run(f,up);
  assert.equal(f.issues.at(-1).state,'closed'); assert.equal(f.writes.length,2);
  assert.equal(f.comments.get(101).length,1);
});
test('recovery leaves unrelated, malformed, future and PR issues alone',async()=>{
  const f=fake([{number:1,state:'open',title:OUTAGE_TITLE},{...managed(2),body:'<!-- btc-outage:invalid -->'},managed(3,'open','2026-10-17T00:00:00Z'),{...managed(4),pull_request:{}}]);
  await run(f,up); assert.equal(f.writes.length,0);
});
test('failed closure retries without duplicate recovery comment',async()=>{
  const f=fake([managed()]); f.failNextClose();
  await assert.rejects(run(f,up),/transient/); await run(f,up);
  assert.equal(f.comments.get(1).length,1); assert.equal(f.issues[0].state,'closed');
});
test('recovery comment deduplication paginates comments',async()=>{
  const f=fake([managed()]); f.comments.set(1,[...Array.from({length:100},()=>({body:'discussion'})),{body:`<!-- btc-recovery:${since} -->`}]);
  await run(f,up); assert.equal(f.writes.length,1); assert.equal(f.writes[0].method,'PATCH');
});
test('GitHub list failure fails closed without creating another issue',async()=>{
  let writes=0;
  await assert.rejects(reconcileOutageIssues(async(_,method='GET')=>{if(method!=='GET')writes++;throw new Error('API failed');},down,snapshot,health,'owner/repo'));
  assert.equal(writes,0);
});
