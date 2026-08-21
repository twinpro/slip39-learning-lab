import fs from "node:fs/promises";

const OUT = new URL("../data/btc-market.json", import.meta.url);
const NOW = new Date();
const ISO = NOW.toISOString();
const MAX_ETF_CALENDAR_AGE_DAYS = 10;

const out = {
  schema: 9,
  generated_at: ISO,
  cost: "$0",
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
function acceptEtf(rows,source){
  if(!Array.isArray(rows)||rows.length<5) return false;

  const clean=rows
    .filter(x=>Number.isFinite(x.timestamp)&&Number.isFinite(x.flow_usd))
    .sort((a,b)=>a.timestamp-b.timestamp);

  if(clean.length<5) return false;

  const latest=clean.at(-1);
  const age=ageDays(latest.timestamp);

  // ETF markets do not trade on weekends/market holidays.
  // Use a wider calendar-age safety window so valid Friday/holiday data
  // is not falsely rejected as stale. The exact latest date is always
  // written into the JSON for transparency.
  if(age>MAX_ETF_CALENDAR_AGE_DAYS) return false;

  const last5=clean.slice(-5);
  out.etf={
    status:"ok",
    source,
    fetched_at:ISO,
    latest_date:new Date(latest.timestamp).toISOString().slice(0,10),
    latest_age_days:+age.toFixed(2),
    row_count:clean.length,
    flow_5d_usd:last5.reduce((a,x)=>a+x.flow_usd,0),
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
try{
  const j=await getJson("https://futures.kraken.com/derivatives/api/v3/tickers");
  const rows=Array.isArray(j?.tickers)?j.tickers:[];
  // Prefer the perpetual BTC/USD contract.
  const d=rows.find(x=>String(x.symbol||"").toLowerCase()==="pi_xbtusd")
       || rows.find(x=>String(x.symbol||"").toLowerCase().includes("xbtusd"));
  if(!d) throw new Error("Kraken BTC perpetual ticker not found");

  const oiContracts=num(d.openInterest);
  const mark=num(d.markPrice);
  const oiUsd=(oiContracts!=null && mark!=null)?oiContracts*mark:null;

  out.derivatives.venues.kraken={
    status:"ok",
    symbol:d.symbol||"PI_XBTUSD",
    oi_usd:oiUsd,
    open_interest_contracts:oiContracts,
    funding_rate_percent:num(d.fundingRate)!=null?num(d.fundingRate)*100:null,
    mark_price:mark
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

// Aggregate only venues that actually returned data. This is explicitly PARTIAL OI,
// never labeled global OI.
const good=Object.entries(out.derivatives.venues).filter(([,v])=>v.status==="ok"&&num(v.oi_usd)>0);
if(good.length>=2){
  const oiUsd=good.reduce((a,[,v])=>a+v.oi_usd,0);
  const fundGood=good.filter(([,v])=>num(v.funding_rate_percent)!=null);
  const fw=fundGood.reduce((a,[,v])=>a+v.oi_usd*v.funding_rate_percent,0);
  const fow=fundGood.reduce((a,[,v])=>a+v.oi_usd,0);
  out.derivatives.aggregate={
    status:"ok",
    venue_count:good.length,
    venues:good.map(([k])=>k),
    oi_usd:oiUsd,
    funding_rate_percent:fow?fw/fow:null,
    warning:"Free partial derivatives coverage; not global open interest."
  };
}else{
  out.derivatives.aggregate={status:"insufficient",venue_count:good.length,venues:good.map(([k])=>k),warning:"Need at least two working venues."};
}

// Spot demand proxy: Coinbase + Kraken USD markets vs OKX BTC-USDT.
// All endpoints are public. No account/API key is used.
try{
  const [cb,kr,ok]=await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")
  ]);

  const cbp=num(cb.price);
  const krKey=kr?.result?Object.keys(kr.result)[0]:null;
  const krp=krKey?num(kr.result[krKey]?.c?.[0]):null;
  const okp=num(ok.data?.[0]?.last);

  if(!cbp||!krp||!okp) throw new Error("missing public spot price");

  const usdAvg=(cbp+krp)/2;
  out.spot={
    status:"ok",
    source:"Coinbase BTC-USD + Kraken XBT/USD vs OKX BTC-USDT",
    coinbase_usd:cbp,
    kraken_usd:krp,
    us_spot_average_usd:usdAvg,
    okx_usdt:okp,
    us_spot_premium_percent:(usdAvg/okp-1)*100,
    coinbase_premium_percent:(cbp/okp-1)*100,
    kraken_premium_percent:(krp/okp-1)*100
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
