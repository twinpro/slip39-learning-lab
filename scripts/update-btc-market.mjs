import fs from "node:fs/promises";

/* ============================================================================
   BTC real-vs-paper collector.

   Runs in GitHub Actions, writes data/btc-market.json and appends to
   data/btc-history.json. Every source failure is recorded, never hidden, and
   never silently replaced with a neutral value.

   Unit conventions, which are the thing most likely to go wrong:
     - INVERSE contracts (1 contract = 1 USD): openInterest IS USD notional.
         BitMEX XBTUSD, Kraken PI_XBTUSD
     - LINEAR contracts (1 contract = 1 BTC or base units): multiply by mark.
         Kraken PF_XBTUSD, Hyperliquid
     - Venues that publish USD directly: use it.
         OKX oiUsd, Deribit open_interest, Bybit openInterestValue
   Getting this backwards inflates a venue by roughly the BTC price, so every
   venue is additionally checked by plausibilityFilter() before it can be
   aggregated.
   ========================================================================== */

export const SCHEMA = 10;

const MAX_ETF_AGE_DAYS   = 4;        // covers a Friday print read on Tuesday after a holiday
const MAX_ETF_5D_SPAN    = 9;        // 5 trading days should never span more than ~9 calendar days
const ETF_DAILY_SANITY   = 2.5e10;   // a single day's net flow above $25B is a unit error, not news
const ETF_MIN_MAGNITUDE  = 1e6;      // if every row is tiny, the feed is in millions, not dollars
const VENUE_OI_MAX       = 1.5e11;   // no single venue holds $150B of BTC OI
const VENUE_OI_MIN       = 1e7;      // below $10M is a broken read, not a venue
const VENUE_OI_RATIO_MAX = 12;       // a venue >12x the median of the others is a unit bug
const IMPLIED_BTC_MIN    = 0.5;      // dimensional check: oi_usd / mark must look like BTC
const IMPLIED_BTC_MAX    = 2_000_000;// ~19.9M BTC exist; no single venue holds a tenth of it
const MARK_DEVIATION_PCT = 5;        // venues quoting >5% off the median mark are suspect
const HISTORY_CAP        = 3000;
const FUNDING_SANITY_PCT = 5;        // |8h funding| above 5% is a unit error

export const num = x => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const iso = t => new Date(t).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- helpers */

export function median(a){
  const v = a.filter(Number.isFinite).slice().sort((p,q)=>p-q);
  if(!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m-1] + v[m]) / 2;
}

/**
 * Rejects venues whose open interest is structurally implausible. This is the
 * safety net for unit mistakes: it caught nothing on the day it was written and
 * exists so the next wrong multiply cannot reach the score.
 */
