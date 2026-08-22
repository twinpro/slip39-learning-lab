import fs from "node:fs/promises";

const OUT = new URL("../data/btc-market.json", import.meta.url);
const NOW = new Date();
const ISO = NOW.toISOString();
const MAX_ETF_CALENDAR_AGE_DAYS = 4;
const ETF_MAX_ABS_DAILY_FLOW_USD = 5_000_000_000;
const ETF_MIN_MEANINGFUL_FLOW_USD = 100_000;
const CORE_DERIVATIVE_VENUES = ["okx","deribit","bitmex","hyperliquid","kraken"];

const out = {
  schema: 12,
  generated_at: ISO,
  cost: "$0",
  api_keys_required: true,
  api_keys: ["SOSOVALUE_API_KEY (free tier)"],
  paid_api_keys_required: false,
  sources: {},
  etf: {status:"unavailable"},
  derivatives: {venues:{}, aggregate:{status:"unavailable"}},
  spot: {status:"unavailable"},
  exchange_supply: {
    status:"unavailable_free_reliable",
    score:null,
    note:"No reliable free machine-readable all-exchange BTC balance feed was verified. This metric remains unknown and is excluded from scoring."
  }
};

const num=x=>{const v=Number(x);return Number.isFinite(v)?v:null};
async function fetchAny(url, opts={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetch(url,{
      ...opts,
      signal:controller.signal,
      headers:{
        "User-Agent":"Mozilla/5.0 (compatible; btc-real-vs-paper-v9/1.0)",
        "Accept":"*/*",
        ...(opts.headers||{})
      }
    });
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r;
  }finally{clearTimeout(timer)}
}
async function getJson(url,opts){return await (await fetchAny(url,opts)).json()}
async function getText(url,opts){return await (await fetchAny(url,opts)).text()}

function parseDate(s){
  const t=Date.parse(s);
  return Number.isFinite(t)?t:null;
}
function ageDays(ts){return (Date.now()-ts)/86400000}

function lastFiniteDeep(x){
  if(Array.isArray(x)){
    for(let i=x.length-1;i>=0;i--){
      const v=lastFiniteDeep(x[i]);
      if(v!=null) return v;
    }
    return null;
  }
  return num(x);
}
function acceptEtf(rows,source){
  if(!Array.isArray(rows)||rows.length<5) return false;

  const clean=rows
    .filter(x=>Number.isFinite(x.timestamp)&&Number.isFinite(x.flow_usd))
    .sort((a,b)=>a.timestamp-b.timestamp);

  if(clean.length<5) return false;

  const latest=clean.at(-1);
  const age=ageDays(latest.timestamp);
  if(age>MAX_ETF_CALENDAR_AGE_DAYS) return false;

  // Unit / magnitude guards. SoSoValue is expected to return USD, not "millions of USD".
  if(clean.some(x=>Math.abs(x.flow_usd)>ETF_MAX_ABS_DAILY_FLOW_USD)) return false;
  const recentNonZero=clean.slice(-20).map(x=>Math.abs(x.flow_usd)).filter(x=>x>0);
  if(recentNonZero.length && Math.max(...recentNonZero)<ETF_MIN_MEANINGFUL_FLOW_USD) return false;

  const last5=clean.slice(-5);
  const firstTs=last5[0].timestamp;
  const spanCalendarDays=Math.round((latest.timestamp-firstTs)/86400000);

  out.etf={
    status:"ok",
    source,
    fetched_at:ISO,
    latest_date:new Date(latest.timestamp).toISOString().slice(0,10),
    latest_age_days:+age.toFixed(2),
    row_count:clean.length,
    flow_5_sessions_usd:last5.reduce((a,x)=>a+x.flow_usd,0),
    // Backward compatibility for existing pages; this is five TRADING SESSIONS, not five calendar days.
    flow_5d_usd:last5.reduce((a,x)=>a+x.flow_usd,0),
    five_session_span_calendar_days:spanCalendarDays,
    last_5_trading_sessions:last5.map(x=>({
      date:new Date(x.timestamp).toISOString().slice(0,10),
      flow_usd:x.flow_usd
    })),
    last_5_trading_days:last5.map(x=>({
      date:new Date(x.timestamp).toISOString().slice(0,10),
      flow_usd:x.flow_usd
    })),
    history:clean.slice(-25)
  };
  return true;
}

