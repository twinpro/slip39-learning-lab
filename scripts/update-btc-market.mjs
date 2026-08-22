import fs from "node:fs/promises";

const OUT = new URL("../data/btc-market.json", import.meta.url);
const NOW = new Date();
const ISO = NOW.toISOString();

const SCHEMA = 12;
const MAX_ETF_CALENDAR_AGE_DAYS = 4;
const ETF_DAILY_SANITY_USD = 25_000_000_000;
const ETF_MIN_RECENT_MAGNITUDE_USD = 1_000_000;
const CORE_VENUES = ["okx", "deribit", "bitmex", "hyperliquid", "kraken"];
const FUNDING_SANITY_PERCENT_8H = 5;

const out = {
  schema: SCHEMA,
  generated_at: ISO,
  cost: "$0",
  api_keys_required: true,
  api_keys: ["SOSOVALUE_API_KEY (free tier)"],
  paid_api_keys_required: false,
  sources: {},
  etf: { status: "unavailable" },
  derivatives: { venues: {}, aggregate: { status: "unavailable" } },
  spot: { status: "unavailable" },
  exchange_supply: {
    status: "unavailable_free_reliable",
    score: null,
    note: "No verified free automated all-exchange BTC balance feed has been implemented. This metric remains UNKNOWN and is excluded from scoring."
  }
};

const num = x => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

async function fetchAny(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; btc-real-vs-paper/12)",
        "Accept": "*/*",
        ...(opts.headers || {})
      }
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  return await (await fetchAny(url, opts)).json();
}

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function sosoRowsFrom(j) {
  const lists = [j?.data?.list, j?.data, j?.list, j?.result?.list, j?.result];
  for (const a of lists) {
    if (!Array.isArray(a)) continue;
    const rows = a.map(x => {
      const raw = x?.date ?? x?.timestamp ?? x?.time ?? "";
      let timestamp = null;
      if (typeof raw === "number") {
        timestamp = raw < 1e12 ? raw * 1000 : raw;
      } else if (/^\d{10,13}$/.test(String(raw))) {
        const n = Number(raw);
        timestamp = String(raw).length <= 10 ? n * 1000 : n;
      } else {
        timestamp = Date.parse(`${String(raw)}T00:00:00Z`);
      }
      return {
        timestamp,
        flow_usd: num(x?.totalNetInflow ?? x?.dailyNetInflow ?? x?.netInflow ?? x?.flow_usd)
      };
    }).filter(x => Number.isFinite(x.timestamp) && x.flow_usd != null);
    if (rows.length) return rows.sort((a, b) => a.timestamp - b.timestamp);
  }
  return [];
}

function buildEtf(rows, source) {
  const clean = (rows || [])
    .filter(x => Number.isFinite(x.timestamp) && Number.isFinite(x.flow_usd))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length < 5) throw new Error(`only ${clean.length} usable ETF rows`);

  const latest = clean.at(-1);
  const ageDays = (Date.now() - latest.timestamp) / 86_400_000;
  if (ageDays > MAX_ETF_CALENDAR_AGE_DAYS) {
    throw new Error(`latest ETF row ${isoDate(latest.timestamp)} is ${ageDays.toFixed(1)} calendar days old (max ${MAX_ETF_CALENDAR_AGE_DAYS})`);
  }
  if (ageDays < -1) throw new Error(`latest ETF row ${isoDate(latest.timestamp)} is in the future`);

  const recent = clean.slice(-20).map(r => Math.abs(r.flow_usd)).filter(v => v > 0);
  const peak = recent.length ? Math.max(...recent) : 0;
  if (peak > ETF_DAILY_SANITY_USD) {
    throw new Error(`ETF daily flow ${peak.toExponential(2)} exceeds sanity cap; possible unit error`);
  }
  if (peak > 0 && peak < ETF_MIN_RECENT_MAGNITUDE_USD) {
    throw new Error(`largest recent ETF daily flow is only ${peak}; feed may not be denominated in USD`);
  }

  const last5 = clean.slice(-5);
  return {
    status: "ok",
    source,
    fetched_at: ISO,
    latest_date: isoDate(latest.timestamp),
    latest_age_days: +ageDays.toFixed(2),
    row_count: clean.length,
    flow_5d_usd: last5.reduce((a, x) => a + x.flow_usd, 0),
    last_5_trading_sessions: last5.map(x => ({ date: isoDate(x.timestamp), flow_usd: x.flow_usd })),
    // Keep the legacy key for the existing dashboard and older readers.
    last_5_trading_days: last5.map(x => ({ date: isoDate(x.timestamp), flow_usd: x.flow_usd })),
    history: clean.slice(-25)
  };
}

