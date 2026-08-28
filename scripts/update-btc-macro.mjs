import fs from "node:fs/promises";
import { readFileSync } from "node:fs";

const OUT = new URL("../data/btc-macro.json", import.meta.url);
const MARKET = new URL("../data/btc-market.json", import.meta.url);
const MARKET_HISTORY = new URL("../data/btc-market-history.jsonl", import.meta.url);
const NOW = new Date();
const ISO = NOW.toISOString();
const DAY = 86400000;

const FRED = {
  dollar_exchange: ["DTWEXBGS", "Dollar exchange strength", "index", "FRED: Nominal Broad U.S. Dollar Index", "https://fred.stlouisfed.org/series/DTWEXBGS", "Higher dollar exchange strength can tighten global liquidity for BTC."],
  cpi: ["CPIAUCSL", "CPI inflation", "index", "FRED: CPIAUCSL", "https://fred.stlouisfed.org/series/CPIAUCSL", "Higher consumer inflation can pressure policy rates and liquidity."],
  pce_core: ["PCEPILFE", "PCE/Core PCE", "index", "FRED: PCEPILFE", "https://fred.stlouisfed.org/series/PCEPILFE", "Core PCE is the Fed's preferred inflation gauge."],
  fed_funds: ["FEDFUNDS", "Federal-funds rate", "%", "FRED: FEDFUNDS", "https://fred.stlouisfed.org/series/FEDFUNDS", "Higher policy rates usually make liquidity less supportive."],
  treasury_2y: ["DGS2", "2-year Treasury yield", "%", "FRED: DGS2", "https://fred.stlouisfed.org/series/DGS2", "The 2-year yield tracks expected near-term Fed policy."],
  treasury_10y: ["DGS10", "10-year Treasury yield", "%", "FRED: DGS10", "https://fred.stlouisfed.org/series/DGS10", "Higher long yields can pressure long-duration risk assets."],
  real_yield_10y: ["DFII10", "10-year real yield", "%", "FRED: DFII10", "https://fred.stlouisfed.org/series/DFII10", "Higher inflation-adjusted yields can compete with scarce assets."],
  m2: ["M2SL", "M2 money supply", "USD billions", "FRED: M2SL", "https://fred.stlouisfed.org/series/M2SL", "Expanding money supply can support Bitcoin; contraction can work against it."],
  fed_assets: ["WALCL", "Federal Reserve assets", "USD millions", "FRED: WALCL", "https://fred.stlouisfed.org/series/WALCL", "A larger Fed balance sheet can indicate easier liquidity conditions."],
  reverse_repo: ["RRPONTSYD", "Reverse repo", "USD billions", "FRED: RRPONTSYD", "https://fred.stlouisfed.org/series/RRPONTSYD", "Lower reverse repo balances can release cash into markets."],
  nasdaq: ["NASDAQCOM", "Nasdaq/risk appetite", "index", "FRED: NASDAQCOM", "https://fred.stlouisfed.org/series/NASDAQCOM", "A rising Nasdaq often signals stronger risk appetite."],
  vix: ["VIXCLS", "VIX", "index", "FRED: VIXCLS", "https://fred.stlouisfed.org/series/VIXCLS", "Higher volatility usually means weaker risk appetite."],
  unemployment: ["UNRATE", "Unemployment", "%", "FRED: UNRATE", "https://fred.stlouisfed.org/series/UNRATE", "Rising unemployment can signal macro stress."],
  gold: ["GOLDPMGBD228NLBM", "Gold", "USD/oz", "FRED: GOLDPMGBD228NLBM", "https://fred.stlouisfed.org/series/GOLDPMGBD228NLBM", "Gold is a parallel hard-asset reference, not a BTC signal."],
  oil: ["DCOILWTICO", "Oil", "USD/bbl", "FRED: DCOILWTICO", "https://fred.stlouisfed.org/series/DCOILWTICO", "Higher oil can feed inflation pressure."],
};

const INVERSE = new Set(["dollar_exchange", "cpi", "pce_core", "fed_funds", "treasury_2y", "treasury_10y", "real_yield_10y", "vix", "unemployment", "oil"]);
const DIRECT = new Set(["m2", "fed_assets", "nasdaq"]);
const POSITIVE_SERIES = new Set(["dollar_exchange", "cpi", "dollar_purchasing_power", "pce_core", "m2", "fed_assets", "reverse_repo", "nasdaq", "vix", "gold", "oil"]);
const CORRELATION_INPUTS = new Set(["dollar_exchange", "gold", "nasdaq"]);

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "btc-macro-weather/1", "Accept": "*/*" } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function parseFredCsv(text) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines.map(line => {
    const [date, raw] = line.split(",");
    const value = raw === "." ? null : Number(raw);
    return { date, value };
  }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
}