export function plausibilityFilter(venues){
  const named = Object.entries(venues).filter(([,v]) => v.status === "ok" && num(v.oi_usd) != null);
  const rejected = [];

  /* Dimensional check. oi_usd divided by that venue's own mark price must come out
     looking like a quantity of bitcoin. This is absolute, not relative: it catches a
     wrong multiply even when a venue is the only one reporting, which the ratio test
     below cannot. A contract-unit error moves this by roughly the BTC price. */
  for (const [k, v] of named){
    const mark = num(v.mark_price);
    if (mark == null || mark <= 0) continue;
    const implied = v.oi_usd / mark;
    v.implied_btc = +implied.toFixed(2);
    if (implied < IMPLIED_BTC_MIN || implied > IMPLIED_BTC_MAX){
      v.status = "rejected";
      v.rejected_reason = `oi_usd / mark_price = ${implied.toExponential(3)} BTC, outside ` +
                          `${IMPLIED_BTC_MIN}..${IMPLIED_BTC_MAX} — the contract units are wrong`;
      rejected.push(k);
    }
  }

  for (const [k, v] of named){
    if (v.status !== "ok") continue;   // the dimensional check above already diagnosed it, and more precisely
    if (v.oi_usd > VENUE_OI_MAX || v.oi_usd < VENUE_OI_MIN){
      v.status = "rejected";
      v.rejected_reason = `oi_usd ${v.oi_usd.toExponential(3)} outside plausible band ` +
                          `${VENUE_OI_MIN.toExponential(0)}..${VENUE_OI_MAX.toExponential(0)}`;
      rejected.push(k);
    }
  }

  const still = Object.entries(venues).filter(([,v]) => v.status === "ok" && num(v.oi_usd) != null);
  if (still.length >= 3){
    for (const [k, v] of still){
      const others = still.filter(([j]) => j !== k).map(([,o]) => o.oi_usd);
      const med = median(others);
      if (med && v.oi_usd / med > VENUE_OI_RATIO_MAX){
        v.status = "rejected";
        v.rejected_reason = `oi_usd is ${(v.oi_usd/med).toFixed(0)}x the median of the other venues ` +
                            `(${med.toExponential(3)}) — almost certainly a contract-unit error`;
        rejected.push(k);
      }
    }
  }

  /* Mark-price consensus. A venue quoting far from the others is probably the wrong
     instrument. Recorded, not rejected: index methodologies legitimately differ. */
  const marks = Object.entries(venues)
    .filter(([,v]) => v.status === "ok" && num(v.mark_price) > 0).map(([,v]) => v.mark_price);
  const markMed = median(marks);
  if (markMed){
    for (const [,v] of Object.entries(venues)){
      if (v.status !== "ok" || !(num(v.mark_price) > 0)) continue;
      const dev = (v.mark_price / markMed - 1) * 100;
      v.mark_deviation_percent = +dev.toFixed(3);
      if (Math.abs(dev) > MARK_DEVIATION_PCT)
        v.mark_warning = `mark price is ${dev.toFixed(1)}% from the ${markMed} median — possibly the wrong instrument`;
    }
  }

  for (const [,v] of Object.entries(venues)){
    if (v.status === "ok" && num(v.funding_rate_percent) != null &&
        Math.abs(v.funding_rate_percent) > FUNDING_SANITY_PCT){
      v.funding_rejected_reason = `|funding| ${v.funding_rate_percent}% exceeds ${FUNDING_SANITY_PCT}% — unit error`;
      v.funding_rate_percent = null;
    }
  }
  return rejected;
}

export function aggregate(venues){
  const good = Object.entries(venues)
    .filter(([,v]) => v.status === "ok" && num(v.oi_usd) > 0 && v.include_in_aggregate !== false);

  if (good.length < 2){
    return { status:"insufficient", venue_count:good.length, venues:good.map(([k])=>k),
             warning:"Need at least two working venues." };
  }
  const oi = good.reduce((a,[,v]) => a + v.oi_usd, 0);
  const fg = good.filter(([,v]) => num(v.funding_rate_percent) != null);
  const fw = fg.reduce((a,[,v]) => a + v.oi_usd * v.funding_rate_percent, 0);
  const fo = fg.reduce((a,[,v]) => a + v.oi_usd, 0);

  return {
    status:"ok",
    venue_count: good.length,
    venues: good.map(([k]) => k).sort(),
    venue_set: good.map(([k]) => k).sort().join("+"),
    oi_usd: oi,
    funding_rate_percent: fo ? fw / fo : null,
    funding_venue_count: fg.length,
    warning: "Partial free coverage. Binance and CME are absent, so this is NOT global open interest. " +
             "The venue set can change between runs; compare oi_usd only within the same venue_set."
  };
}

/** SoSoValue ships several response shapes; pull rows out of whichever one arrived. */
export function sosoRows(j){
  const lists = [j?.data?.list, j?.data, j?.list, j?.result?.list, j?.result];
  for (const a of lists){
    if (!Array.isArray(a)) continue;
    const rows = a.map(x => {
      const raw = x?.date ?? x?.timestamp ?? x?.time ?? "";
      const t = typeof raw === "number" ? raw
              : /^\d{10,13}$/.test(String(raw)) ? Number(String(raw).padEnd(13,"0"))
              : Date.parse(String(raw) + "T00:00:00Z");
      return { timestamp:t, flow_usd:num(x?.totalNetInflow ?? x?.dailyNetInflow ?? x?.netInflow ?? x?.flow_usd) };
    }).filter(x => Number.isFinite(x.timestamp) && x.flow_usd != null);
    if (rows.length) return rows.sort((a,b) => a.timestamp - b.timestamp);
  }
  return [];
}

