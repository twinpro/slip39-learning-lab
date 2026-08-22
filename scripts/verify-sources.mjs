/**
 * verify-sources.mjs — hits every real endpoint and reports what actually came back.
 *
 * This exists because the collector's field mappings and contract-unit assumptions
 * were only ever checked against fixtures. Fixtures prove the arithmetic; they cannot
 * prove that a venue still publishes the field, still lists the contract, or still
 * uses the same units. Only a live call does that, and GitHub Actions has a network.
 *
 * Diagnostic only. Writes nothing, and a failure here never blocks a run — it prints
 * so a human can see drift before it becomes a wrong number on the page.
 *
 * Run locally:  node scripts/verify-sources.mjs
 */

const TIMEOUT = 20000;
const pad = (s, n) => String(s).padEnd(n);
const money = v => v == null ? "-" : "$" + (v / 1e9).toFixed(4) + "B";

async function get(url, opts = {}){
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try{
    const r = await fetch(url, { ...opts, signal:c.signal,
      headers:{ "User-Agent":"Mozilla/5.0 (compatible; btc-real-vs-paper/10)", "Accept":"*/*", ...(opts.headers||{}) }});
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    return { ok:r.ok, status:r.status, json, body };
  } finally { clearTimeout(t); }
}

const results = [];
const rec = (name, o) => results.push({ name, ...o });

/* ---------------- derivatives ---------------- */

async function probeKraken(){
  const r = await get("https://futures.kraken.com/derivatives/api/v3/tickers");
  if (!r.ok || !r.json) return rec("kraken", { status:"error", detail:`HTTP ${r.status}` });
  const rows = Array.isArray(r.json.tickers) ? r.json.tickers : [];
  const syms = rows.map(x => String(x.symbol||"").toUpperCase());
  const pf = rows.find(x => String(x.symbol||"").toUpperCase() === "PF_XBTUSD");
  const pi = rows.find(x => String(x.symbol||"").toUpperCase() === "PI_XBTUSD");

  const detail = [];
  detail.push(`PF_XBTUSD ${pf ? "present" : "ABSENT"}`);
  detail.push(`PI_XBTUSD ${pi ? "present" : "ABSENT"}`);
  const xbt = syms.filter(s => s.includes("XBTUSD"));
  detail.push(`all XBTUSD symbols: ${xbt.join(", ") || "none"}`);

  let oi = null, implied = null, contract = null;
  if (pf && Number.isFinite(pf.openInterest) && Number.isFinite(pf.markPrice)){
    oi = pf.openInterest * pf.markPrice; implied = oi / pf.markPrice; contract = "PF (linear, x mark)";
    detail.push(`PF raw openInterest=${pf.openInterest} markPrice=${pf.markPrice}`);
  } else if (pi && Number.isFinite(pi.openInterest)){
    oi = pi.openInterest; implied = pi.markPrice ? oi / pi.markPrice : null; contract = "PI (inverse, no multiply)";
    detail.push(`PI raw openInterest=${pi.openInterest} markPrice=${pi.markPrice}`);
  }
  const fundingFields = pf ? Object.keys(pf).filter(k => /fund/i.test(k)) : [];
  detail.push(`funding fields on PF: ${fundingFields.join(", ") || "none"}`);
  detail.push(`relative_funding_rate present: ${pf && "relativeFundingRate" in pf ? "YES" : "no"}`);

  rec("kraken", { status: oi != null ? "ok" : "error", oi_usd:oi, implied_btc:implied,
                  contract, detail: detail.join(" | ") });
}

