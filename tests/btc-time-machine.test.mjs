import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDateRows,calculateComparison,datePart,formatHistoricalPrice,formatMultiple,formatPercent,isValidMonthDay,liveDisplayState,newYorkCalendarDate,renderRows,validateClientDataset} from '../components/btc-time-machine/btc-time-machine.mjs';

const dataset={schemaVersion:1,asset:'btc',metric:'PriceUSD',earliestObservationDate:'2020-02-29',latestObservationDate:'2026-08-24',observations:[
  {time:'2020-02-29T00:00:00Z',PriceUSD:'100'},
  {time:'2024-02-29T00:00:00Z',PriceUSD:'200'},
  {time:'2024-08-25T00:00:00Z',PriceUSD:'250'},
  {time:'2025-08-25T00:00:00Z',PriceUSD:'500'},
  {time:'2026-08-24T00:00:00Z',PriceUSD:'750'}
]};

test('groups exact month/day newest to oldest without interpolation',()=>{const rows=buildDateRows(dataset,'08-25','2026-08-25');assert.equal(rows[0].year,2025);assert.equal(rows.at(-1).year,2020);assert.equal(rows[0].priceUSD,500);assert.equal(rows.find(r=>r.year===2023).status,'missing');});
test('calculates percentage change and growth multiple',()=>assert.deepEqual(calculateComparison(1000,250),{percentageChange:300,growthMultiple:4}));
test('missing observations render N/A rather than a nearby price',()=>{const row=buildDateRows(dataset,'08-25','2026-08-25').find(r=>r.year===2023);assert.match(renderRows([row],1000),/N\/A/);assert.doesNotMatch(renderRows([row],1000),/250/);});
test('February 29 marks non-leap years unavailable',()=>{const rows=buildDateRows(dataset,'02-29','2026-08-25');assert.equal(rows.find(r=>r.year===2023).status,'missing');assert.equal(rows.find(r=>r.year===2024).priceUSD,200);});
test('future dates are unavailable and never substituted',()=>{const rows=buildDateRows(dataset,'12-31','2026-08-25');assert.equal(rows[0].status,'future');assert.equal(rows[0].priceUSD,null);});
test('current day is reserved for the independently labeled live price',()=>assert.equal(buildDateRows(dataset,'08-25','2026-08-25')[0].year,2025));
test('live price state labels only fresh ticker data LIVE',()=>{assert.equal(liveDisplayState({status:'live',price:100,lastMessageAt:1000},2000).label,'LIVE');assert.equal(liveDisplayState({status:'live',price:100,lastMessageAt:1000},22001).label,'DELAYED');assert.equal(liveDisplayState({status:'unavailable'},2000).label,'UNAVAILABLE');});
test('invalid dates and client schemas are rejected',()=>{assert.equal(isValidMonthDay('02-29'),true);assert.equal(isValidMonthDay('02-30'),false);assert.throws(()=>validateClientDataset({...dataset,observations:[dataset.observations[0],dataset.observations[0]]}),/Duplicate/);});
test('New York calendar date is deterministic across UTC boundary',()=>assert.equal(newYorkCalendarDate(new Date('2026-08-26T02:00:00Z')),'2026-08-25'));
test('Coin Metrics midnight UTC observations retain their stated historical calendar date',()=>{assert.equal(datePart('2026-08-24T00:00:00.000000000Z'),'2026-08-24');assert.equal(datePart('2025-08-25T00:00:00.000000000Z'),'2025-08-25');assert.equal(datePart('2024-02-29T00:00:00.000000000Z'),'2024-02-29');const augustRows=buildDateRows(dataset,'08-25','2026-08-25');assert.equal(augustRows.find(row=>row.year===2025).date,'2025-08-25');const leapRows=buildDateRows(dataset,'02-29','2026-08-25');assert.equal(leapRows.find(row=>row.year===2024).date,'2024-02-29');});
test('historical prices use adaptive precision',()=>{assert.equal(formatHistoricalPrice(110089.533314144),'$110,089.53');assert.equal(formatHistoricalPrice(0.0649),'$0.0649');assert.equal(formatHistoricalPrice(0.08584001),'$0.08584001');});
test('large percentages and growth multiples use thousands separators',()=>{assert.equal(formatPercent(121216813.6),'+121,216,813.6%');assert.equal(formatPercent(-12345.67),'-12,345.7%');assert.equal(formatMultiple(1212169.14),'1,212,169.14×');});