function nearestAtOrBefore(rows, targetMs) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Date.parse(`${rows[i].date}T00:00:00Z`) <= targetMs) return rows[i];
  }
  return null;
}

function pct(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function parseMarketCap(text, label) {
  const compact = String(text || "").replace(/\s+/g, " ");
  const match = compact.match(/\$([0-9]+(?:\.[0-9]+)?)\s*([TBMK])/);
  if (!match) throw new Error(`${label} market cap not found`);
  const scale = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[match[2]];
  return Number(match[1]) * scale;
}

function seriesValueAtOrBefore(series, targetMs) {
  return nearestAtOrBefore(series?.history || [], targetMs)?.value ?? null;
}

async function totalBtcSupply() {
  const raw = Number((await fetchText("https://blockchain.info/q/totalbc")).trim());
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("invalid Blockchain.com totalbc response");
  return raw / 1e8;
}

async function goldMarketCap() {
  return parseMarketCap(await fetchText("https://companiesmarketcap.com/gold/marketcap/"), "gold");
}

async function btcGoldScoreboard(series) {
  const market = JSON.parse(await fs.readFile(MARKET, "utf8"));
  const btcPrice = Number(market.spot?.us_spot_average_usd ?? market.spot?.coinbase_usd);
  const gold = series.find(s => s.id === "gold" && s.status === "ok");
  const goldPrice = Number(gold?.latest_value);
  const latestGoldMs = Date.parse(`${gold?.observation_date || ""}T00:00:00Z`);
  const btcDaily = dailyHistoryRows();
  const latestBtc = btcDaily.at(-1);
  const latestBtcPrice = Number(latestBtc?.value);
  const liveRatio = btcPrice > 0 && goldPrice > 0 ? btcPrice / goldPrice : null;
  const windows = {};
  for (const [label, days] of [["30d", 30], ["90d", 90], ["1y", 365]]) {
    const targetMs = Math.min(Date.parse(`${latestBtc?.date || ""}T00:00:00Z`), latestGoldMs) - days * DAY;
    const btcPast = nearestAtOrBefore(btcDaily, targetMs)?.value ?? null;
    const goldPast = seriesValueAtOrBefore(gold, targetMs);
    const btcPerf = pct(latestBtcPrice, btcPast);
    const goldPerf = pct(goldPrice, goldPast);
    const relative = Number.isFinite(btcPerf) && Number.isFinite(goldPerf) ? btcPerf - goldPerf : null;
    windows[label] = { btc_percent: round(btcPerf, 2), gold_percent: round(goldPerf, 2), relative_percent: round(relative, 2) };
  }
  const supply = await totalBtcSupply().catch(() => null);
  const goldCap = await goldMarketCap().catch(() => null);
  const btcMarketCap = btcPrice > 0 && supply > 0 ? btcPrice * supply : null;
  const scenarios = {};
  for (const share of [0.10, 0.25, 0.50, 1]) {
    scenarios[`${Math.round(share * 100)}%`] = goldCap > 0 && supply > 0 ? round(goldCap * share / supply, 2) : null;
  }
  return {
    generated_at: ISO,
    status: liveRatio != null ? "ok" : "unavailable",
    btc_price_usd: round(btcPrice, 2),
    gold_price_usd_per_oz: round(goldPrice, 2),
    btc_per_gold_oz: round(liveRatio, 4),
    relative_performance: windows,
    interpretation: Number(windows["90d"]?.relative_percent) >= 0 ? "BTC GAINING VS GOLD" : "GOLD GAINING VS BTC",
    btc_supply: supply == null ? null : round(supply, 8),
    btc_market_cap_usd: btcMarketCap == null ? null : round(btcMarketCap, 2),
    gold_market_cap_usd: goldCap == null ? null : round(goldCap, 2),
    btc_market_cap_percent_of_gold: btcMarketCap != null && goldCap > 0 ? round(btcMarketCap / goldCap * 100, 2) : null,
    scenario_prices_usd: scenarios,
    note: "Gold market value and BTC supply change over time, so these targets move.",
    source: "Existing BTC dashboard data, Yahoo Finance public chart API, Blockchain.com totalbc, CompaniesMarketCap gold market cap",
    source_urls: ["data/btc-market.json", "https://finance.yahoo.com/quote/GC%3DF", "https://blockchain.info/q/totalbc", "https://companiesmarketcap.com/gold/marketcap/"]
  };
}

function downsample(rows, max = 420) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
}

