import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMonthlyReturns,classifyCell,completedAggregates,lastDailyPrices} from './monthly-returns.mjs';

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
