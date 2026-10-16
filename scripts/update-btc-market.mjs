import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getJson, observationTime } from "./btc-http.mjs";
import { preserveVerifiedReadings } from "./btc-publication-lib.mjs";
import { num, parseBitmexInstrument, guardVenueUnits, computeSourceHealth, CORE_VENUES, FUNDING_SANITY_PERCENT_8H } from "./btc-lib.mjs";
import { SOSOVALUE_ETF_BODY, SOSOVALUE_ETF_ENDPOINT, buildEtfSnapshot, parseSosoEtfRows, reusablePreviousEtf } from "./btc-etf-lib.mjs";

// Direct CLI calls use the same guarded publisher as Actions.
if (!process.env.BTC_MARKET_OUTPUT) {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-btc-market.mjs', import.meta.url))], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const OUT = process.env.BTC_MARKET_OUTPUT || new URL("../data/btc-market.json", import.meta.url);
const PREVIOUS = process.env.BTC_MARKET_PREVIOUS || OUT;
const NOW = new Date();
const ISO = NOW.toISOString();

const SCHEMA = 12;
const out = {
  schema: SCHEMA,
  release: "V12.3",
  generated_at: ISO,
  cost: "$0",
  api_keys_required: false,
  api_keys: [],
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

let previousSnapshot = null;
try {
  previousSnapshot = JSON.parse(await fs.readFile(PREVIOUS, "utf8"));
} catch {}

// ETF: SoSoValue official API v2. This endpoint is currently free/keyless; if a
// legacy SOSOVALUE_API_KEY secret exists, keep sending it without requiring it.
try {
  const key = process.env.SOSOVALUE_API_KEY || "";
  const headers = { "Content-Type": "application/json" };
  if (key) headers["x-soso-api-key"] = key;
  const j = await getJson(SOSOVALUE_ETF_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(SOSOVALUE_ETF_BODY)
  });
  out.etf = buildEtfSnapshot(parseSosoEtfRows(j), { source: "SoSoValue official API v2", fetchedAt: ISO, nowMs: NOW.getTime() });
  out.sources.sosovalue = "ok";
  out.sources.sosovalue_endpoint = "v2";
} catch (e) {
  const previousEtf = reusablePreviousEtf(previousSnapshot, NOW.getTime(), ISO);
  out.etf = previousEtf || { status: "unavailable", error: String(e.message || e) };
  out.sources.sosovalue = "error: " + String(e.message || e);
  if (previousEtf) out.sources.sosovalue_recovery = "preserved previous valid ETF snapshot";
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
  const observedAt = observationTime(o.ts, ISO);
  observationTime(t.ts, ISO);
  observationTime(f.ts, ISO);
  const oiUsd = num(o.oiUsd) ?? (num(o.oiCcy) != null && num(t.last) != null ? num(o.oiCcy) * num(t.last) : null);
  out.derivatives.venues.okx = {
    status: "ok",
    contract: "BTC-USDT-SWAP",
    observed_at: observedAt,
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
  if (j.error) throw new Error("Deribit API error: " + j.error.code);
  const d = j.result || {};
  const observedAt = observationTime(d.timestamp, ISO);
  out.derivatives.venues.deribit = {
    status: "ok",
    contract: "BTC-PERPETUAL",
    observed_at: observedAt,
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
  const j = await getJson("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&columns=symbol,state,openInterest,fundingRate,markPrice,timestamp");
  const venue = parseBitmexInstrument(j);
  if (venue.status === "ok") venue.observed_at = observationTime(j.find(x => x.symbol === "XBTUSD").timestamp, ISO);
  out.derivatives.venues.bitmex = venue;
  out.sources.bitmex = venue.status === "ok" ? "ok" : venue.note;
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

  const observedAt = observationTime(j.serverTime, ISO);
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
      relativeFundingTimestamp = observationTime(latest.timestamp, ISO, 180);
    } else {
      fundingAnalyticsError = "no relativeFundingRate rows";
    }
  } catch (e) {
    relativeFundingPercent8h = null;
    relativeFundingTimestamp = null;
    fundingAnalyticsError = String(e.message || e);
  }

  out.derivatives.venues.kraken = {
    status: "ok",
    observed_at: observedAt,
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
  observationTime(t.time, ISO);
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

// Defense-in-depth dimensional checks run before aggregation. If a contract-unit
// invariant fails, the venue is rejected from this run and verify-snapshot.mjs prevents
// the bad snapshot from being published.
for (const v of Object.values(out.derivatives.venues)) {
  if (v.status === "ok") {
    v.observed_at ||= ISO;
    v.timestamp_basis = v.observed_at === ISO ? "response_received" : "provider";
    if (num(v.funding_rate_percent) != null && Math.abs(v.funding_rate_percent) > FUNDING_SANITY_PERCENT_8H) {
      v.funding_error = "Funding exceeded sanity bound; excluded";
      v.funding_rate_percent = null;
    }
  }
}
const unitRejected = guardVenueUnits(out.derivatives.venues);
// Reject the bad source without vetoing independent sources.
for (const name of unitRejected) {
  out.derivatives.venues[name] = { status: "error", error: out.derivatives.venues[name].rejected_reason };
}
const coreUnitRejected = unitRejected.filter(name => CORE_VENUES.includes(name));
const optionalUnitRejected = unitRejected.filter(name => !CORE_VENUES.includes(name));
if (coreUnitRejected.length) out.sources.source_validation_rejected = coreUnitRejected.join(", ");
if (optionalUnitRejected.length) out.sources.optional_unit_guard_rejected = optionalUnitRejected.join(", ");

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

  observationTime(cb?.time, ISO);
  observationTime(ok?.data?.[0]?.ts, ISO);
  if (ok.code !== "0" || kr.error?.length) throw new Error("Spot API error");
  const cbp = num(cb?.price);
  const krKey = kr?.result ? Object.keys(kr.result)[0] : null;
  const krp = krKey ? num(kr.result[krKey]?.c?.[0]) : null;
  const okp = num(ok?.data?.[0]?.last);

  let cbUsdtUsd = num(cbUsdt?.price);
  try { observationTime(cbUsdt?.time, ISO); } catch { cbUsdtUsd = null; }
  const krUsdtKey = krUsdt?.result ? Object.keys(krUsdt.result)[0] : null;
  const krUsdtUsd = krUsdtKey ? num(krUsdt.result[krUsdtKey]?.c?.[0]) : null;
  const pegQuotes = [cbUsdtUsd, krUsdtUsd].filter(v => v != null && v > 0.97 && v < 1.03);
  const usdtUsd = pegQuotes.length ? pegQuotes.reduce((a, b) => a + b, 0) / pegQuotes.length : null;

  if (![cbp, krp, okp].every(p => p > 0 && p < 10000000)) throw new Error("missing public BTC spot price");
  if (!usdtUsd) throw new Error("no valid Coinbase/Kraken USDT-USD normalization quote");

  const usdAvg = (cbp + krp) / 2;
  const okxUsdEquivalent = okp * usdtUsd;
  const rawPremium = (usdAvg / okp - 1) * 100;
  const normalizedPremium = (usdAvg / okxUsdEquivalent - 1) * 100;

  out.spot = {
    status: "ok",
    observed_at: ISO,
    timestamp_basis: "validated provider timestamps; Kraken response received",
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

preserveVerifiedReadings(out, previousSnapshot);
out.health = computeSourceHealth(out);

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