// ETF source: SoSoValue official API.
// Primary: V2 historical inflow endpoint.
// Fallback: official legacy V1 BTC ETF historical inflow endpoint.
// Both require the same x-soso-api-key. No paid API is used.
const SOSO_KEY = process.env.SOSOVALUE_API_KEY || "";

function sosoRowsFrom(j){
  const lists = [
    j?.data?.list,
    j?.data,
    j?.list,
    j?.result?.list,
    j?.result
  ];
  for(const a of lists){
    if(!Array.isArray(a)) continue;
    const rows=a.map(x=>({
      timestamp:Date.parse(String(x?.date ?? x?.timestamp ?? x?.time ?? "")+"T00:00:00Z"),
      flow_usd:num(x?.totalNetInflow ?? x?.dailyNetInflow ?? x?.netInflow ?? x?.flow_usd)
    })).filter(x=>Number.isFinite(x.timestamp)&&x.flow_usd!=null);
    if(rows.length) return rows.sort((a,b)=>a.timestamp-b.timestamp);
  }
  return [];
}

function sosoDebug(j){
  const d=j?.data;
  return {
    code:j?.code ?? null,
    msg:j?.msg ?? null,
    top_level_keys:j && typeof j==="object" ? Object.keys(j).slice(0,20) : [],
    data_type:Array.isArray(d)?"array":(d===null?"null":typeof d),
    data_keys:d && typeof d==="object" && !Array.isArray(d) ? Object.keys(d).slice(0,20) : [],
    list_length:Array.isArray(d?.list)?d.list.length:null,
    first_item_keys:Array.isArray(d?.list)&&d.list[0]&&typeof d.list[0]==="object"
      ? Object.keys(d.list[0]).slice(0,20) : []
  };
}

async function trySosoV2(){
  const j=await getJson("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-soso-api-key":SOSO_KEY
    },
    body:JSON.stringify({type:"us-btc-spot"})
  });
  if(Number(j?.code)!==0) throw new Error(j?.msg || "SoSoValue V2 API error");
  return {rows:sosoRowsFrom(j),debug:sosoDebug(j),version:"v2"};
}

async function trySosoV1(){
  const j=await getJson("https://api.sosovalue.xyz/openapi/v1/etf/us-btc-spot/historicalInflowChart",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-soso-api-key":SOSO_KEY
    },
    body:JSON.stringify({})
  });
  if(Number(j?.code)!==0) throw new Error(j?.msg || "SoSoValue V1 API error");
  return {rows:sosoRowsFrom(j),debug:sosoDebug(j),version:"v1"};
}

try{
  if(!SOSO_KEY) throw new Error("SOSOVALUE_API_KEY secret is missing");

  let chosen=null;
  let v2error=null;

  try{
    const v2=await trySosoV2();
    out.sources.sosovalue_v2_debug=v2.debug;
    if(v2.rows.length>=5) chosen=v2;
    else v2error=`V2 returned ${v2.rows.length} usable rows`;
  }catch(e){
    v2error=String(e.message||e);
    out.sources.sosovalue_v2_error=v2error;
  }

  if(!chosen){
    const v1=await trySosoV1();
    out.sources.sosovalue_v1_debug=v1.debug;
    if(v1.rows.length>=5) chosen=v1;
    else throw new Error(`${v2error||"V2 unavailable"}; V1 returned ${v1.rows.length} usable rows`);
  }

  if(!acceptEtf(chosen.rows,`SoSoValue official API ${chosen.version}`)){
    const latest=chosen.rows.length
      ? new Date(chosen.rows.at(-1).timestamp).toISOString().slice(0,10)
      : "none";
    throw new Error(`SoSoValue ${chosen.version} ETF data rejected: rows=${chosen.rows.length}, latest=${latest}`);
  }

  out.sources.sosovalue="ok";
  out.sources.sosovalue_endpoint=chosen.version;
}catch(e){
  out.etf={status:"unavailable",error:String(e.message||e)};
  out.sources.sosovalue="error: "+String(e.message||e);
}