async function probeOkx(){
  const [oi, tick] = await Promise.all([
    get("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP"),
    get("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
  ]);
  const d = oi.json?.data?.[0], t = tick.json?.data?.[0];
  if (!d) return rec("okx", { status:"error", detail:`HTTP ${oi.status} ${oi.body.slice(0,80)}` });
  const mark = Number(t?.last);
  const oiUsd = Number(d.oiUsd) || (Number(d.oiCcy) * mark);
  rec("okx", { status:"ok", oi_usd:oiUsd, implied_btc: mark ? oiUsd/mark : null,
               contract:"BTC-USDT-SWAP",
               detail:`fields: ${Object.keys(d).join(",")} | oiUsd ${d.oiUsd ? "present" : "ABSENT (fell back to oiCcy x last)"}` });
}

async function probeDeribit(){
  const r = await get("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
  const d = r.json?.result;
  if (!d) return rec("deribit", { status:"error", detail:`HTTP ${r.status}` });
  const oi = Number(d.open_interest), mark = Number(d.mark_price);
  rec("deribit", { status:"ok", oi_usd:oi, implied_btc: mark ? oi/mark : null, contract:"BTC-PERPETUAL",
                   detail:`open_interest=${oi} mark=${mark} funding_8h=${d.funding_8h} | assumed USD units` });
}

async function probeBitmex(){
  const r = await get("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&columns=openInterest,fundingRate,markPrice");
  const d = Array.isArray(r.json) ? r.json[0] : null;
  if (!d) return rec("bitmex", { status:"error", detail:`HTTP ${r.status} ${r.body.slice(0,80)}` });
  const oi = Number(d.openInterest), mark = Number(d.markPrice);
  rec("bitmex", { status:"ok", oi_usd:oi, implied_btc: mark ? oi/mark : null, contract:"XBTUSD inverse",
                  detail:`openInterest=${oi} markPrice=${mark} fundingRate=${d.fundingRate} | assumed USD units` });
}

async function probeHyperliquid(){
  const r = await get("https://api.hyperliquid.xyz/info", { method:"POST",
    headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ type:"metaAndAssetCtxs" }) });
  const j = r.json;
  const i = j?.[0]?.universe?.findIndex(x => x.name === "BTC");
  if (i == null || i < 0) return rec("hyperliquid", { status:"error", detail:`HTTP ${r.status}, BTC not in universe` });
  const d = j[1][i], mark = Number(d.markPx), oiBtc = Number(d.openInterest);
  rec("hyperliquid", { status:"ok", oi_usd: mark*oiBtc, implied_btc: oiBtc, contract:"BTC perp linear",
                       detail:`ctx fields: ${Object.keys(d).join(",")} | openInterest=${oiBtc} (BTC) markPx=${mark}` });
}

async function probeBybit(){
  const r = await get("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT");
  const d = r.json?.result?.list?.[0];
  if (!d) return rec("bybit", { status:"error", detail:`HTTP ${r.status} — expected on US-hosted runners` });
  const oi = Number(d.openInterestValue), mark = Number(d.markPrice);
  rec("bybit", { status:"ok", oi_usd:oi, implied_btc: mark ? oi/mark : null, contract:"BTCUSDT linear",
                 detail:`openInterestValue=${oi} openInterest=${d.openInterest} markPrice=${mark}` });
}

async function probeCme(){
  const r = await get("https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/8756/G");
  if (!r.ok || !r.json) return rec("cme", { status:"error", detail:`HTTP ${r.status} — CME blocks most non-browser clients; expected` });
  const q = Array.isArray(r.json.quotes) ? r.json.quotes : [];
  rec("cme", { status: q.length ? "ok" : "error", contract:"BTC futures",
               detail:`quotes=${q.length} first keys: ${q[0] ? Object.keys(q[0]).slice(0,12).join(",") : "none"}` });
}

/* ---------------- spot + peg ---------------- */

