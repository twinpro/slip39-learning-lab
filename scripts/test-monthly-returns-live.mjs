import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {API_URL,buildDataset,calculateReturns,completedAggregates,parseObservation} from './btc-monthly-returns-lib.mjs';

test('rejects missing, malformed, zero, and negative prices',()=>{
  for(const PriceUSD of [undefined,null,'bad','0',0,-1]) assert.equal(parseObservation({time:'2026-08-01',PriceUSD}),null);
});

test('calculates positive, negative, zero, unknown, and current MTD distinctly',()=>{
  const rows=[
    {date:'2012-12-31',priceUSD:100},{date:'2013-01-31',priceUSD:110},
    {date:'2013-02-28',priceUSD:99},{date:'2013-03-31',priceUSD:99},
    {date:'2013-05-31',priceUSD:120},{date:'2013-06-15',priceUSD:126}
  ];
  const result=calculateReturns(rows,'2013-06-15');
  assert.ok(Math.abs(result[0].value-10)<1e-8);
  assert.ok(Math.abs(result[1].value+10)<1e-8);
  assert.equal(result[2].value,0);
  assert.equal(result.find(item=>item.month==='2013-05').status,'unknown');
  assert.equal(result.find(item=>item.month==='2013-06').isCurrent,true);
});

test('aggregates exclude current MTD',()=>{
  const aggregates=completedAggregates([
    {month:'2025-08',status:'ok',isCurrent:false,value:20},
    {month:'2026-08',status:'ok',isCurrent:true,value:-50}
  ]);
  assert.equal(aggregates[7].average,20);
  assert.equal(aggregates[7].median,20);
});

test('generated live JSON satisfies invariants',async()=>{
  const dataset=JSON.parse(await readFile(new URL('../data/btc-monthly-returns.json',import.meta.url),'utf8'));
  assert.equal(dataset.mode,'live');
  assert.equal(dataset.sourceUrl,API_URL);
  assert.equal(dataset.returns[0].month,'2013-01');
  assert.equal(dataset.returns[0].status,'ok');
  assert.equal(dataset.returns.at(-1).isCurrent,true);
  assert.ok(dataset.returns.filter(item=>!item.isCurrent).every(item=>item.status==='unknown'||Number.isFinite(item.value)));
});

test('Community API succeeds without an API key and reproduces the stored latest return',{timeout:30000},async()=>{
  const response=await fetch(API_URL,{headers:{accept:'application/json'}});
  assert.equal(response.ok,true);
  const payload=await response.json();
  assert.ok(Array.isArray(payload.data)&&payload.data.length>0);
  const live=buildDataset(payload.data,'test');
  const stored=JSON.parse(await readFile(new URL('../data/btc-monthly-returns.json',import.meta.url),'utf8'));
  assert.equal(live.latestObservationDate,stored.latestObservationDate);
  assert.deepEqual(live.returns.at(-1),stored.returns.at(-1));
});
