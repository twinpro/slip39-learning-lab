import { collect, buildEtf, farsideRows, sosoRows, premiumBlock, plausibilityFilter,
         aggregate, median, historyPoint } from "./update-btc-market.mjs";

const T = []; let fails = 0;
const ck = (n, cond, detail="") => { T.push(n); if(!cond){ fails++; console.log("FAIL  "+n+(detail?"\n        "+detail:"")); } };
const near = (a,b,tol=1e-6) => a!=null && b!=null && Math.abs(a-b) <= tol*Math.max(1,Math.abs(b));

const NOW = Date.parse("2026-08-22T12:00:00Z");
const day = n => NOW - n*86400000;
const PRICE = 78000;

/* ---------- fixtures ---------- */
const KRAKEN_TICKERS = { tickers:[
  { symbol:"PF_XBTUSD", openInterest: 9500,      markPrice: PRICE, fundingRate: 1.18e-7 },   // 9500 BTC = $741M
  { symbol:"PI_XBTUSD", openInterest: 196000000, markPrice: PRICE, fundingRate: -6.26e-11 }, // $196M already
  { symbol:"PF_ETHUSD", openInterest: 100,       markPrice: 2200,  fundingRate: 0 }
]};

const FARSIDE_HTML = `<table>
<tr><td>14 Aug 2026</td><td>(55.5)</td><td>(56.2)</td></tr>
<tr><td>17 Aug 2026</td><td>160.2</td><td>297.5</td></tr>
<tr><td>18 Aug 2026</td><td>143.6</td><td>189.3</td></tr>
<tr><td>19 Aug 2026</td><td>284.7</td><td>517.2</td></tr>
<tr><td>20 Aug 2026</td><td>503.0</td><td>606.3</td></tr>
<tr><td>21 Aug 2026</td><td>210.0</td><td>301.4</td></tr>
<tr><td>Total</td><td>62,187</td><td>53,468</td></tr>
</table>`;

const SOSO = { code:0, data:{ list:[
  { date:"2026-08-14", totalNetInflow:-56200000 },
  { date:"2026-08-17", totalNetInflow:297500000 },
  { date:"2026-08-18", totalNetInflow:189300000 },
  { date:"2026-08-19", totalNetInflow:517200000 },
  { date:"2026-08-20", totalNetInflow:606300000 },
  { date:"2026-08-21", totalNetInflow:301400000 }
]}};

function mockFetch(opts={}){
  const { krakenTickers = KRAKEN_TICKERS, peg = "0.9994", soso = SOSO, bybitDown = false,
          farside = FARSIDE_HTML } = opts;
  const J = v => ({ ok:true, status:200, statusText:"OK", json:async()=>v, text:async()=>JSON.stringify(v) });
  const TXT = v => ({ ok:true, status:200, statusText:"OK", text:async()=>v, json:async()=>{throw new Error("not json")} });
  const DEAD = { ok:false, status:403, statusText:"Forbidden", json:async()=>({}), text:async()=>"" };

  return async (url) => {
    const u = String(url);
    if (u.includes("sosovalue")) return J(soso);
    if (u.includes("farside.co.uk")) return TXT(farside);
    if (u.includes("okx.com/api/v5/public/open-interest")) return J({code:"0",data:[{oiCcy:"30000",oiUsd:"2340000000"}]});
    if (u.includes("okx.com/api/v5/public/funding-rate"))  return J({code:"0",data:[{fundingRate:"0.0001"}]});
    if (u.includes("instId=BTC-USDT-SWAP"))                return J({code:"0",data:[{last:String(PRICE)}]});
    if (u.includes("instId=USDC-USDT"))                    return peg==null?DEAD:J({code:"0",data:[{last:peg}]});
    if (u.includes("instId=BTC-USDT"))                     return J({code:"0",data:[{last:"78050"}]});
    if (u.includes("deribit.com"))    return J({result:{open_interest:924800000,funding_8h:0.000153,mark_price:PRICE+50}});
    if (u.includes("bitmex.com"))     return J([{openInterest:22000000,fundingRate:0.0001,markPrice:PRICE}]);
    if (u.includes("hyperliquid"))    return J([{universe:[{name:"ETH"},{name:"BTC"}]},
                                                [{markPx:"2200",openInterest:"100",funding:"0.00001"},
                                                 {markPx:String(PRICE),openInterest:"34000",funding:"0.0000125"}]]);
    if (u.includes("futures.kraken.com")) return J(krakenTickers);
    if (u.includes("api.bybit.com"))  return bybitDown ? DEAD : J({retCode:0,result:{list:[{openInterestValue:"8100000000",openInterest:"103846",fundingRate:"0.0001",markPrice:String(PRICE)}]}});
    if (u.includes("cmegroup.com"))   return DEAD;
    if (u.includes("coinbase.com"))   return J({price:"78200.00"});
    if (u.includes("api.kraken.com")) return J({result:{XXBTZUSD:{c:["78180.0","0.01"]}}});
    return DEAD;
  };
}