/** farside.co.uk HTML table -> rows. Last number on a dated line is the daily total. */
export function farsideRows(text){
  const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const flat = text.replace(/<\/(tr|div|p)>/gi, "\n").replace(/<[^>]+>/g, " ");
  const out = [];
  for (const line of flat.split(/\r?\n/)){
    const d = line.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (!d) continue;
    const mo = MON[d[2].toLowerCase()];
    if (mo === undefined) continue;
    const toks = line.slice(d.index + d[0].length).match(/\(?-?[\d,]+\.?\d*\)?/g);
    if (!toks) continue;
    const nums = toks.map(t => t.replace(/,/g,"")).filter(t => /\d/.test(t))
      .map(t => t.startsWith("(") ? -parseFloat(t.replace(/[()]/g,"")) : parseFloat(t))
      .filter(Number.isFinite);
    if (!nums.length) continue;
    out.push({ timestamp: Date.UTC(+d[3], mo, +d[1]), flow_usd: nums.at(-1) * 1e6 });
  }
  out.sort((a,b) => a.timestamp - b.timestamp);
  return [...new Map(out.map(r => [r.timestamp, r])).values()];
}

/**
 * Validates an ETF series and builds the etf block. Rejects on staleness, on a
 * five-day window that spans too many calendar days, and on magnitudes that
 * indicate the feed switched units.
 */
export function buildEtf(rows, source, nowMs = Date.now()){
  const clean = (rows||[]).filter(x => Number.isFinite(x.timestamp) && Number.isFinite(x.flow_usd))
                          .sort((a,b) => a.timestamp - b.timestamp);
  if (clean.length < 5) return { ok:false, error:`only ${clean.length} usable rows` };

  const latest = clean.at(-1);
  const age = (nowMs - latest.timestamp) / 86400000;
  if (age > MAX_ETF_AGE_DAYS) return { ok:false, error:`latest row ${iso(latest.timestamp)} is ${age.toFixed(1)}d old (max ${MAX_ETF_AGE_DAYS})` };
  if (age < -1)               return { ok:false, error:`latest row ${iso(latest.timestamp)} is in the future` };

  const last5 = clean.slice(-5);
  const span = (last5.at(-1).timestamp - last5[0].timestamp) / 86400000;
  if (span > MAX_ETF_5D_SPAN) return { ok:false, error:`last 5 rows span ${span.toFixed(0)} calendar days (max ${MAX_ETF_5D_SPAN}) — series has gaps` };

  const mags = clean.slice(-20).map(r => Math.abs(r.flow_usd)).filter(v => v > 0);
  const peak = mags.length ? Math.max(...mags) : 0;
  if (peak > ETF_DAILY_SANITY) return { ok:false, error:`daily flow ${peak.toExponential(2)} exceeds sanity cap — wrong units` };
  if (peak > 0 && peak < ETF_MIN_MAGNITUDE) return { ok:false, error:`largest recent daily flow is only ${peak} — feed appears to be in millions, not dollars` };

  return {
    ok: true,
    block: {
      status:"ok", source,
      latest_date: iso(latest.timestamp),
      latest_age_days: +age.toFixed(2),
      row_count: clean.length,
      flow_5d_usd: last5.reduce((a,x) => a + x.flow_usd, 0),
      flow_5d_span_days: +span.toFixed(1),
      last_5_trading_days: last5.map(x => ({ date: iso(x.timestamp), flow_usd: x.flow_usd })),
      history: clean.slice(-40)
    }
  };
}

/**
 * Coinbase+Kraken USD vs OKX USDT contains USD demand AND Tether's peg drift,
 * and the peg term is the same order of magnitude as the signal. USDC-USDT
 * gives the peg, so it can be divided out and both figures reported.
 */
