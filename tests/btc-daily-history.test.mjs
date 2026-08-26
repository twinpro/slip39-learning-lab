import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildDataset,fetchAllPages,normalizeObservations,stableData,validateDataset} from '../scripts/update-btc-daily-history.mjs';

const rows=[
  {time:'2010-07-18T00:00:00.000000000Z',PriceUSD:'0.0858400000000000'},
  {time:'2010-07-19T00:00:00.000000000Z',PriceUSD:'0.0808000000000000'}
];

test('preserves exact Coin Metrics time and PriceUSD observations',()=>assert.deepEqual(normalizeObservations(rows),rows));
test('orders observations and builds valid schema',()=>{const dataset=buildDataset([...rows].reverse(),'2026-08-25T00:00:00Z');assert.equal(dataset.earliestObservationDate,'2010-07-18');assert.equal(dataset.latestObservationDate,'2010-07-19');assert.equal(validateDataset(dataset),true);});
test('rejects invalid or incomplete API observations',()=>{for(const bad of [[{time:'bad',PriceUSD:'1'}],[{time:'2010-07-18T00:00:00Z'}],[{time:'2010-07-18T00:00:00Z',PriceUSD:'0'}]])assert.throws(()=>normalizeObservations(bad));});
test('rejects duplicate dates',()=>assert.throws(()=>normalizeObservations([rows[0],{...rows[0],PriceUSD:'1'}]),/Duplicate/));
test('validates pagination and combines every page',async()=>{const pages=new Map([['one',{data:[rows[0]],next_page_url:'two'}],['two',{data:[rows[1]]}]]);const fetched=await fetchAllPages(async url=>({ok:true,json:async()=>pages.get(url)}),'one');assert.deepEqual(fetched,rows);});
test('rejects malformed pagination responses',async()=>{await assert.rejects(()=>fetchAllPages(async()=>({ok:true,json:async()=>({oops:[]})}),'one'),/data array/);await assert.rejects(()=>fetchAllPages(async()=>({ok:false,status:500,statusText:'fail'}),'one'),/500/);});
test('stable comparison ignores only generatedAt',()=>{const a=buildDataset(rows,'2026-01-01T00:00:00Z'),b=buildDataset(rows,'2026-02-01T00:00:00Z');assert.deepEqual(stableData(a),stableData(b));});
test('generated daily-history JSON passes the production schema validator',async()=>{const dataset=JSON.parse(await readFile(new URL('../data/btc-daily-history.json',import.meta.url),'utf8'));assert.equal(validateDataset(dataset),true);});