/* ================= unit tests ================= */

// --- the bug that started this
ck("median works", median([4,1,2,3]) === 2.5);

{ // plausibility filter catches the exact Kraken unit bug
  const v = { okx:{status:"ok",oi_usd:2.34e9}, deribit:{status:"ok",oi_usd:9.2e8},
              bitmex:{status:"ok",oi_usd:2.2e7}, kraken:{status:"ok",oi_usd:196000000*PRICE} };
  const rej = plausibilityFilter(v);
  ck("plausibility rejects a price-multiplied inverse contract", rej.includes("kraken"), JSON.stringify(v.kraken));
  ck("plausibility keeps the sane venues", v.okx.status==="ok" && v.deribit.status==="ok");
  ck("rejection carries a readable reason", /unit error|plausible band/.test(v.kraken.rejected_reason||""), v.kraken.rejected_reason);
}
{ // and does not fire on a healthy spread
  const v = { a:{status:"ok",oi_usd:2.3e9}, b:{status:"ok",oi_usd:9e8}, c:{status:"ok",oi_usd:8.1e9}, d:{status:"ok",oi_usd:2.2e7} };
  ck("plausibility leaves a normal venue spread alone (except the tiny one)", v.a.status==="ok"&&v.b.status==="ok"&&v.c.status==="ok");
}
{ // funding unit guard
  const v = { a:{status:"ok",oi_usd:1e9,funding_rate_percent:0.01}, b:{status:"ok",oi_usd:1e9,funding_rate_percent:900} };
  plausibilityFilter(v);
  ck("absurd funding is nulled, not aggregated", v.b.funding_rate_percent===null && v.a.funding_rate_percent===0.01);
}

// --- dimensional unit check (absolute, works with a single venue)
{
  const v = { kraken:{status:"ok", oi_usd:196000000*78000, mark_price:78000} };
  const rej = plausibilityFilter(v);
  ck("dimensional check catches a wrong multiply even with ONE venue", rej.includes("kraken"), JSON.stringify(v.kraken));
  ck("dimensional rejection names the units", /contract units are wrong/.test(v.kraken.rejected_reason||""), v.kraken.rejected_reason);
}
{
  const v = { kraken:{status:"ok", oi_usd:9500*78000, mark_price:78000} };
  plausibilityFilter(v);
  ck("dimensional check passes a correct linear read", v.kraken.status==="ok" && near(v.kraken.implied_btc, 9500, 1e-4),
     JSON.stringify(v.kraken));
}
{
  const v = { bitmex:{status:"ok", oi_usd:22000000, mark_price:78000} };
  plausibilityFilter(v);
  ck("dimensional check passes a correct inverse read (282 BTC)", v.bitmex.status==="ok", JSON.stringify(v.bitmex));
}
{
  const v = { a:{status:"ok",oi_usd:2e9,mark_price:78000}, b:{status:"ok",oi_usd:1e9,mark_price:78000},
              c:{status:"ok",oi_usd:9e8,mark_price:41000} };
  plausibilityFilter(v);
  ck("mark-price outlier is flagged, not rejected", v.c.status==="ok" && /% from the/.test(v.c.mark_warning||""), v.c.mark_warning);
  ck("consensus marks get no warning", !v.a.mark_warning && !v.b.mark_warning);
  ck("mark deviation is recorded numerically", typeof v.c.mark_deviation_percent === "number");
}