export function premiumBlock({ cbUsd, krUsd, okxUsdt, usdcUsdt }){
  if (!cbUsd || !krUsd || !okxUsdt) return { status:"error", error:"missing public spot price" };
  const usdAvg = (cbUsd + krUsd) / 2;
  const raw = (usdAvg / okxUsdt - 1) * 100;

  let pegOk = usdcUsdt != null && usdcUsdt > 0.97 && usdcUsdt < 1.03;
  const usdtUsd = pegOk ? 1 / usdcUsdt : null;         // USDC treated as the dollar reference
  const adjusted = pegOk ? (usdAvg / (okxUsdt * usdtUsd) - 1) * 100 : null;

  return {
    status:"ok",
    source:"Coinbase BTC-USD + Kraken XBT/USD vs OKX BTC-USDT, Tether peg removed via OKX USDC-USDT",
    coinbase_usd: cbUsd, kraken_usd: krUsd, us_spot_average_usd: usdAvg, okx_usdt: okxUsdt,
    usdc_usdt: usdcUsdt ?? null,
    usdt_usd: usdtUsd,
    peg_adjustment_percent: pegOk ? +(raw - adjusted).toFixed(4) : null,
    us_spot_premium_percent_raw: +raw.toFixed(4),
    us_spot_premium_percent: pegOk ? +adjusted.toFixed(4) : null,
    premium_status: pegOk ? "peg_adjusted"
      : (usdcUsdt == null ? "unadjusted_no_peg_quote" : "unadjusted_peg_quote_implausible"),
    note: pegOk
      ? "Premium is net of Tether drift. Compare only the peg-adjusted figure."
      : "Peg quote unavailable or implausible, so only the raw figure exists and it still contains Tether drift. Not scored."
  };
}

/* ------------------------------------------------------------------ fetch */