// ETF: SoSoValue official API v2. The free API key is stored as SOSOVALUE_API_KEY.
try {
  const key = process.env.SOSOVALUE_API_KEY || "";
  if (!key) throw new Error("SOSOVALUE_API_KEY secret is missing");

  const j = await getJson("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-soso-api-key": key
    },
    body: JSON.stringify({ type: "us-btc-spot" })
  });
  if (Number(j?.code) !== 0) throw new Error(j?.msg || "SoSoValue v2 API error");

  out.etf = buildEtf(sosoRowsFrom(j), "SoSoValue official API v2");
  out.sources.sosovalue = "ok";
  out.sources.sosovalue_endpoint = "v2";
} catch (e) {
  out.etf = { status: "unavailable", error: String(e.message || e) };
  out.sources.sosovalue = "error: " + String(e.message || e);
}

// OKX BTC-USDT perpetual. oiUsd is already USD notional.
try {
  const [oi, fund, ticker] = await Promise.all([
    getJson("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP")
  ]);
  if (oi.code !== "0" || fund.code !== "0" || ticker.code !== "0") throw new Error("OKX non-zero API code");
  const o = oi.data?.[0] || {}, f = fund.data?.[0] || {}, t = ticker.data?.[0] || {};
  const oiUsd = num(o.oiUsd) ?? (num(o.oiCcy) != null && num(t.last) != null ? num(o.oiCcy) * num(t.last) : null);
  out.derivatives.venues.okx = {
    status: "ok",
    contract: "BTC-USDT-SWAP",
    oi_usd: oiUsd,
    oi_btc: num(o.oiCcy),
    funding_rate_percent: num(f.fundingRate) != null ? num(f.fundingRate) * 100 : null,
    funding_interval_hours: 8,
    mark_price: num(t.last)
  };
  out.sources.okx = "ok";
} catch (e) {
  out.derivatives.venues.okx = { status: "error", error: String(e.message || e) };
  out.sources.okx = "error";
}

// Deribit BTC perpetual. open_interest is already USD notional; funding_8h is comparable.
try {
  const j = await getJson("https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL");
  const d = j.result || {};
  out.derivatives.venues.deribit = {
    status: "ok",
    contract: "BTC-PERPETUAL",
    oi_usd: num(d.open_interest),
    funding_rate_percent: num(d.funding_8h) != null ? num(d.funding_8h) * 100 : null,
    funding_interval_hours: 8,
    mark_price: num(d.mark_price)
  };
  out.sources.deribit = "ok";
} catch (e) {
  out.derivatives.venues.deribit = { status: "error", error: String(e.message || e) };
  out.sources.deribit = "error";
}

// BitMEX XBTUSD is inverse: 1 contract = 1 USD notional.
try {
  const j = await getJson("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&columns=openInterest,fundingRate,markPrice");
  const d = j?.[0] || {};
  out.derivatives.venues.bitmex = {
    status: "ok",
    contract: "XBTUSD (inverse; 1 contract = 1 USD)",
    oi_usd: num(d.openInterest),
    funding_rate_percent: num(d.fundingRate) != null ? num(d.fundingRate) * 100 : null,
    funding_interval_hours: 8,
    mark_price: num(d.markPrice)
  };
  out.sources.bitmex = "ok";
} catch (e) {
  out.derivatives.venues.bitmex = { status: "error", error: String(e.message || e) };
  out.sources.bitmex = "error";
}