// --- ETF validation
{
  const rows = farsideRows(FARSIDE_HTML);
  ck("farside parses 6 rows and ignores Total", rows.length===6, JSON.stringify(rows.map(r=>r.flow_usd)));
  ck("farside reads the last number as the daily total", near(rows.at(-1).flow_usd, 301.4e6));
  ck("farside reads parentheses as negative", near(rows.find(r=>r.timestamp===Date.UTC(2026,7,14)).flow_usd, -56.2e6));
}
{
  const r = buildEtf(farsideRows(FARSIDE_HTML), "Farside", NOW);
  ck("ETF accepted when fresh", r.ok, r.error);
  ck("5d sum is the last five rows", near(r.block.flow_5d_usd, (297.5+189.3+517.2+606.3+301.4)*1e6, 1e-6));
  ck("5d span is reported", r.block.flow_5d_span_days === 4);
}
{
  const stale = farsideRows(FARSIDE_HTML).map(r=>({...r, timestamp:r.timestamp - 20*86400000}));
  ck("stale ETF series rejected", buildEtf(stale,"x",NOW).ok===false);
}
{
  const gappy = [40,30,20,10,1].map(n=>({timestamp:day(n), flow_usd:1e8}));
  const res = buildEtf(gappy,"x",NOW);
  ck("gappy 5-day window rejected", res.ok===false && /span/.test(res.error), res.error);
}
{
  const millions = farsideRows(FARSIDE_HTML).map(r=>({...r, flow_usd:r.flow_usd/1e6}));
  const res = buildEtf(millions,"x",NOW);
  ck("feed switched to millions is caught, not scored", res.ok===false && /millions/.test(res.error), res.error);
}
{
  const huge = farsideRows(FARSIDE_HTML).map(r=>({...r, flow_usd:r.flow_usd*1e6}));
  ck("absurd magnitude rejected", buildEtf(huge,"x",NOW).ok===false);
}
ck("sosoRows handles the list shape", sosoRows(SOSO).length===6);

// --- premium
{
  const p = premiumBlock({cbUsd:78200, krUsd:78180, okxUsdt:78050, usdcUsdt:0.9994});
  ck("premium peg-adjusted branch runs", p.premium_status==="peg_adjusted", JSON.stringify(p));
  ck("raw and adjusted differ by the peg", Math.abs(p.us_spot_premium_percent_raw - p.us_spot_premium_percent) > 0.001);
  ck("peg adjustment is reported", p.peg_adjustment_percent !== null);
}
{
  const p = premiumBlock({cbUsd:78200, krUsd:78180, okxUsdt:78050, usdcUsdt:null});
  ck("no peg quote leaves premium unscored", p.us_spot_premium_percent===null && p.premium_status==="unadjusted_no_peg_quote");
  ck("raw premium still reported for transparency", p.us_spot_premium_percent_raw !== null);
}
{
  const p = premiumBlock({cbUsd:78200, krUsd:78180, okxUsdt:78050, usdcUsdt:1.4});
  ck("implausible peg quote refused", p.us_spot_premium_percent===null && p.premium_status==="unadjusted_peg_quote_implausible");
}

// --- aggregate
{
  const v = { a:{status:"ok",oi_usd:2e9,funding_rate_percent:0.01}, b:{status:"ok",oi_usd:1e9,funding_rate_percent:0.04},
              c:{status:"error"}, cme:{status:"ok",oi_usd:2e10,include_in_aggregate:false} };
  const ag = aggregate(v);
  ck("aggregate sums only ok venues", near(ag.oi_usd, 3e9));
  ck("aggregate excludes CME by design", !ag.venues.includes("cme"), JSON.stringify(ag.venues));
  ck("funding is OI-weighted", near(ag.funding_rate_percent, (2e9*0.01+1e9*0.04)/3e9));
  ck("venue_set is stable and sorted", ag.venue_set==="a+b");
}
ck("one venue is not enough", aggregate({a:{status:"ok",oi_usd:1e9}}).status==="insufficient");