// OKX — already verified working from the user's GitHub runner.
try{
  const [oi,fund,ticker]=await Promise.all([
    getJson("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
  ]);
  if(oi.code!=="0"||fund.code!=="0"||ticker.code!=="0") throw new Error("OKX non-zero API code");
  const o=oi.data?.[0]||{},f=fund.data?.[0]||{},t=ticker.data?.[0]||{};
  const oiUsd=num(o.oiUsd) ?? (num(o.oiCcy)&&num(t.last)?num(o.oiCcy)*num(t.last):null);
  out.derivatives.venues.okx={status:"ok",oi_usd:oiUsd,oi_btc:num(o.oiCcy),funding_rate_percent:num(f.fundingRate)!=null?num(f.fundingRate)*100:null,mark_price:num(t.last)};
  out.sources.okx="ok";
}catch(e){out.derivatives.venues.okx={status:"error",error:String(e.message||e)};out.sources.okx="error"}

// Deribit — public, no key.
try{
  const j=await getJson("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
  const d=j.result||{};
  const oiUsd=num(d.open_interest); // Deribit BTC perpetual open_interest is USD notional.
  out.derivatives.venues.deribit={status:"ok",oi_usd:oiUsd,funding_rate_percent:num(d.funding_8h)!=null?num(d.funding_8h)*100:null,mark_price:num(d.mark_price)};
  out.sources.deribit="ok";
}catch(e){out.derivatives.venues.deribit={status:"error",error:String(e.message||e)};out.sources.deribit="error"}

// BitMEX XBTUSD — inverse contract, 1 contract = 1 USD notional.
try{
  const j=await getJson("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&columns=openInterest,fundingRate,markPrice");
  const d=j?.[0]||{};
  out.derivatives.venues.bitmex={status:"ok",oi_usd:num(d.openInterest),funding_rate_percent:num(d.fundingRate)!=null?num(d.fundingRate)*100:null,mark_price:num(d.markPrice)};
  out.sources.bitmex="ok";
}catch(e){out.derivatives.venues.bitmex={status:"error",error:String(e.message||e)};out.sources.bitmex="error"}

// Hyperliquid public info endpoint.
try{
  const j=await getJson("https://api.hyperliquid.xyz/info",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({type:"metaAndAssetCtxs"})
  });
  const i=j?.[0]?.universe?.findIndex(x=>x.name==="BTC");
  if(i==null||i<0) throw new Error("BTC not found");
  const d=j[1][i],mark=num(d.markPx),oiBtc=num(d.openInterest);
  out.derivatives.venues.hyperliquid={status:"ok",oi_usd:mark&&oiBtc?mark*oiBtc:null,oi_btc:oiBtc,funding_rate_percent:num(d.funding)!=null?num(d.funding)*100*8:null,mark_price:mark};
  out.sources.hyperliquid="ok";
}catch(e){out.derivatives.venues.hyperliquid={status:"error",error:String(e.message||e)};out.sources.hyperliquid="error"}


// Kraken public derivatives API — no API key required.
// PI_XBTUSD is an inverse perpetual: contractSize = 1 USD.
// Therefore openInterest is already USD notional and MUST NOT be multiplied by BTC price.
// Kraken REST ticker "fundingRate" is retained as a raw absolute field.
// Comparable relative funding is pulled from Kraken's public funding analytics when available.
try{
  const j=await getJson("https://futures.kraken.com/derivatives/api/v3/tickers");
  const rows=Array.isArray(j?.tickers)?j.tickers:[];
  const d=rows.find(x=>String(x.symbol||"").toLowerCase()==="pi_xbtusd")
       || rows.find(x=>String(x.symbol||"").toLowerCase().includes("xbtusd"));
  if(!d) throw new Error("Kraken BTC perpetual ticker not found");

  const oiContracts=num(d.openInterest);
  const mark=num(d.markPrice);
  const rawAbsoluteFunding=num(d.fundingRate);
  let relativeFundingPercent=null;
  let relativeFundingSource=null;

  // Kraken's analytics API exposes "relativeRate". Use it only if it parses
  // to a sane relative rate; otherwise Kraken stays in OI but is excluded
  // from the weighted funding calculation rather than poisoning it.
  try{
    const since=Math.floor(Date.now()/1000)-6*3600;
    const a=await getJson(`https://futures.kraken.com/api/charts/v1/analytics/PI_XBTUSD/funding?since=${since}&interval=3600`);
    const rr=lastFiniteDeep(a?.result?.data?.relativeRate);
    if(rr!=null && Math.abs(rr)<=0.01){
      relativeFundingPercent=rr*100;
      relativeFundingSource="Kraken funding analytics relativeRate";
    }
  }catch(_){}

  out.derivatives.venues.kraken={
    status:"ok",
    symbol:d.symbol||"PI_XBTUSD",
    contract_type:"inverse perpetual",
    contract_size_usd:1,
    oi_usd:oiContracts,
    open_interest_contracts:oiContracts,
    mark_price:mark,
    funding_rate_absolute_raw:rawAbsoluteFunding,
    funding_rate_percent:relativeFundingPercent,
    funding_rate_source:relativeFundingSource,
    funding_note:relativeFundingPercent==null
      ?"Kraken retained in OI; REST absolute funding excluded from comparable weighted funding."
      :"Kraken relative funding normalized from public analytics."
  };
  out.sources.kraken_futures="ok";
}catch(e){
  out.derivatives.venues.kraken={status:"error",error:String(e.message||e)};
  out.sources.kraken_futures="error";
}

// Bybit is now optional only; a 403 cannot kill the score.
try{
  const t=await getJson("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT");
  if(t.retCode!==0) throw new Error("Bybit retCode "+t.retCode);
  const d=t.result?.list?.[0]||{};
  out.derivatives.venues.bybit={status:"ok",oi_usd:num(d.openInterestValue),oi_btc:num(d.openInterest),funding_rate_percent:num(d.fundingRate)!=null?num(d.fundingRate)*100:null,mark_price:num(d.markPrice)};
  out.sources.bybit="ok";
}catch(e){out.derivatives.venues.bybit={status:"error",error:String(e.message||e)};out.sources.bybit="error"}

// Aggregate current working venues, while separately exposing a FIXED core set.
// This prevents a venue outage from silently looking like a market OI drop.
const good=Object.entries(out.derivatives.venues).filter(([,v])=>v.status==="ok"&&num(v.oi_usd)>0);
const coreWorking=CORE_DERIVATIVE_VENUES.filter(k=>out.derivatives.venues[k]?.status==="ok"&&num(out.derivatives.venues[k]?.oi_usd)>0);
const coreMissing=CORE_DERIVATIVE_VENUES.filter(k=>!coreWorking.includes(k));

if(good.length>=2){
  const oiUsd=good.reduce((a,[,v])=>a+v.oi_usd,0);
  const fundGood=good.filter(([,v])=>num(v.funding_rate_percent)!=null);
  const fw=fundGood.reduce((a,[,v])=>a+v.oi_usd*v.funding_rate_percent,0);
  const fow=fundGood.reduce((a,[,v])=>a+v.oi_usd,0);

  const coreOiUsd=coreMissing.length===0
    ? CORE_DERIVATIVE_VENUES.reduce((a,k)=>a+out.derivatives.venues[k].oi_usd,0)
    : null;

  out.derivatives.aggregate={
    status:"ok",
    venue_count:good.length,
    venues:good.map(([k])=>k),
    oi_usd:oiUsd,
    funding_rate_percent:fow?fw/fow:null,
    funding_venue_count:fundGood.length,
    funding_venues:fundGood.map(([k])=>k),
    core_expected_venues:CORE_DERIVATIVE_VENUES,
    core_working_venues:coreWorking,
    core_missing_venues:coreMissing,
    core_comparable_status:coreMissing.length===0?"ok":"incomplete",
    core_comparable_oi_usd:coreOiUsd,
    warning:"OI is partial, not global. Compare OI over time only when the fixed core venue set is complete."
  };
}else{
  out.derivatives.aggregate={
    status:"insufficient",
    venue_count:good.length,
    venues:good.map(([k])=>k),
    core_expected_venues:CORE_DERIVATIVE_VENUES,
    core_working_venues:coreWorking,
    core_missing_venues:coreMissing,
    core_comparable_status:"incomplete",
    warning:"Need at least two working venues."
  };
}

// Spot demand proxy: Coinbase + Kraken USD markets vs OKX BTC-USDT,
// with the OKX USDT quote converted to USD using live USDT/USD.
// This removes stablecoin-basis noise from the signal.
try{
  const [cb,kr,ok,cbUsdt,krUsdt]=await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
    getJson("https://api.exchange.coinbase.com/products/USDT-USD/ticker").catch(()=>null),
    getJson("https://api.kraken.com/0/public/Ticker?pair=USDTUSD").catch(()=>null)
  ]);

  const cbp=num(cb.price);
  const krKey=kr?.result?Object.keys(kr.result)[0]:null;
  const krp=krKey?num(kr.result[krKey]?.c?.[0]):null;
  const okUsdt=num(ok.data?.[0]?.last);

  const cbUsdtUsd=num(cbUsdt?.price);
  const krUsdtKey=krUsdt?.result?Object.keys(krUsdt.result)[0]:null;
  const krUsdtUsd=krUsdtKey?num(krUsdt.result[krUsdtKey]?.c?.[0]):null;
  const pegInputs=[cbUsdtUsd,krUsdtUsd].filter(x=>x!=null&&x>0.95&&x<1.05);
  if(!cbp||!krp||!okUsdt||pegInputs.length===0) throw new Error("missing public spot or USDT/USD normalization price");

  const usdtUsd=pegInputs.reduce((a,b)=>a+b,0)/pegInputs.length;
  const okUsdEquivalent=okUsdt*usdtUsd;
  const usdAvg=(cbp+krp)/2;

  out.spot={
    status:"ok",
    source:"Coinbase BTC-USD + Kraken XBT/USD vs USDT-normalized OKX BTC-USDT",
    coinbase_usd:cbp,
    kraken_usd:krp,
    us_spot_average_usd:usdAvg,
    okx_usdt:okUsdt,
    usdt_usd:usdtUsd,
    usdt_usd_sources:[
      ...(cbUsdtUsd!=null?["Coinbase USDT-USD"]:[]),
      ...(krUsdtUsd!=null?["Kraken USDT/USD"]:[])
    ],
    okx_usd_equivalent:okUsdEquivalent,
    us_spot_premium_percent:(usdAvg/okUsdEquivalent-1)*100,
    coinbase_premium_percent:(cbp/okUsdEquivalent-1)*100,
    kraken_premium_percent:(krp/okUsdEquivalent-1)*100,
    note:"OKX BTC-USDT is normalized by live USDT/USD before calculating the premium."
  };
  out.sources.kraken_spot="ok";
  out.sources.spot="ok";
}catch(e){
  out.spot={status:"error",error:String(e.message||e)};
  out.sources.kraken_spot="error";
  out.sources.spot="error";
}

await fs.mkdir(new URL("../data/", import.meta.url),{recursive:true});
await fs.writeFile(OUT,JSON.stringify(out,null,2)+"\n","utf8");
console.log(JSON.stringify({
  generated_at:out.generated_at,
  etf:out.etf.status,
  derivatives:out.derivatives.aggregate.status,
  derivative_venues:out.derivatives.aggregate.venues,
  spot:out.spot.status,
  sources:out.sources
},null,2));