// Hyperliquid openInterest is in BTC. Convert OI to USD using markPx.
// Hyperliquid funding is hourly; convert to an 8-hour equivalent for cross-venue comparison.
try {
  const j = await getJson("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" })
  });
  const i = j?.[0]?.universe?.findIndex(x => x.name === "BTC");
  if (i == null || i < 0) throw new Error("BTC not found");
  const d = j[1][i], mark = num(d.markPx), oiBtc = num(d.openInterest);
  out.derivatives.venues.hyperliquid = {
    status: "ok",
    contract: "BTC perpetual",
    oi_usd: mark != null && oiBtc != null ? mark * oiBtc : null,
    oi_btc: oiBtc,
    funding_rate_percent: num(d.funding) != null ? num(d.funding) * 100 * 8 : null,
    funding_interval_hours: 8,
    funding_source_interval_hours: 1,
    mark_price: mark
  };
  out.sources.hyperliquid = "ok";
} catch (e) {
  out.derivatives.venues.hyperliquid = { status: "error", error: String(e.message || e) };
  out.sources.hyperliquid = "error";
}

// Kraken PI_XBTUSD is inverse and has a $1 contract size.
// Therefore openInterest itself is USD notional. DO NOT multiply it by markPrice.
// Kraken ticker fundingRate is an absolute funding rate. Preserve it separately.
// Comparable relative funding comes from the public historical funding endpoint when available.
try {
  const j = await getJson("https://futures.kraken.com/derivatives/api/v3/tickers");
  const rows = Array.isArray(j?.tickers) ? j.tickers : [];
  const pi = rows.find(x => String(x?.symbol || "").toUpperCase() === "PI_XBTUSD")
          || rows.find(x => String(x?.symbol || "").toUpperCase() === "PI_BTCUSD");
  if (!pi) throw new Error("Kraken PI_XBTUSD ticker not found");

  const oiUsd = num(pi.openInterest);
  if (!(oiUsd > 0)) throw new Error("Kraken PI_XBTUSD openInterest missing");

  let relativeFundingPercent8h = null;
  let relativeFundingTimestamp = null;
  let fundingAnalyticsError = null;
  try {
    const fj = await getJson("https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=PI_XBTUSD");
    const rates = Array.isArray(fj?.rates) ? fj.rates : [];
    const latest = rates
      .filter(r => num(r?.relativeFundingRate) != null)
      .sort((a, b) => Date.parse(a?.timestamp || 0) - Date.parse(b?.timestamp || 0))
      .at(-1);
    if (latest) {
      // PI_XBTUSD funding is hourly. Normalize to an 8-hour equivalent.
      relativeFundingPercent8h = num(latest.relativeFundingRate) * 100 * 8;
      relativeFundingTimestamp = latest.timestamp || null;
    } else {
      fundingAnalyticsError = "no relativeFundingRate rows";
    }
  } catch (e) {
    fundingAnalyticsError = String(e.message || e);
  }

  out.derivatives.venues.kraken = {
    status: "ok",
    symbol: String(pi.symbol || "PI_XBTUSD").toUpperCase(),
    contract: "PI_XBTUSD (inverse; 1 contract = 1 USD; openInterest is USD notional)",
    oi_usd: oiUsd,
    open_interest_raw: num(pi.openInterest),
    mark_price: num(pi.markPrice),
    funding_rate_absolute_raw: num(pi.fundingRate),
    funding_rate_percent: relativeFundingPercent8h,
    funding_interval_hours: relativeFundingPercent8h == null ? null : 8,
    funding_source_interval_hours: relativeFundingPercent8h == null ? null : 1,
    relative_funding_timestamp: relativeFundingTimestamp,
    funding_note: relativeFundingPercent8h == null
      ? "Kraken OI remains included. Comparable relative funding was unavailable; raw absolute REST funding is preserved separately."
      : "Comparable relative Kraken funding is sourced from the public historical funding endpoint and normalized to an 8-hour equivalent.",
    funding_analytics_error: fundingAnalyticsError
  };
  out.sources.kraken_futures = "ok";
  out.sources.kraken_funding = relativeFundingPercent8h == null ? "unavailable" : "ok";
} catch (e) {
  out.derivatives.venues.kraken = { status: "error", error: String(e.message || e) };
  out.sources.kraken_futures = "error";
  out.sources.kraken_funding = "unavailable";
}