/* ================= integration ================= */
{
  const out = await collect({ fetchImpl: mockFetch(), sosoKey:"k", nowMs:NOW });

  ck("KRAKEN FIX: PF selected over PI", out.derivatives.venues.kraken.symbol==="PF_XBTUSD", JSON.stringify(out.derivatives.venues.kraken));
  ck("KRAKEN FIX: OI is 9500 BTC x price, not contracts x price",
     near(out.derivatives.venues.kraken.oi_usd, 9500*PRICE), String(out.derivatives.venues.kraken.oi_usd));
  ck("KRAKEN FIX: OI is under $1B, not $15 trillion", out.derivatives.venues.kraken.oi_usd < 1e9);
  ck("KRAKEN FIX: implied BTC recorded and sane",
     near(out.derivatives.venues.kraken.implied_btc, 9500, 1e-3), String(out.derivatives.venues.kraken.implied_btc));
  ck("KRAKEN FIX: funding excluded with a stated reason",
     out.derivatives.venues.kraken.funding_rate_percent===null && !!out.derivatives.venues.kraken.funding_excluded_reason);

  ck("all six venues present", ["okx","deribit","bitmex","hyperliquid","kraken","bybit"].every(k=>out.derivatives.venues[k]));
  ck("aggregate ok", out.derivatives.aggregate.status==="ok", JSON.stringify(out.derivatives.aggregate));
  ck("aggregate excludes failed CME", !out.derivatives.aggregate.venues.includes("cme"));
  ck("aggregate OI is plausible", out.derivatives.aggregate.oi_usd > 1e9 && out.derivatives.aggregate.oi_usd < 1e11,
     String(out.derivatives.aggregate.oi_usd));
  ck("no NaN anywhere in the JSON", !/NaN|Infinity/.test(JSON.stringify(out)));

  ck("ETF ok", out.etf.status==="ok", JSON.stringify(out.etf).slice(0,200));
  ck("ETF cross-checked against a second source", out.etf.cross_check.second_source!==null, JSON.stringify(out.etf.cross_check));
  ck("two sources agreeing is reported as agreement", out.etf.cross_check.agreement==="agree", JSON.stringify(out.etf.cross_check));

  ck("spot peg-adjusted", out.spot.premium_status==="peg_adjusted", JSON.stringify(out.spot));
  ck("history point well formed", historyPoint(out).oi_usd>0 && !!historyPoint(out).venue_set);
  ck("warning names the missing venues", /Binance and CME/.test(out.derivatives.aggregate.warning));
}

// the old bug reintroduced: PF missing, PI present -> must NOT multiply
{
  const onlyPI = { tickers:[{symbol:"PI_XBTUSD", openInterest:196000000, markPrice:PRICE, fundingRate:-6e-11}] };
  const out = await collect({ fetchImpl: mockFetch({krakenTickers:onlyPI}), sosoKey:"k", nowMs:NOW });
  ck("PI fallback uses openInterest as USD directly", near(out.derivatives.venues.kraken.oi_usd, 196000000), String(out.derivatives.venues.kraken.oi_usd));
  ck("PI fallback labels the contract type", /inverse/.test(out.derivatives.venues.kraken.contract));
}

// a venue dropping out must not silently change the comparable series label
{
  const out = await collect({ fetchImpl: mockFetch({bybitDown:true}), sosoKey:"k", nowMs:NOW });
  ck("bybit failure is non-fatal", out.derivatives.aggregate.status==="ok");
  ck("venue_set records the smaller set", out.derivatives.aggregate.venue_set==="bitmex+deribit+hyperliquid+kraken+okx",
     out.derivatives.aggregate.venue_set);
}

// no SoSo key: Farside alone must carry the ETF row
{
  const out = await collect({ fetchImpl: mockFetch(), sosoKey:"", nowMs:NOW });
  ck("ETF still works with no API key", out.etf.status==="ok" && out.etf.source==="Farside", JSON.stringify(out.etf.source));
  ck("single source is labelled as such", out.etf.cross_check.agreement==="single_source_only");
}

// everything down
{
  const dead = async () => ({ ok:false, status:503, statusText:"Down", json:async()=>({}), text:async()=>"" });
  const out = await collect({ fetchImpl: dead, sosoKey:"k", nowMs:NOW });
  ck("total outage yields unavailable, not zeros", out.etf.status==="unavailable" &&
     out.derivatives.aggregate.status==="insufficient" && out.spot.status==="error", JSON.stringify(out.sources));
  ck("no NaN on total outage", !/NaN|Infinity/.test(JSON.stringify(out)));
}

console.log(`\n${T.length - fails}/${T.length} collector checks passed`);
process.exit(fails ? 1 : 0);
