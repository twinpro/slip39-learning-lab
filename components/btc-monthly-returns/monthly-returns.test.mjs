import test from 'node:test';
import assert from 'node:assert/strict';
import {annualReturn,calculateMonthlyReturns,classifyCell,completedAggregates,lastDailyPrices,renderTable} from './monthly-returns.mjs';

const points=[
  {date:'2025-12-30',priceUSD:100},{date:'2025-12-31',priceUSD:100},
  {date:'2026-01-31',priceUSD:110},{date:'2026-02-28',priceUSD:99},
  {date:'2026-03-31',priceUSD:99},{date:'2026-05-31',priceUSD:120},
  {date:'2026-06-15',priceUSD:126}
];

test('uses the last daily PriceUSD in each month',()=>assert.equal(lastDailyPrices(points).get('2025-12').date,'2025-12-31'));
test('calculates positive, negative, and zero completed returns',()=>{
  const returns=calculateMonthlyReturns(points,'2026-06-15');
  assert.ok(Math.abs(returns.get('2026-01').value-10)<1e-10);
  assert.ok(Math.abs(returns.get('2026-02').value+10)<1e-10);
  assert.equal(returns.get('2026-03').value,0);
});
test('leaves a month missing when its previous month close is absent',()=>assert.equal(calculateMonthlyReturns(points,'2026-06-15').has('2026-05'),false));
test('marks the current month MTD and excludes it from aggregates',()=>{
  const returns=calculateMonthlyReturns(points,'2026-06-15');
  assert.equal(returns.get('2026-06').isCurrent,true);
  const may2025={value:20,isCurrent:false}, may2026={value:30,isCurrent:true};
  const aggregates=completedAggregates(new Map([['2025-05',may2025],['2026-05',may2026]]),2025,2026);
  assert.equal(aggregates[4].average,20); assert.equal(aggregates[4].median,20);
});
test('classifies positive, negative, zero, missing, future, and MTD cells',()=>{
  assert.equal(classifyCell({value:1}),'positive'); assert.equal(classifyCell({value:-1}),'negative');
  assert.equal(classifyCell({value:0}),'zero'); assert.equal(classifyCell({}),'missing');
  assert.equal(classifyCell({value:1,isFuture:true}),'future'); assert.equal(classifyCell({value:1,isCurrent:true}),'positive mtd');
});

test('compounds completed yearly returns instead of summing them',()=>{
  const returns=new Map([
    ['2025-01',{status:'ok',isCurrent:false,value:10}],
    ['2025-02',{status:'ok',isCurrent:false,value:-10}],
    ['2025-03',{status:'ok',isCurrent:false,value:5}]
  ]);
  assert.ok(Math.abs(annualReturn(returns,2025,'2026-08').value-3.95)<1e-10);
});

test('compounds current year from available months and ignores future blanks',()=>{
  const returns=new Map([
    ['2026-01',{status:'ok',isCurrent:false,value:10}],
    ['2026-02',{status:'ok',isCurrent:false,value:-10}],
    ['2026-08',{status:'ok',isCurrent:true,value:25}],
    ['2026-09',{status:'ok',isCurrent:false,value:99}]
  ]);
  const result=annualReturn(returns,2026,'2026-08');
  assert.equal(result.isCurrent,true);
  assert.ok(Math.abs(result.value-23.75)<1e-10);
});

test('renders newest year first, 2013 last, summaries at bottom, and preserves values and MTD',()=>{
  const nodes={
    'thead tr':{insertAdjacentHTML(){}},
    'tbody':{innerHTML:''},
    '#data-mode':{textContent:'',classList:{toggle(){}}},
    '#as-of':{textContent:''}
  };
  const documentRef={querySelector:selector=>nodes[selector]};
  const fixture={
    mode:'live',startYear:2013,latestObservationDate:'2026-08-24',
    returns:[
      {month:'2013-01',status:'ok',isCurrent:false,value:51.42714272},
      {month:'2026-08',status:'ok',isCurrent:true,value:25.47796972}
    ],
    aggregates:Array.from({length:12},()=>({average:null,median:null}))
  };
  renderTable(documentRef,fixture);
  const html=nodes.tbody.innerHTML;
  const labels=[...html.matchAll(/<tr[^>]*><td[^>]*>([^<]+)<\/td>/g)].map(match=>match[1]);
  assert.equal(labels[0],'2026');
  assert.equal(labels.at(-3),'2013');
  assert.deepEqual(labels.slice(-2),['MONTHLY AVERAGE','MONTHLY MEDIAN']);
  assert.match(html,/\+51\.4%/);
  assert.match(html,/\+25\.5%<small>MTD<\/small>/);
  assert.match(html,/YTD \+25\.5%/);
  assert.match(html,/summary-year-return" aria-label="No yearly summary"><\/td>/);
});
