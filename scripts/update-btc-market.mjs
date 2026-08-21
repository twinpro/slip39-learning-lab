import fs from "node:fs/promises";

const OUT=new URL("../data/btc-market.json",import.meta.url);
const CG=process.env.COINGLASS_API_KEY||"";
const MM_TOKEN=process.env.MACROMICRO_TOKEN||"";
const MM_URL=process.env.MACROMICRO_API_URL||"";

const out={schema:7,generated_at:new Date().toISOString(),coinglass:{},farside:{status:"not_checked"},public_spot:{status:"not_checked"},macromicro:MM_TOKEN&&MM_URL?{status:"not_checked"}:{status:"optional_not_configured"}};

async function getJson(url,headers={}){
  const r=await fetch(url,{headers:{"User-Agent":"btc-real-vs-paper-v7/1.0",...headers}});
  if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
  return await r.json();
}
async function cg(path){
  if(!CG)throw new Error("COINGLASS_API_KEY secret missing");
  const j=await getJson("https://open-api-v4.coinglass.com"+path,{"CG-API-KEY":CG});
  if(String(j.code)!=="0")throw new Error(j.msg||"CoinGlass API error");
  return j.data;
}
const metricError=e=>({status:"error",error:String(e?.message||e),fetched_at:new Date().toISOString()});

// 1) Global futures OI — documented CoinGlass endpoint.
try{
  const rows=await cg("/api/futures/open-interest/exchange-list?symbol=BTC");
  const all=(rows||[]).find(x=>x.exchange==="All");
  if(!all)throw new Error('CoinGlass "All" OI row missing');
  out.coinglass.futures_oi={status:"ok",source:"CoinGlass official API v4",fetched_at:new Date().toISOString(),open_interest_usd:Number(all.open_interest_usd),open_interest_change_percent_24h:Number(all.open_interest_change_percent_24h)};
}catch(e){out.coinglass.futures_oi=metricError(e)}

// 2) Exchange BTC balances — documented CoinGlass endpoint.
try{
  const rows=await cg("/api/exchange/balance/list?symbol=BTC");
  if(!Array.isArray(rows)||!rows.length)throw new Error("empty exchange-balance list");
  out.coinglass.exchange_balance={status:"ok",source:"CoinGlass official API v4",fetched_at:new Date().toISOString(),total_balance_btc:rows.reduce((a,x)=>a+(Number(x.total_balance)||0),0),balance_change_30d_btc:rows.reduce((a,x)=>a+(Number(x.balance_change_30d)||0),0),exchanges:rows.length};
}catch(e){out.coinglass.exchange_balance=metricError(e)}

// 3) U.S. Bitcoin ETF flows — documented CoinGlass endpoint.
try{
  const rows=await cg("/api/etf/bitcoin/flow-history");
  const clean=(Array.isArray(rows)?rows:[]).filter(x=>Number.isFinite(Number(x.timestamp))&&Number.isFinite(Number(x.flow_usd))).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)).slice(-60).map(x=>({timestamp:Number(x.timestamp),flow_usd:Number(x.flow_usd),price_usd:Number(x.price_usd)||null}));
  if(clean.length<5)throw new Error("fewer than 5 ETF rows returned");
  out.coinglass.etf={status:"ok",source:"CoinGlass official API v4",fetched_at:new Date().toISOString(),history:clean};
}catch(e){out.coinglass.etf=metricError(e)}

// 4) Funding — optional. Failure does NOT invalidate OI, ETF, or exchange balance.
try{
  const rows=await cg("/api/futures/pairs-markets?symbol=BTC");
  let weighted=0,oiSum=0;
  for(const p of Array.isArray(rows)?rows:[]){
    const f=Number(p.funding_rate),oi=Number(p.open_interest_usd);
    if(Number.isFinite(f)&&Number.isFinite(oi)&&oi>0){weighted+=f*oi;oiSum+=oi}
  }
  if(!oiSum)throw new Error("no usable BTC futures pairs for funding");
  out.coinglass.funding={status:"ok",source:"CoinGlass official API v4",fetched_at:new Date().toISOString(),oi_weighted_funding_rate_percent:weighted/oiSum,weighted_open_interest_usd:oiSum};
}catch(e){out.coinglass.funding=metricError(e)}

