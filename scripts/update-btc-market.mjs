import fs from "node:fs/promises";

const OUT = new URL("../data/btc-market.json", import.meta.url);
const now = new Date().toISOString();
const out = {
  schema: 8,
  generated_at: now,
  cost: "$0",
  paid_api_keys_required: false,
  sources: {},
  etf: {},
  derivatives: {},
  spot: {},
  exchange_supply: {
    status: "unavailable_free_reliable",
    score: null,
    note: "No reliable free machine-readable all-exchange BTC balance feed was verified. This metric is shown as unknown and excluded from the verdict rather than guessed."
  }
};

async function getText(url){
  const r = await fetch(url,{headers:{"User-Agent":"Mozilla/5.0 btc-real-vs-paper-v8"}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.text();
}
async function getJson(url){
  const r = await fetch(url,{headers:{"User-Agent":"btc-real-vs-paper-v8/1.0"}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.json();
}
const n = x => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

// 1) Farside: official public ETF table, no key.
try{
  const html = await getText("https://farside.co.uk/bitcoin-etf-flow-all-data/");
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
      let s=cells[i].replace(/[,$£€]/g,"").trim();
      if(s==="-"||s==="") continue;
      if(/^\(.*\)$/.test(s)) s="-"+s.slice(1,-1);
      if(/^[-+]?\d+(?:\.\d+)?$/.test(s)){ total=Number(s)*1e6; break; }
    }
    if(total!=null) rows.push({timestamp:ts,flow_usd:total});
  }
  const dedup=[...new Map(rows.map(x=>[x.timestamp,x])).values()].sort((a,b)=>a.timestamp-b.timestamp);
  if(dedup.length<5) throw new Error("Farside parser found fewer than 5 dated rows");
  const last5=dedup.slice(-5);
  out.etf={
    status:"ok",
    source:"Farside Investors",
    fetched_at:now,
    latest_date:new Date(last5.at(-1).timestamp).toISOString().slice(0,10),
    flow_5d_usd:last5.reduce((a,x)=>a+x.flow_usd,0),
    history:dedup.slice(-20)
  };
  out.sources.farside="ok";
}catch(e){
  out.etf={status:"error",error:String(e.message||e)};
  out.sources.farside="error";
}

// 2) Bybit public derivatives API: no key.
try{
  const [ticker, oiHist, fundHist] = await Promise.all([
    getJson("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT"),
    getJson("https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1h&limit=25"),
    getJson("https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=10")
  ]);
  if(ticker.retCode!==0||oiHist.retCode!==0||fundHist.retCode!==0) throw new Error("Bybit returned non-zero retCode");
  const t=ticker.result?.list?.[0]||{};
  const oiList=(oiHist.result?.list||[]).map(x=>({ts:n(x.timestamp),oi_btc:n(x.openInterest)})).filter(x=>x.ts&&x.oi_btc).sort((a,b)=>a.ts-b.ts);
  const newest=oiList.at(-1), old=oiList[0];
  const oi24=(newest&&old&&old.oi_btc)?(newest.oi_btc/old.oi_btc-1)*100:null;
  out.derivatives.bybit={
    status:"ok", oi_usd:n(t.openInterestValue), oi_btc:n(t.openInterest),
    oi_change_24h_percent:oi24, funding_rate_percent:n(t.fundingRate)*100,
    mark_price:n(t.markPrice), turnover_24h_usd:n(t.turnover24h)
  };
  out.sources.bybit="ok";
}catch(e){
  out.derivatives.bybit={status:"error",error:String(e.message||e)};
  out.sources.bybit="error";
}

// 3) OKX public derivatives API: no key. Independent second venue.
try{
  const [oi, fund, ticker] = await Promise.all([
    getJson("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
  ]);
  if(oi.code!=="0"||fund.code!=="0"||ticker.code!=="0") throw new Error("OKX returned non-zero code");
  const o=oi.data?.[0]||{}, f=fund.data?.[0]||{}, t=ticker.data?.[0]||{};
  out.derivatives.okx={
    status:"ok", oi_usd:n(o.oiUsd), oi_btc:n(o.oiCcy),
    funding_rate_percent:n(f.fundingRate)*100,
    last_price:n(t.last), volume_24h_btc:n(t.volCcy24h)
  };
  out.sources.okx="ok";
}catch(e){
  out.derivatives.okx={status:"error",error:String(e.message||e)};
  out.sources.okx="error";
}

// 4) Coinbase + OKX spot price premium as a real-spot demand proxy. Public endpoints, no key.
try{
  const [cb, ok] = await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")
  ]);
  const cbp=n(cb.price), okp=n(ok.data?.[0]?.last);
  if(!cbp||!okp) throw new Error("Missing spot prices");
  out.spot={
    status:"ok",
    source:"Coinbase BTC-USD vs OKX BTC-USDT public tickers",
    coinbase_usd:cbp, okx_usdt:okp,
    coinbase_premium_percent:(cbp/okp-1)*100
  };
  out.sources.spot="ok";
}catch(e){
  out.spot={status:"error",error:String(e.message||e)};
  out.sources.spot="error";
}

// Aggregate free derivatives coverage.
const venues=[out.derivatives.bybit,out.derivatives.okx].filter(x=>x?.status==="ok");
if(venues.length){
  const oiUsd=venues.reduce((a,x)=>a+(x.oi_usd||0),0);
  const weightedFunding=oiUsd ? venues.reduce((a,x)=>a+(x.oi_usd||0)*(x.funding_rate_percent||0),0)/oiUsd : null;
  out.derivatives.aggregate={
    status:"ok",
    coverage:"Bybit BTCUSDT perpetual + OKX BTC-USDT-SWAP",
    oi_usd:oiUsd,
    funding_rate_percent:weightedFunding,
    bybit_oi_change_24h_percent:out.derivatives.bybit?.oi_change_24h_percent ?? null,
    warning:"Partial derivatives coverage. It is not global open interest."
  };
}else{
  out.derivatives.aggregate={status:"error",warning:"No derivatives venue returned usable data."};
}

await fs.mkdir(new URL("../data/", import.meta.url),{recursive:true});
await fs.writeFile(OUT,JSON.stringify(out,null,2)+"\n","utf8");
console.log(JSON.stringify({generated_at:now,sources:out.sources,exchange_supply:out.exchange_supply.status},null,2));