async function probeSpot(){
  const [cb, kr, ok, peg] = await Promise.all([
    get("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    get("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
    get("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
    get("https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT")
  ]);
  const krKey = kr.json?.result ? Object.keys(kr.json.result)[0] : null;
  const cbP = Number(cb.json?.price);
  const krP = krKey ? Number(kr.json.result[krKey]?.c?.[0]) : NaN;
  const okP = Number(ok.json?.data?.[0]?.last);
  const pg  = Number(peg.json?.data?.[0]?.last);
  const have = [cbP,krP,okP].every(Number.isFinite);
  const n = v => Number.isFinite(v) ? v : "-";
  if (!have) return rec("spot", { status:"error",
    detail:`coinbase=${n(cbP)} kraken=${n(krP)} okx_usdt=${n(okP)} usdc_usdt=${n(pg)} | one or more spot prices unavailable` });
  const raw = ((cbP+krP)/2 / okP - 1) * 100;
  const adj = pg > 0.97 && pg < 1.03 ? ((cbP+krP)/2 / (okP * (1/pg)) - 1) * 100 : null;
  rec("spot", { status:"ok",
    detail:`coinbase=${cbP} kraken=${krP} okx_usdt=${okP} usdc_usdt=${n(pg)} | raw ${raw.toFixed(4)}% ` +
           `adjusted ${adj==null ? "UNAVAILABLE (peg quote missing or implausible)" : adj.toFixed(4)+"%"}` });
}

async function probeFarside(){
  const r = await get("https://farside.co.uk/btc");
  const dated = (r.body.match(/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/g) || []).length;
  rec("farside", { status: r.ok && dated >= 5 ? "ok" : "error",
                   detail:`HTTP ${r.status}, ${dated} dated rows found, ${r.body.length} bytes` });
}

async function probeSoso(){
  const key = process.env.SOSOVALUE_API_KEY || "";
  if (!key) return rec("sosovalue", { status:"skipped", detail:"SOSOVALUE_API_KEY not set — Farside carries the ETF row" });
  const r = await get("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart", { method:"POST",
    headers:{ "Content-Type":"application/json", "x-soso-api-key":key }, body: JSON.stringify({ type:"us-btc-spot" }) });
  const j = r.json;
  const list = j?.data?.list;
  rec("sosovalue", { status: Number(j?.code) === 0 && Array.isArray(list) ? "ok" : "error",
    detail:`code=${j?.code} msg=${j?.msg ?? "-"} list=${Array.isArray(list) ? list.length+" rows" : "absent"} ` +
           `first item keys: ${Array.isArray(list) && list[0] ? Object.keys(list[0]).slice(0,10).join(",") : "-"}` });
}

/* ---------------- run ---------------- */

await Promise.allSettled([
  probeKraken(), probeOkx(), probeDeribit(), probeBitmex(), probeHyperliquid(),
  probeBybit(), probeCme(), probeSpot(), probeFarside(), probeSoso()
]);

console.log("\nLIVE SOURCE VERIFICATION — " + new Date().toISOString());
console.log("=".repeat(112));
console.log(pad("SOURCE",13) + pad("STATUS",9) + pad("OI (USD)",14) + pad("IMPLIED BTC",14) + "CONTRACT");
console.log("-".repeat(112));
for (const r of results.sort((a,b) => a.name.localeCompare(b.name))){
  console.log(pad(r.name,13) + pad(r.status,9) + pad(money(r.oi_usd),14) +
              pad(r.implied_btc == null ? "-" : r.implied_btc.toFixed(1), 14) + (r.contract || ""));
}
console.log("-".repeat(112));
console.log("\nDETAIL");
for (const r of results.sort((a,b) => a.name.localeCompare(b.name))) console.log(`  ${pad(r.name,13)} ${r.detail || ""}`);

const withOi = results.filter(r => r.implied_btc != null);
const bad = withOi.filter(r => r.implied_btc < 0.5 || r.implied_btc > 2_000_000);
console.log("\nUNIT CHECK");
if (!withOi.length) console.log("  No venue reported open interest, so nothing could be unit-checked.");
else if (bad.length) console.log("  WRONG UNITS: " + bad.map(r => `${r.name} implies ${r.implied_btc.toExponential(2)} BTC`).join("; "));
else console.log(`  All ${withOi.length} reporting venues imply a plausible quantity of BTC. Contract units look correct.`);

const okCount = results.filter(r => r.status === "ok").length;
console.log(`\n${okCount}/${results.length} sources responded.\n`);
