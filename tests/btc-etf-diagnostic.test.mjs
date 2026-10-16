import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFarsideHtml} from '../scripts/btc-etf-diagnostic-lib.mjs';
const tickers=['IBIT','FBTC','BITB','ARKB','BTCO','EZBC','BRRR','HODL','BTCW','MSBT','GBTC','BTC'];
const row=cells=>'<tr>'+cells.map(c=>`<td>${c}</td>`).join('')+'</tr>';
const html=(values,total='0.0')=>'<table>'+row(['Date',...tickers,'Total'])+row(['16 Oct 2026',...values,total])+'</table>';
test('challenge page cannot be treated as data',()=>assert.equal(inspectFarsideHtml('<title>Just a moment</title>').status,'no_recognized_table'));
test('all missing funds and zero total remain incomplete',()=>{
 const r=inspectFarsideHtml(html(tickers.map(()=>'-'))).observations[0];assert.equal(r.complete,false);assert.equal(r.missing_funds.length,12);assert.equal(r.total_is_zero,true);
});
test('explicit numeric zeros remain numbers',()=>assert.equal(inspectFarsideHtml(html(tickers.map(()=>'0.0'))).observations[0].complete,true));
test('a single missing fund blocks completeness',()=>assert.equal(inspectFarsideHtml(html(['-',...tickers.slice(1).map(()=>'0.0')])).observations[0].complete,false));
test('changed fund universe is not silently accepted',()=>assert.equal(inspectFarsideHtml(html(tickers.map(()=>'0.0')).replace('MSBT','NEW')).status,'unrecognized_fund_schema'));
test('total discrepancy and malformed row are surfaced',()=>{
 assert.equal(inspectFarsideHtml(html(tickers.map(()=>'1.0'),'20.0')).observations[0].total_matches_rounded_components,false);
 assert.equal(inspectFarsideHtml(html(['1.0'])).observations[0].reason,'unexpected_cell_count');
});