function makeFetcher(fetchImpl){
  return async function fetchAny(url, opts = {}){
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 20000);
    try{
      const r = await fetchImpl(url, {
        ...opts, signal:c.signal,
        headers:{ "User-Agent":"Mozilla/5.0 (compatible; btc-real-vs-paper/10)", "Accept":"*/*", ...(opts.headers||{}) }
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r;
    } finally { clearTimeout(timer); }
  };
}

/* ---------------------------------------------------------------- collect */

export async function collect({ fetchImpl = fetch, sosoKey = "", nowMs = Date.now() } = {}){
  const fetchAny = makeFetcher(fetchImpl);
  const getJson = async (u,o) => (await fetchAny(u,o)).json();
  const getText = async (u,o) => (await fetchAny(u,o)).text();

  const out = {
    schema: SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    cost: "$0 in fees",
    api_key_required: !!sosoKey || "SoSoValue free key for the primary ETF source; Farside fallback needs none",
    sources: {},
    etf: { status:"unavailable" },
    derivatives: { venues:{}, aggregate:{ status:"unavailable" } },
    spot: { status:"unavailable" },
    exchange_supply: {
      status:"unavailable_free_reliable", score:null,
      note:"No verified free machine-readable all-exchange BTC balance feed. Cold-wallet address baskets measure storage, not flow, and are excluded deliberately. Unscored."
    }
  };

  /* ---- ETF: SoSoValue primary, Farside independent cross-check ---- */
  const etfCandidates = [];

  if (sosoKey){
    const attempts = [
      ["v2","https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart",{type:"us-btc-spot"}],
      ["v1","https://api.sosovalue.xyz/openapi/v1/etf/us-btc-spot/historicalInflowChart",{}]
    ];
    for (const [ver, url, body] of attempts){
      try{
        const j = await getJson(url,{ method:"POST",
          headers:{ "Content-Type":"application/json", "x-soso-api-key":sosoKey },
          body: JSON.stringify(body) });
        if (Number(j?.code) !== 0) throw new Error(j?.msg || `SoSoValue ${ver} non-zero code`);
        const rows = sosoRows(j);
        if (rows.length >= 5){ etfCandidates.push({ name:`SoSoValue ${ver}`, rows }); out.sources[`sosovalue_${ver}`] = "ok"; break; }
        out.sources[`sosovalue_${ver}`] = `error: returned ${rows.length} usable rows`;
      }catch(e){ out.sources[`sosovalue_${ver}`] = "error: " + String(e.message || e); }
    }
  } else {
    out.sources.sosovalue = "skipped: SOSOVALUE_API_KEY not set";
  }

  try{
    const rows = farsideRows(await getText("https://farside.co.uk/btc"));
    if (rows.length >= 5){ etfCandidates.push({ name:"Farside", rows }); out.sources.farside = "ok"; }
    else { out.sources.farside = `error: parsed ${rows.length} rows`; }
  }catch(e){ out.sources.farside = "error: " + String(e.message || e); }

  const accepted = [];
  for (const c of etfCandidates){
    const r = buildEtf(c.rows, c.name, nowMs);
    if (r.ok) accepted.push({ name:c.name, block:r.block });
    else out.sources[`etf_${c.name.split(" ")[0].toLowerCase()}_rejected`] = r.error;
  }

  if (accepted.length){
    out.etf = { ...accepted[0].block, fetched_at: out.generated_at };
    if (accepted.length > 1){
      const a = accepted[0].block.flow_5d_usd, b = accepted[1].block.flow_5d_usd;
      const diff = Math.abs(a - b), rel = Math.max(Math.abs(a), Math.abs(b)) ? diff / Math.max(Math.abs(a), Math.abs(b)) : 0;
      out.etf.cross_check = {
        second_source: accepted[1].name,
        second_flow_5d_usd: b,
        second_latest_date: accepted[1].block.latest_date,
        divergence_usd: +diff.toFixed(0),
        divergence_percent: +(rel * 100).toFixed(2),
        agreement: rel <= 0.05 ? "agree" : rel <= 0.20 ? "minor_divergence" : "material_divergence"
      };
    } else {
      out.etf.cross_check = { second_source:null, agreement:"single_source_only" };
    }
    out.sources.etf = "ok";
  } else {
    out.etf = { status:"unavailable", error:"no ETF source passed validation" };
    out.sources.etf = "error";
  }

  /* ---- derivatives ---- */
  const V = out.derivatives.venues;

  try{
    const [oi,fund,tick] = await Promise.all([
      getJson("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP"),
      getJson("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"),
      getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
    ]);
    if (oi.code !== "0" || fund.code !== "0" || tick.code !== "0") throw new Error("OKX non-zero API code");
    const o = oi.data?.[0] || {}, f = fund.data?.[0] || {}, t = tick.data?.[0] || {};
    const oiUsd = num(o.oiUsd) ?? (num(o.oiCcy) && num(t.last) ? num(o.oiCcy) * num(t.last) : null);
    V.okx = { status:"ok", contract:"BTC-USDT-SWAP (linear, oiUsd published)", oi_usd:oiUsd, oi_btc:num(o.oiCcy),
              funding_rate_percent: num(f.fundingRate) != null ? num(f.fundingRate) * 100 : null,
              mark_price:num(t.last) };
    out.sources.okx = "ok";
  }catch(e){ V.okx = { status:"error", error:String(e.message||e) }; out.sources.okx = "error"; }

  try{
    const j = await getJson("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
    const d = j.result || {};
    V.deribit = { status:"ok", contract:"BTC-PERPETUAL (open_interest already USD)", oi_usd:num(d.open_interest),
                  funding_rate_percent: num(d.funding_8h) != null ? num(d.funding_8h) * 100 : null,
                  mark_price:num(d.mark_price) };
    out.sources.deribit = "ok";
  }catch(e){ V.deribit = { status:"error", error:String(e.message||e) }; out.sources.deribit = "error"; }

  try{
    const j = await getJson("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&columns=openInterest,fundingRate,markPrice");
    const d = j?.[0] || {};
    V.bitmex = { status:"ok", contract:"XBTUSD (inverse, 1 contract = 1 USD, no multiply)", oi_usd:num(d.openInterest),
                 funding_rate_percent: num(d.fundingRate) != null ? num(d.fundingRate) * 100 : null,
                 mark_price:num(d.markPrice) };
    out.sources.bitmex = "ok";
  }catch(e){ V.bitmex = { status:"error", error:String(e.message||e) }; out.sources.bitmex = "error"; }

  try{
    const j = await getJson("https://api.hyperliquid.xyz/info",{ method:"POST",
      headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ type:"metaAndAssetCtxs" }) });
    const i = j?.[0]?.universe?.findIndex(x => x.name === "BTC");
    if (i == null || i < 0) throw new Error("BTC not found in universe");
    const d = j[1][i], mark = num(d.markPx), oiBtc = num(d.openInterest);
    V.hyperliquid = { status:"ok", contract:"BTC perp (linear, openInterest in BTC, multiplied by mark)",
                      oi_usd: mark && oiBtc ? mark * oiBtc : null, oi_btc:oiBtc,
                      funding_rate_percent: num(d.funding) != null ? num(d.funding) * 100 * 8 : null,
                      mark_price:mark };
    out.sources.hyperliquid = "ok";
  }catch(e){ V.hyperliquid = { status:"error", error:String(e.message||e) }; out.sources.hyperliquid = "error"; }

  /* Kraken. Two contracts, opposite unit rules:
       PF_XBTUSD — linear, openInterest in BTC        -> multiply by markPrice
       PI_XBTUSD — inverse, 1 contract = 1 USD        -> openInterest IS USD
     The previous version selected PI and multiplied, inflating it by the BTC price.
     Funding is excluded on purpose: the v3 REST fundingRate is the ABSOLUTE rate
     (USD per contract per hour). The relative rate exists only on the WebSocket feed,
     so there is no correct conversion available here. */
  try{
    const j = await getJson("https://futures.kraken.com/derivatives/api/v3/tickers");
    const rows = Array.isArray(j?.tickers) ? j.tickers : [];
    const sym = s => String(s?.symbol || "").toUpperCase();
    const pf = rows.find(x => sym(x) === "PF_XBTUSD");
    const pi = rows.find(x => sym(x) === "PI_XBTUSD");

    let oiUsd = null, chosen = null, contract = null;
    if (pf && num(pf.openInterest) != null && num(pf.markPrice) != null){
      oiUsd = num(pf.openInterest) * num(pf.markPrice);
      chosen = pf; contract = "PF_XBTUSD (linear, openInterest in BTC, multiplied by markPrice)";
    } else if (pi && num(pi.openInterest) != null){
      oiUsd = num(pi.openInterest);
      chosen = pi; contract = "PI_XBTUSD (inverse, 1 contract = 1 USD, NOT multiplied)";
    } else {
      throw new Error("neither PF_XBTUSD nor PI_XBTUSD usable");
    }

    V.kraken = { status:"ok", contract, symbol:sym(chosen), oi_usd:oiUsd,
                 open_interest_raw:num(chosen.openInterest), mark_price:num(chosen.markPrice),
                 funding_rate_percent:null,
                 funding_excluded_reason:"Kraken v3 REST publishes the absolute funding rate, not the relative rate; no correct conversion is available from this endpoint." };
    out.sources.kraken_futures = "ok";
  }catch(e){ V.kraken = { status:"error", error:String(e.message||e) }; out.sources.kraken_futures = "error"; }

  try{
    const t = await getJson("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT");
    if (t.retCode !== 0) throw new Error("Bybit retCode " + t.retCode);
    const d = t.result?.list?.[0] || {};
    V.bybit = { status:"ok", contract:"BTCUSDT linear (openInterestValue already USD)", oi_usd:num(d.openInterestValue),
                oi_btc:num(d.openInterest),
                funding_rate_percent: num(d.fundingRate) != null ? num(d.fundingRate) * 100 : null,
                mark_price:num(d.markPrice) };
    out.sources.bybit = "ok";
  }catch(e){ V.bybit = { status:"error", error:String(e.message||e) }; out.sources.bybit = "error (often geoblocked on US runners)"; }

  /* CME. Biggest missing block of real institutional OI. Endpoint is undocumented
     and CME blocks non-browser clients often, so this is best effort, reported
     separately, and kept OUT of the aggregate so the comparable series is stable. */
  try{
    const j = await getJson("https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/8756/G");
    const quotes = Array.isArray(j?.quotes) ? j.quotes : [];
    const contracts = quotes.map(q => num(String(q?.openInterest ?? "").replace(/,/g,""))).filter(Number.isFinite);
    const last = num(String(quotes[0]?.last ?? quotes[0]?.priorSettle ?? "").replace(/,/g,""));
    const totalContracts = contracts.reduce((a,b)=>a+b,0);
    if (!totalContracts || !last) throw new Error("no usable openInterest/price in response");
    V.cme = { status:"ok", contract:"CME BTC futures, 5 BTC per contract",
              oi_usd: totalContracts * 5 * last, open_interest_contracts: totalContracts, mark_price:last,
              include_in_aggregate:false, verified:false,
              note:"Undocumented endpoint, unverified field mapping, excluded from the aggregate on purpose." };
    out.sources.cme = "ok (unverified)";
  }catch(e){ V.cme = { status:"error", error:String(e.message||e), include_in_aggregate:false, verified:false };
             out.sources.cme = "error (expected; CME blocks most non-browser clients)"; }

  const rejected = plausibilityFilter(V);
  if (rejected.length) out.sources.plausibility_rejected = rejected.join(", ");
  out.derivatives.aggregate = aggregate(V);

  /* ---- spot premium, Tether peg removed ---- */
  try{
    const [cb,kr,ok,pegRes] = await Promise.all([
      getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
      getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
      getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
      getJson("https://www.okx.com/api/v5/market/ticker?instId=USDC-USDT").catch(() => null)
    ]);
    const krKey = kr?.result ? Object.keys(kr.result)[0] : null;
    out.spot = premiumBlock({
      cbUsd: num(cb.price),
      krUsd: krKey ? num(kr.result[krKey]?.c?.[0]) : null,
      okxUsdt: num(ok.data?.[0]?.last),
      usdcUsdt: pegRes ? num(pegRes.data?.[0]?.last) : null
    });
    out.sources.spot = out.spot.status === "ok" ? "ok" : "error";
    out.sources.usdt_peg = out.spot.premium_status || "unknown";
  }catch(e){ out.spot = { status:"error", error:String(e.message||e) }; out.sources.spot = "error"; }

  return out;
}