// Bybit is optional only. GitHub-hosted runners often receive HTTP 403.
// It is never part of the fixed core aggregate.
try {
  const t = await getJson("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT");
  if (t.retCode !== 0) throw new Error("Bybit retCode " + t.retCode);
  const d = t.result?.list?.[0] || {};
  out.derivatives.venues.bybit = {
    status: "ok",
    core: false,
    oi_usd: num(d.openInterestValue),
    oi_btc: num(d.openInterest),
    funding_rate_percent: num(d.fundingRate) != null ? num(d.fundingRate) * 100 : null,
    mark_price: num(d.markPrice)
  };
  out.sources.bybit = "ok (optional; not core)";
} catch (e) {
  out.derivatives.venues.bybit = { status: "error", core: false, error: String(e.message || e) };
  out.sources.bybit = "error (optional; not relied upon)";
}

// Fixed comparable core set. OI can be displayed as partial working coverage, but
// time-series comparisons are only valid when all five core venues are working.
const workingCore = CORE_VENUES.filter(name => {
  const v = out.derivatives.venues[name];
  return v?.status === "ok" && num(v?.oi_usd) > 0;
});
const missingCore = CORE_VENUES.filter(name => !workingCore.includes(name));
const workingEntries = workingCore.map(name => [name, out.derivatives.venues[name]]);
const partialOiUsd = workingEntries.reduce((a, [, v]) => a + v.oi_usd, 0);
const coreComplete = missingCore.length === 0;

const fundingEntries = workingEntries.filter(([, v]) => {
  const f = num(v.funding_rate_percent);
  return f != null && Math.abs(f) <= FUNDING_SANITY_PERCENT_8H;
});
const fundingOiUsd = fundingEntries.reduce((a, [, v]) => a + v.oi_usd, 0);
const weightedFunding = fundingOiUsd
  ? fundingEntries.reduce((a, [, v]) => a + v.oi_usd * v.funding_rate_percent, 0) / fundingOiUsd
  : null;

out.derivatives.aggregate = {
  status: workingCore.length >= 2 ? "ok" : "insufficient",
  venue_count: workingCore.length,
  venues: workingCore,
  oi_usd: partialOiUsd || null,
  funding_rate_percent: weightedFunding,
  funding_venue_count: fundingEntries.length,
  funding_venues: fundingEntries.map(([name]) => name),
  core_expected_venues: CORE_VENUES,
  core_working_venues: workingCore,
  core_missing_venues: missingCore,
  core_comparable_status: coreComplete ? "ok" : "incomplete",
  core_comparable_oi_usd: coreComplete ? partialOiUsd : null,
  warning: coreComplete
    ? "Fixed five-venue core is complete. Aggregate OI is comparable to other complete-core snapshots."
    : "Partial futures OI only. Do not compare aggregate OI over time until the fixed five-venue core is complete."
};

