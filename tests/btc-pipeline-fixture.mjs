// Deterministic network fixtures used only by subprocess fault tests. Never deployed data.
const now = Date.now();
const iso = new Date(now).toISOString();
const mode = process.env.BTC_TEST_SCENARIO || 'ok';
const dates = [];
for (let d = new Date(now - 86400000); dates.length < 5; d = new Date(+d - 86400000)) {
  if (![0,6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0,10));
}
const stamp = mode === 'future' ? now + 86400000 : mode === 'stale' ? now - 86400000 : now;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const etf = u.includes('sosovalue');
  const spot = u.includes('coinbase') || u.includes('api.kraken.com') || u.includes('instId=BTC-USDT') && !u.includes('SWAP');
  const derivatives = !etf && !spot;
  if (mode === 'all-down' || mode === 'etf-down' && etf || mode === 'spot-down' && spot || mode === 'derivatives-down' && derivatives) return new Response('', {status:503});
  if (etf && /^http-/.test(mode)) return new Response('', {status:Number(mode.slice(5))});
  if (etf && mode === 'malformed') return new Response('{');
  if (etf && mode === 'empty') return Response.json({code:0,data:[]});
  let j;
  if (etf) j = {code:0,data:dates.map(date=>({date,totalNetInflow:100000000}))};
  else if (u.includes('open-interest')) j = {code:'0',data:[{oiUsd:2300000000,oiCcy:28750,ts:stamp}]};
  else if (u.includes('funding-rate')) j = {code:'0',data:[{fundingRate:0.0001,ts:stamp}]};
  else if (u.includes('okx')) j = {code:'0',data:[{last:80000,ts:stamp}]};
  else if (u.includes('deribit')) j = {result:{timestamp:stamp,open_interest:900000000,funding_8h:0.0001,mark_price:80000}};
  else if (u.includes('bitmex')) j = [{symbol:'XBTUSD',state:'Open',timestamp:new Date(stamp).toISOString(),openInterest:22000000,fundingRate:0.0001,markPrice:80000}];
  else if (u.includes('hyperliquid')) j = [{universe:[{name:'BTC'}]},[{openInterest:33000,markPx:80000,funding:0.0000125}]];
  else if (u.includes('historicalfunding')) j = {rates:[{timestamp:new Date(stamp).toISOString(),relativeFundingRate:0.0000125}]};
  else if (u.includes('futures.kraken')) j = {serverTime:new Date(stamp).toISOString(),tickers:[{symbol:'PI_XBTUSD',openInterest:3400000,markPrice:mode==='bad-unit'?0:80000,fundingRate:0}]};
  else if (u.includes('bybit')) j = {retCode:0,time:stamp,result:{list:[{openInterestValue:200000000,openInterest:2500,markPrice:80000,fundingRate:0.0001}]}};
  else if (u.includes('coinbase')) j = {price:u.includes('USDT-USD')?1:80000,time:new Date(stamp).toISOString()};
  else if (u.includes('api.kraken')) j = {error:[],result:{pair:{c:[u.includes('USDTUSD')?'1':'80000']}}};
  else throw new Error('Unexpected fixture URL '+u);
  return Response.json(j);
};