function dailyHistoryRows() {
  try {
    const dataset = JSON.parse(readFileSync(new URL("../data/btc-daily-history.json", import.meta.url), "utf8"));
    return (dataset.observations || [])
      .map(r => ({ date: String(r.time).slice(0, 10), value: Number(r.PriceUSD) }))
      .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.value > 0);
  } catch {
    return [];
  }
}

function returnMap(rows) {
  const clean = (rows || []).filter(r => r?.date && Number.isFinite(Number(r.value)) && Number(r.value) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map();
  for (let i = 1; i < clean.length; i++) {
    const prev = Number(clean[i - 1].value);
    const next = Number(clean[i].value);
    if (prev > 0 && next > 0) out.set(clean[i].date, Math.log(next / prev));
  }
  return out;
}

function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 20) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
}

function pairReturns(btcReturns, assetReturns, endDate, days) {
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const startMs = endMs - days * DAY;
  const xs = [], ys = [];
  for (const [date, btcReturn] of btcReturns) {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (ms > startMs && ms <= endMs && assetReturns.has(date)) {
      xs.push(btcReturn);
      ys.push(assetReturns.get(date));
    }
  }
  return [xs, ys];
}

function trendLabel(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "stable";
  const diff = Math.abs(current) - Math.abs(previous);
  if (diff > 0.08) return "strengthening";
  if (diff < -0.08) return "weakening";
  return "stable";
}