// Spot-demand proxy: average Coinbase BTC-USD + Kraken XBT/USD versus OKX BTC-USDT
// converted into USD using live USDT/USD from Coinbase and Kraken.
try {
  const [cb, kr, ok, cbUsdt, krUsdt] = await Promise.all([
    getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD"),
    getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
    getJson("https://api.exchange.coinbase.com/products/USDT-USD/ticker").catch(() => null),
    getJson("https://api.kraken.com/0/public/Ticker?pair=USDTUSD").catch(() => null)
  ]);

  const cbp = num(cb?.price);
  const krKey = kr?.result ? Object.keys(kr.result)[0] : null;
  const krp = krKey ? num(kr.result[krKey]?.c?.[0]) : null;
  const okp = num(ok?.data?.[0]?.last);

  const cbUsdtUsd = num(cbUsdt?.price);
  const krUsdtKey = krUsdt?.result ? Object.keys(krUsdt.result)[0] : null;
  const krUsdtUsd = krUsdtKey ? num(krUsdt.result[krUsdtKey]?.c?.[0]) : null;
  const pegQuotes = [cbUsdtUsd, krUsdtUsd].filter(v => v != null && v > 0.97 && v < 1.03);
  const usdtUsd = pegQuotes.length ? pegQuotes.reduce((a, b) => a + b, 0) / pegQuotes.length : null;

  if (!cbp || !krp || !okp) throw new Error("missing public BTC spot price");
  if (!usdtUsd) throw new Error("no valid Coinbase/Kraken USDT-USD normalization quote");

  const usdAvg = (cbp + krp) / 2;
  const okxUsdEquivalent = okp * usdtUsd;
  const rawPremium = (usdAvg / okp - 1) * 100;
  const normalizedPremium = (usdAvg / okxUsdEquivalent - 1) * 100;

  out.spot = {
    status: "ok",
    source: "Coinbase BTC-USD + Kraken XBT/USD vs USDT-normalized OKX BTC-USDT",
    coinbase_usd: cbp,
    kraken_usd: krp,
    us_spot_average_usd: usdAvg,
    okx_usdt: okp,
    coinbase_usdt_usd: cbUsdtUsd,
    kraken_usdt_usd: krUsdtUsd,
    usdt_usd: usdtUsd,
    okx_usd_equivalent: okxUsdEquivalent,
    us_spot_premium_percent_raw: +rawPremium.toFixed(4),
    us_spot_premium_percent: +normalizedPremium.toFixed(4),
    premium_status: "usdt_normalized",
    note: "OKX BTC-USDT is converted to USD using live Coinbase/Kraken USDT-USD before comparison."
  };
  out.sources.kraken_spot = "ok";
  out.sources.spot = "ok";
  out.sources.usdt_usd = pegQuotes.length === 2 ? "ok: coinbase+kraken" : "ok: one verified quote";
} catch (e) {
  out.spot = { status: "error", error: String(e.message || e) };
  out.sources.kraken_spot = out.sources.kraken_spot || "error";
  out.sources.spot = "error";
  out.sources.usdt_usd = "error";
}

await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  schema: out.schema,
  generated_at: out.generated_at,
  etf: out.etf.status,
  etf_5_session_usd: out.etf.flow_5d_usd ?? null,
  derivatives: out.derivatives.aggregate.status,
  core_comparable_status: out.derivatives.aggregate.core_comparable_status,
  core_working_venues: out.derivatives.aggregate.core_working_venues,
  core_missing_venues: out.derivatives.aggregate.core_missing_venues,
  core_comparable_oi_usd: out.derivatives.aggregate.core_comparable_oi_usd,
  partial_oi_usd: out.derivatives.aggregate.oi_usd,
  funding_rate_percent: out.derivatives.aggregate.funding_rate_percent,
  funding_venues: out.derivatives.aggregate.funding_venues,
  spot: out.spot.status,
  us_spot_premium_percent: out.spot.us_spot_premium_percent ?? null,
  usdt_usd: out.spot.usdt_usd ?? null,
  sources: out.sources
}, null, 2));
