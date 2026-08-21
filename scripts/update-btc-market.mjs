import fs from "node:fs/promises";

const OUT = new URL("../data/btc-market.json", import.meta.url);
const NOW = new Date();
const ISO = NOW.toISOString();
const MAX_ETF_AGE_DAYS = 5;

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
function parseFarsideHtml(html){
  const rows=[];
  for(const tr of html.match(/<tr[\s\S]*?<\/tr>/gi)||[]){
    const cells=[...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map(m=>m[1].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim());
    if(cells.length<2) continue;
    const dm=cells[0].match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
    if(!dm) continue;
    const ts=Date.parse(`${dm[1]} ${dm[2]} ${dm[3]} UTC`);
    if(!Number.isFinite(ts)) continue;
    let total=null;
    for(let i=cells.length-1;i>=1;i--){
      let s=cells[i].replace(/[,$£€]/g,"").replace("−","-").trim();
      if(s===""||s==="-"||s==="—") continue;
      if(/^\(.*\)$/.test(s)) s="-"+s.slice(1,-1);
      if(/^[-+]?\d+(?:\.\d+)?$/.test(s)){total=Number(s)*1e6;break;}
    }
    if(total!=null) rows.push({timestamp:ts,flow_usd:total});
  }
  return [...new Map(rows.map(x=>[x.timestamp,x])).values()].sort((a,b)=>a.timestamp-b.timestamp);
}
function parseSimpleEtfCsv(csv){
  const rows=[];
  for(const line of csv.split(/\r?\n/)){
    if(!line.trim()||/^date/i.test(line)||line.startsWith("#")) continue;
    const c=line.split(",").map(x=>x.trim().replace(/^"|"$/g,""));
    const ts=Date.parse(c[0]);
    if(!Number.isFinite(ts)) continue;
    // known mirror format: Date, Total Flow (in millions USD), Type
    let m=Number(c[1]);
    if(!Number.isFinite(m)) continue;
    if((c[2]||"").toLowerCase().includes("outflow") && m>0) m=-m;
    rows.push({timestamp:ts,flow_usd:m*1e6});
  }
  return [...new Map(rows.map(x=>[x.timestamp,x])).values()].sort((a,b)=>a.timestamp-b.timestamp);
}
function acceptEtf(rows,source){
  if(!Array.isArray(rows)||rows.length<5) return false;
  const latest=rows.at(-1);
  if(ageDays(latest.timestamp)>MAX_ETF_AGE_DAYS) return false;
  const last5=rows.slice(-5);
  out.etf={
    status:"ok",source,fetched_at:ISO,
    latest_date:new Date(latest.timestamp).toISOString().slice(0,10),
    latest_age_days:+ageDays(latest.timestamp).toFixed(2),
    flow_5d_usd:last5.reduce((a,x)=>a+x.flow_usd,0),
    history:rows.slice(-25)
  };
  return true;
}

// ETF source chain.
// #1 Farside official page.
// #2 public GitHub mirror of Farside totals, accepted ONLY if current.
// If neither is fresh, ETF remains unavailable. No stale seed is used.
try{
  const html=await getText("https://farside.co.uk/bitcoin-etf-flow-all-data/");
  const rows=parseFarsideHtml(html);
  if(!acceptEtf(rows,"Farside Investors official table")) throw new Error("Farside parsed data stale or incomplete");
  out.sources.farside="ok";
}catch(e){
  out.sources.farside="error: "+String(e.message||e);
}
if(out.etf.status!=="ok"){
  try{
    const csv=await getText("https://raw.githubusercontent.com/0xLearn2Earn/btc-etf-flows/main/data/BTC_ETF_INFLOWS_OUTFLOWS.csv");
    const rows=parseSimpleEtfCsv(csv);
    if(!acceptEtf(rows,"Public GitHub mirror of Farside daily totals")) throw new Error("mirror stale or incomplete");
    out.sources.etf_mirror="ok";
  }catch(e){
    out.sources.etf_mirror="error: "+String(e.message||e);
  }
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

// Spot demand proxy: Coinbase BTC-USD vs OKX BTC-USDT.
try{
  const [cb,ok]=await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")
  ]);
  const cbp=num(cb.price),okp=num(ok.data?.[0]?.last);
  if(!cbp||!okp) throw new Error("missing spot price");
  out.spot={status:"ok",source:"Coinbase BTC-USD vs OKX BTC-USDT",coinbase_usd:cbp,okx_usdt:okp,coinbase_premium_percent:(cbp/okp-1)*100};
  out.sources.spot="ok";
}catch(e){out.spot={status:"error",error:String(e.message||e)};out.sources.spot="error"}

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