// 5) Public spot proxy: Coinbase BTC-USD vs OKX BTC-USDT. No secret required.
try{
  const [cb,ok]=await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")
  ]);
  const c=Number(cb.price),o=Number(ok?.data?.[0]?.last);
  if(!Number.isFinite(c)||!Number.isFinite(o)||o<=0)throw new Error("unexpected public spot response");
  out.public_spot={status:"ok",source:"Coinbase Exchange + OKX public REST",fetched_at:new Date().toISOString(),coinbase_usd:c,okx_usdt:o,coinbase_premium_bp:(c-o)/o*10000,note:"USDT/USD drift can affect the premium proxy"};
}catch(e){out.public_spot=metricError(e)}

// 6) Farside official Bitcoin ETF table, used as independent cross-check and ETF fallback.
try{
  const r=await fetch("https://farside.co.uk/btc/",{headers:{"User-Agent":"Mozilla/5.0 btc-real-vs-paper-v7"}});
  if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
  const html=await r.text(),rows=[];
  for(const tr of html.match(/<tr[\s\S]*?<\/tr>/gi)||[]){
    const cells=[...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(m=>m[1].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim());
    if(cells.length<2)continue;
    const dm=cells[0].match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);if(!dm)continue;
    const t=Date.parse(`${dm[1]} ${dm[2]} ${dm[3]} UTC`);if(!Number.isFinite(t))continue;
    let last=null;
    for(let i=cells.length-1;i>=1;i--){let s=cells[i].replace(/[,$£€]/g,"").trim();if(/^\(.*\)$/.test(s))s="-"+s.slice(1,-1);if(/^[-+]?\d+(?:\.\d+)?$/.test(s)){last=Number(s)*1e6;break}}
    if(last!=null)rows.push({timestamp:t,flow_usd:last});
  }
  const clean=[...new Map(rows.sort((a,b)=>a.timestamp-b.timestamp).map(x=>[x.timestamp,x])).values()];
  if(clean.length<5)throw new Error("could not parse at least 5 dated Farside rows");
  out.farside={status:"ok",source:"Farside Investors official BTC ETF table",fetched_at:new Date().toISOString(),latest_date:new Date(clean.at(-1).timestamp).toISOString().slice(0,10),rows:clean.slice(-30),flow_5d_usd:clean.slice(-5).reduce((a,x)=>a+x.flow_usd,0)};
}catch(e){out.farside=metricError(e)}

// 7) MacroMicro optional authenticated cross-check.
// Exact URL must come from the user's MacroMicro API account/documentation; V7 never guesses it.
if(MM_TOKEN&&MM_URL){
  try{
    const j=await getJson(MM_URL,{Authorization:`Bearer ${MM_TOKEN}`});
    const candidates=[j?.data,j?.values,j?.series,j?.stats?.data,j?.stat?.data,j];let rows=[];
    for(const a of candidates){
      if(!Array.isArray(a))continue;
      rows=a.map(x=>{if(Array.isArray(x)&&x.length>=2)return{t:Date.parse(x[0])||Number(x[0]),v:Number(x[1])};const ds=x?.date??x?.time??x?.timestamp??x?.x,vs=x?.value??x?.v??x?.y??x?.close;const t=typeof ds==="number"?(ds<1e12?ds*1000:ds):Date.parse(ds);return{t,v:Number(vs)}}).filter(x=>Number.isFinite(x.t)&&Number.isFinite(x.v)).sort((a,b)=>a.t-b.t);
      if(rows.length>=2)break;
    }
    if(rows.length<2)throw new Error("MacroMicro response contained no usable dated series");
    const latest=rows.at(-1),cutoff=latest.t-30*86400e3;let old=rows[0];for(const x of rows){if(x.t<=cutoff)old=x;else break}
    out.macromicro={status:"ok",source:"MacroMicro authenticated API",fetched_at:new Date().toISOString(),latest_balance_btc:latest.v,balance_change_30d_btc:latest.v-old.v,latest_date:new Date(latest.t).toISOString().slice(0,10)};
  }catch(e){out.macromicro=metricError(e)}
}

await fs.mkdir(new URL("../data/",import.meta.url),{recursive:true});
await fs.writeFile(OUT,JSON.stringify(out,null,2)+"\n","utf8");
console.log(JSON.stringify({
  generated_at:out.generated_at,
  oi:out.coinglass.futures_oi?.status,
  balance:out.coinglass.exchange_balance?.status,
  etf:out.coinglass.etf?.status,
  funding:out.coinglass.funding?.status,
  farside:out.farside.status,
  public_spot:out.public_spot.status,
  macromicro:out.macromicro.status
},null,2));