function buildMacroRegime(series) {
  const btc = dailyHistoryRows();
  const btcReturns = returnMap(btc);
  const latestDate = btc.at(-1)?.date;
  const sources = { dxy: "dollar_exchange", gold: "gold", nasdaq: "nasdaq" };
  const labels = { dxy: "DXY", gold: "Gold", nasdaq: "Nasdaq" };
  const correlations = {};
  for (const [key, id] of Object.entries(sources)) {
    const card = series.find(s => s.id === id && s.status === "ok");
    const assetReturns = returnMap(card?._correlation_history || card?.history || []);
    correlations[key] = { label: labels[key], status: "unavailable", windows: {}, trend: "stable" };
    if (!latestDate || btcReturns.size < 181 || assetReturns.size < 181) continue;
    for (const days of [30, 90, 180]) {
      const [xs, ys] = pairReturns(btcReturns, assetReturns, latestDate, days);
      const value = correlation(xs, ys);
      const prevEnd = new Date(Date.parse(`${latestDate}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
      const [px, py] = pairReturns(btcReturns, assetReturns, prevEnd, days);
      const previous = correlation(px, py);
      correlations[key].windows[`${days}d`] = { value: round(value, 3), sample_days: xs.length, trend: trendLabel(value, previous) };
    }
    correlations[key].status = Object.values(correlations[key].windows).some(w => Number.isFinite(w.value)) ? "ok" : "unavailable";
    correlations[key].trend = correlations[key].windows["90d"]?.trend || "stable";
  }
  const c90 = {
    dxy: correlations.dxy?.windows?.["90d"]?.value,
    gold: correlations.gold?.windows?.["90d"]?.value,
    nasdaq: correlations.nasdaq?.windows?.["90d"]?.value
  };
  let regime = "MIXED/TRANSITION";
  if (Number.isFinite(c90.nasdaq) && c90.nasdaq >= 0.35 && (!Number.isFinite(c90.gold) || c90.nasdaq >= c90.gold)) regime = "RISK-ASSET";
  if (Number.isFinite(c90.gold) && c90.gold >= 0.35 && (!Number.isFinite(c90.nasdaq) || c90.gold > c90.nasdaq) && (!Number.isFinite(c90.dxy) || c90.dxy <= 0.2)) regime = "MONETARY/DEBASEMENT";
  return {
    id: "btc_macro_regime", name: "BTC macro regime", status: Object.values(correlations).some(c => c.status === "ok") ? "ok" : "unavailable",
    latest_value: null, unit: "correlation", observation_date: latestDate || null, direction_30d: "unknown", change_1y_percent: null, weather: "UNCLEAR FOR BTC",
    regime, correlations,
    explanation: "Correlations compare daily BTC returns with dollar strength, gold, and Nasdaq returns. Positive means they have tended to move together; negative means they have tended to move opposite.",
    source: "Existing BTC daily history + FRED keyless series", source_url: "data/btc-daily-history.json and FRED CSV",
    data_start_date: btc[0]?.date || null, history: []
  };
}

function weatherFor(id, d30, latest) {
  if (!Number.isFinite(d30)) return "UNCLEAR FOR BTC";
  if (id === "vix") {
    if (latest <= 18 && d30 <= 0) return "FAVORS BTC";
    if (latest >= 25 || d30 > 10) return "AGAINST BTC";
    return "UNCLEAR FOR BTC";
  }
  if (id === "unemployment") {
    if (d30 > 0.2) return "AGAINST BTC";
    if (d30 < -0.2) return "FAVORS BTC";
    return "UNCLEAR FOR BTC";
  }
  if (INVERSE.has(id)) return d30 > 0 ? "AGAINST BTC" : d30 < 0 ? "FAVORS BTC" : "UNCLEAR FOR BTC";
  if (DIRECT.has(id)) return d30 > 0 ? "FAVORS BTC" : d30 < 0 ? "AGAINST BTC" : "UNCLEAR FOR BTC";
  return "UNCLEAR FOR BTC";
}

function buildSeries(id, name, unit, source, sourceUrl, note, rows, transform = null) {
  let clean = transform ? rows.map(transform).filter(r => Number.isFinite(r.value)) : rows;
  if (POSITIVE_SERIES.has(id)) clean = clean.filter(r => r.value > 0);
  const latest = clean.at(-1);
  if (!latest) throw new Error("no usable observations");
  const latestMs = Date.parse(`${latest.date}T00:00:00Z`);
  const d30 = nearestAtOrBefore(clean, latestMs - 30 * DAY);
  const y1 = nearestAtOrBefore(clean, latestMs - 365 * DAY);
  const delta30 = d30 ? latest.value - d30.value : null;
  const change1y = y1 ? pct(latest.value, y1.value) : null;
  const card = {
    id, name, status: "ok", latest_value: round(latest.value, unit === "%" ? 3 : 2), unit,
    observation_date: latest.date,
    direction_30d: Number.isFinite(delta30) ? (delta30 > 0 ? "up" : delta30 < 0 ? "down" : "flat") : "unknown",
    change_30d: round(delta30, 3),
    change_1y_percent: round(change1y, 2),
    weather: weatherFor(id, delta30, latest.value),
    explanation: note,
    source, source_url: sourceUrl,
    data_start_date: clean[0].date,
    history: downsample(clean).map(r => ({ date: r.date, value: round(r.value, 4) }))
  };
  if (CORRELATION_INPUTS.has(id)) card._correlation_history = clean.map(r => ({ date: r.date, value: round(r.value, 4) }));
  return card;
}

function unavailable(id, name, reason, source = "Not available from approved free sources") {
  return { id, name, status: "unavailable", latest_value: null, observation_date: null, direction_30d: "unknown", change_1y_percent: null, weather: "UNCLEAR FOR BTC", explanation: reason, source, data_start_date: null, history: [] };
}

async function fredSeries(id, config) {
  const [fredId, name, unit, source, sourceUrl, note] = config;
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(fredId)}`);
  return buildSeries(id, name, unit, source, sourceUrl, note, parseFredCsv(text));
}

async function yahooChartSeries(id, symbol, name, unit, note) {
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`);
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const rows = timestamps.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: Number(closes[i]) }))
    .filter(r => r.date && Number.isFinite(r.value));
  return buildSeries(id, name, unit, "Yahoo Finance public chart API", `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`, note, rows);
}

async function treasuryTga() {
  const start = new Date(NOW.getTime() - 430 * DAY).toISOString().slice(0, 10);
  const url = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?filter=record_date:gte:${start},account_type:eq:Treasury%20General%20Account%20(TGA)%20Closing%20Balance&sort=record_date&page[size]=10000`;
  const json = await fetchJson(url);
  const rows = (json.data || []).map(r => ({ date: r.record_date, value: Number(r.open_today_bal || r.close_today_bal || r.amount) })).filter(r => r.date && Number.isFinite(r.value));
  return buildSeries("tga", "Treasury General Account", "USD millions", "U.S. Treasury Fiscal Data", "https://fiscaldata.treasury.gov/datasets/daily-treasury-statement/operating-cash-balance", "A rising TGA can drain reserves; a falling TGA can add liquidity.", rows);
}

async function coinMetrics() {
  const url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=SplyCur,HashRate,DiffMean,FeeTotUSD&frequency=1d&page_size=10000";
  const json = await fetchJson(url);
  const data = json.data || [];
  const byMetric = metric => data.map(r => ({ date: String(r.time).slice(0, 10), value: Number(r[metric]) })).filter(r => r.date && Number.isFinite(r.value));
  const supply = byMetric("SplyCur");
  const latest = supply.at(-1), prior = latest ? nearestAtOrBefore(supply, Date.parse(`${latest.date}T00:00:00Z`) - 30 * DAY) : null;
  const issuanceRows = supply.map((r, i) => i ? ({ date: r.date, value: r.value - supply[i - 1].value }) : null).filter(Boolean).filter(r => Number.isFinite(r.value));
  const out = [
    buildSeries("btc_supply", "BTC supply/issuance", "BTC/day", "Coin Metrics Community API", "https://community-api.coinmetrics.io/", "Bitcoin issuance is programmatic; lower issuance is structural context, not a price prediction.", issuanceRows),
    buildSeries("btc_hash", "BTC hash rate/difficulty", "TH/s", "Coin Metrics Community API", "https://community-api.coinmetrics.io/", "Hash rate and difficulty reflect mining security and cost pressure.", byMetric("HashRate")),
    buildSeries("btc_fees", "BTC fees/activity", "USD/day", "Coin Metrics Community API", "https://community-api.coinmetrics.io/", "Fees show settlement demand and blockspace pressure.", byMetric("FeeTotUSD"))
  ];
  out[0].latest_supply = latest ? round(latest.value, 4) : null;
  out[0].supply_change_30d = latest && prior ? round(latest.value - prior.value, 4) : null;
  return out;
}

async function existingDashboardCards() {
  const market = JSON.parse(await fs.readFile(MARKET, "utf8"));
  const historyText = await fs.readFile(MARKET_HISTORY, "utf8").catch(() => "");
  const fundingHistory = historyText.trim().split(/\r?\n/).filter(Boolean).map(line => {
    try {
      const r = JSON.parse(line);
      return { date: String(r.bucket_utc || "").slice(0, 10), value: Number(r.derivatives?.weighted_funding_percent) };
    } catch {
      return null;
    }
  }).filter(r => r?.date && Number.isFinite(r.value));
  const cards = [];
  const etf = market.etf?.flow_5d_usd;
  const etfHistory = (market.etf?.history || []).map(r => ({
    date: r.date || (Number.isFinite(r.timestamp) ? new Date(r.timestamp).toISOString().slice(0, 10) : null),
    value: r.flow_usd
  })).filter(r => r.date && Number.isFinite(r.value));
  cards.push({
    id: "etf_flows", name: "ETF flows", status: Number.isFinite(etf) ? "ok" : "unavailable",
    latest_value: Number.isFinite(etf) ? round(etf, 2) : null, unit: "USD 5-session net",
    observation_date: market.etf?.latest_date || null, direction_30d: "unknown", change_1y_percent: null,
    weather: Number.isFinite(etf) ? etf > 0 ? "FAVORS BTC" : etf < 0 ? "AGAINST BTC" : "UNCLEAR FOR BTC" : "UNCLEAR FOR BTC",
    explanation: "Uses the existing verified dashboard ETF snapshot; this does not alter scoring.",
    source: market.etf?.source || "Existing BTC dashboard data", source_url: "data/btc-market.json",
    data_start_date: etfHistory[0]?.date || null, history: etfHistory
  });
  const agg = market.derivatives?.aggregate || {};
  const funding = Number.isFinite(agg.funding_rate_percent) ? agg.funding_rate_percent : agg.weighted_funding_percent;
  cards.push({
    id: "futures_funding", name: "Futures/funding", status: Number.isFinite(funding) ? "ok" : "unavailable",
    latest_value: Number.isFinite(funding) ? round(funding, 4) : null, unit: "% weighted funding",
    observation_date: market.generated_at?.slice(0, 10) || null, direction_30d: "unknown", change_1y_percent: null,
    weather: Number.isFinite(funding) ? funding > 0.03 ? "AGAINST BTC" : "UNCLEAR FOR BTC" : "UNCLEAR FOR BTC",
    explanation: "Uses the existing verified dashboard futures/funding snapshot; this does not alter scoring.",
    source: "Existing BTC dashboard data", source_url: "data/btc-market.json", data_start_date: fundingHistory[0]?.date || market.generated_at?.slice(0, 10) || null, history: fundingHistory
  });
  return cards;
}

function events() {
  const all = [
    { id: "fomc", name: "FOMC decision", datetime: "2026-09-16T14:00:00-04:00", source: "Federal Reserve FOMC calendar", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
    { id: "cpi", name: "CPI release", datetime: "2026-09-11T08:30:00-04:00", source: "BLS CPI release schedule", source_url: "https://www.bls.gov/schedule/news_release/cpi.htm" },
    { id: "pce", name: "PCE release", datetime: "2026-09-30T08:30:00-04:00", source: "BEA release schedule", source_url: "https://www.bea.gov/news/schedule/full" },
    { id: "employment", name: "Employment report", datetime: "2026-09-04T08:30:00-04:00", source: "BLS release schedule", source_url: "https://www.bls.gov/schedule/2026/" }
  ];
  return all.map(e => ({ ...e, countdown_days: Math.max(0, Math.ceil((Date.parse(e.datetime) - NOW.getTime()) / DAY)) }));
}

const series = [];
const errors = {};
for (const [id, cfg] of Object.entries(FRED)) {
  try {
    const s = await fredSeries(id, cfg);
    series.push(s);
    if (id === "cpi") {
      const rows = parseFredCsv(await fetchText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL"));
      series.push(buildSeries("dollar_purchasing_power", "Dollar purchasing power", "1982-84 dollars", "Calculated from FRED CPIAUCSL", "https://fred.stlouisfed.org/series/CPIAUCSL", "Calculated as 100 divided by CPI; this is separate from dollar exchange strength.", rows, r => ({ date: r.date, value: 100 / r.value })));
    }
  } catch (e) {
    errors[id] = String(e.message || e);
    if (id === "gold") {
      try {
        series.push(await yahooChartSeries("gold", "GC=F", "Gold", "USD/oz", "Gold is a parallel hard-asset reference, not a BTC signal."));
        errors.gold_fred = errors.gold;
        delete errors.gold;
        continue;
      } catch (fallbackError) {
        errors.gold_yahoo = String(fallbackError.message || fallbackError);
      }
    }
    series.push(unavailable(id, cfg[1], String(e.message || e), cfg[3]));
  }
}

try { series.push(await treasuryTga()); } catch (e) { series.push(unavailable("tga", "Treasury General Account", String(e.message || e), "U.S. Treasury Fiscal Data")); }
try { series.push(...await coinMetrics()); } catch (e) {
  series.push(unavailable("btc_supply", "BTC supply/issuance", String(e.message || e), "Coin Metrics Community API"));
  series.push(unavailable("btc_hash", "BTC hash rate/difficulty", String(e.message || e), "Coin Metrics Community API"));
  series.push(unavailable("btc_fees", "BTC fees/activity", String(e.message || e), "Coin Metrics Community API"));
}
series.push(unavailable("stablecoin_supply", "Stablecoin supply", "No approved keyless free broad stablecoin supply series is implemented; unavailable rather than substituted.", "Unavailable"));
series.push(...await existingDashboardCards());
series.unshift(buildMacroRegime(series));
for (const card of series) delete card._correlation_history;

const out = {
  schema: 1,
  generated_at: ISO,
  note: "Macro conditions can influence Bitcoin but do not predict its price. No macro score is produced.",
  cost: "$0",
  api_keys_required: false,
  sources_used: ["Federal Reserve/FRED", "U.S. Treasury Fiscal Data", "Coin Metrics Community API", "Existing verified dashboard data"],
  unavailable_policy: "Missing data is represented as unavailable and is never converted to zero.",
  series,
  btc_vs_gold: await btcGoldScoreboard(series),
  events: events(),
  errors
};

await fs.writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${OUT.pathname} with ${series.length} macro cards`);