/* ------------------------------------------------------------------ main */

export function historyPoint(out){
  const ag = out.derivatives.aggregate || {};
  return {
    t: out.generated_at,
    oi_usd: ag.status === "ok" ? Math.round(ag.oi_usd) : null,
    venue_set: ag.venue_set ?? null,
    funding_percent: ag.status === "ok" && ag.funding_rate_percent != null ? +ag.funding_rate_percent.toFixed(5) : null,
    premium_percent: out.spot?.us_spot_premium_percent ?? null,
    premium_raw_percent: out.spot?.us_spot_premium_percent_raw ?? null,
    etf_5d_usd: out.etf?.flow_5d_usd ?? null,
    etf_latest_date: out.etf?.latest_date ?? null
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain){
  const out = await collect({ sosoKey: process.env.SOSOVALUE_API_KEY || "" });

  const dataDir  = new URL("../data/", import.meta.url);
  const mainFile = new URL("../data/btc-market.json", import.meta.url);
  const histFile = new URL("../data/btc-history.json", import.meta.url);

  await fs.mkdir(dataDir, { recursive:true });
  await fs.writeFile(mainFile, JSON.stringify(out, null, 2) + "\n", "utf8");

  let hist = [];
  try { hist = JSON.parse(await fs.readFile(histFile, "utf8")); if (!Array.isArray(hist)) hist = []; }
  catch { hist = []; }
  hist.push(historyPoint(out));
  if (hist.length > HISTORY_CAP) hist = hist.slice(-HISTORY_CAP);
  await fs.writeFile(histFile, JSON.stringify(hist) + "\n", "utf8");

  console.log(JSON.stringify({
    generated_at: out.generated_at,
    etf: out.etf.status,
    etf_source: out.etf.source ?? null,
    etf_cross_check: out.etf.cross_check?.agreement ?? null,
    derivatives: out.derivatives.aggregate.status,
    venue_set: out.derivatives.aggregate.venue_set ?? null,
    oi_usd: out.derivatives.aggregate.oi_usd ?? null,
    plausibility_rejected: out.sources.plausibility_rejected ?? "none",
    spot: out.spot.status,
    premium_status: out.spot.premium_status ?? null,
    history_points: hist.length,
    sources: out.sources
  }, null, 2));
}
