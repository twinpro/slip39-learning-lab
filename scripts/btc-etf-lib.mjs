import {
  num,
  fiveSessionSpanDays,
  assessEtfFreshness,
  MAX_ETF_5_SESSION_SPAN_DAYS,
  MAX_ETF_ABSOLUTE_AGE_DAYS,
  MAX_ETF_WEEKDAYS_SINCE_LATEST
} from "./btc-lib.mjs";

export const SOSOVALUE_ETF_ENDPOINT = "https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart";
export const SOSOVALUE_ETF_BODY = { type: "us-btc-spot" };
export const ETF_DAILY_SANITY_USD = 25_000_000_000;
export const ETF_MIN_RECENT_MAGNITUDE_USD = 1_000_000;

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function rowTimestamp(raw) {
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  if (/^\d{10,13}$/.test(String(raw))) {
    const n = Number(raw);
    return String(raw).length <= 10 ? n * 1000 : n;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? Date.parse(`${raw}T00:00:00Z`) : NaN;
}

export function parseSosoEtfRows(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("schema_error: SoSoValue response is not a JSON object");
  if (Number(j.code) !== 0) throw new Error(`api_error: SoSoValue code ${j.code ?? "missing"}${j.msg ? ` ${j.msg}` : ""}`);
  const container = Array.isArray(j?.data?.list) ? j.data.list
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.list) ? j.list
    : Array.isArray(j?.result?.list) ? j.result.list
    : Array.isArray(j?.result) ? j.result
    : null;
  if (!container) throw new Error("schema_error: SoSoValue response is missing ETF row array");
  if (!container.length) throw new Error("schema_error: SoSoValue ETF row array is empty");

  const rows = container.map((x, index) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`schema_error: ETF row ${index} is not an object`);
    const rawDate = x.date ?? x.timestamp ?? x.time;
    const timestamp = rowTimestamp(rawDate);
    if (!Number.isFinite(timestamp)) throw new Error(`schema_error: ETF row ${index} has invalid date`);
    const rawFlow = x.totalNetInflow ?? x.dailyNetInflow ?? x.netInflow ?? x.flow_usd;
    const flow = num(rawFlow);
    if (flow == null) throw new Error(`schema_error: ETF row ${index} has missing/non-finite flow`);
    return { timestamp, flow_usd: flow };
  });
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

export function buildEtfSnapshot(rows, { source, fetchedAt, nowMs }) {
  const clean = (rows || [])
    .filter(x => Number.isFinite(x.timestamp) && Number.isFinite(x.flow_usd))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (clean.length < 5) throw new Error(`insufficient_data: only ${clean.length} usable ETF rows`);

  const latest = clean.at(-1);
  const freshness = assessEtfFreshness(latest.timestamp, nowMs);
  if (freshness.status === "invalid") throw new Error(`invalid_freshness: ${freshness.reason}`);
  if (freshness.reason === "absolute_age") {
    throw new Error(`stale: latest ETF row ${isoDate(latest.timestamp)} is ${freshness.ageDays.toFixed(1)} calendar days old (absolute max ${MAX_ETF_ABSOLUTE_AGE_DAYS})`);
  }
  if (freshness.status === "stale") {
    throw new Error(`stale: latest ETF row ${isoDate(latest.timestamp)} is ${freshness.sessionsBehind} expected ETF report sessions behind (max ${MAX_ETF_WEEKDAYS_SINCE_LATEST}; weekends and U.S. market holidays ignored)`);
  }

  const recent = clean.slice(-20).map(r => Math.abs(r.flow_usd)).filter(v => v > 0);
  const peak = recent.length ? Math.max(...recent) : 0;
  if (peak > ETF_DAILY_SANITY_USD) throw new Error(`schema_error: ETF daily flow ${peak.toExponential(2)} exceeds sanity cap; possible unit error`);
  if (peak > 0 && peak < ETF_MIN_RECENT_MAGNITUDE_USD) throw new Error(`schema_error: largest recent ETF daily flow is only ${peak}; feed may not be denominated in USD`);

  const spanDays = fiveSessionSpanDays(clean);
  if (spanDays != null && spanDays > MAX_ETF_5_SESSION_SPAN_DAYS) {
    throw new Error(`stale: last 5 ETF rows span ${spanDays.toFixed(1)} calendar days (max ${MAX_ETF_5_SESSION_SPAN_DAYS}); series may have gaps`);
  }

  const last5 = clean.slice(-5);
  return {
    status: "ok",
    source,
    fetched_at: fetchedAt,
    latest_date: isoDate(latest.timestamp),
    latest_age_days: +freshness.ageDays.toFixed(2),
    expected_latest_session: freshness.expectedLatestSession,
    sessions_behind: freshness.sessionsBehind,
    freshness_status: freshness.status,
    freshness_reason: freshness.reason,
    source_status: "ok",
    endpoint: SOSOVALUE_ETF_ENDPOINT,
    five_session_span_calendar_days: spanDays == null ? null : +spanDays.toFixed(2),
    row_count: clean.length,
    flow_5d_usd: last5.reduce((a, x) => a + x.flow_usd, 0),
    last_5_trading_sessions: last5.map(x => ({ date: isoDate(x.timestamp), flow_usd: x.flow_usd })),
    last_5_trading_days: last5.map(x => ({ date: isoDate(x.timestamp), flow_usd: x.flow_usd })),
    history: clean.slice(-25)
  };
}

export function reusablePreviousEtf(snapshot, nowMs, fetchedAt) {
  if (!snapshot?.etf || snapshot.etf.status !== "ok") return null;
  const latestTimestamp = Date.parse(`${snapshot.etf.latest_date}T00:00:00Z`);
  const freshness = assessEtfFreshness(latestTimestamp, nowMs);
  if (!freshness.ok) return null;
  return {
    ...snapshot.etf,
    fetched_at: snapshot.etf.fetched_at || snapshot.generated_at || null,
    preserved_at: fetchedAt,
    preserved_from_generated_at: snapshot.generated_at || null,
    latest_age_days: +freshness.ageDays.toFixed(2),
    expected_latest_session: freshness.expectedLatestSession,
    sessions_behind: freshness.sessionsBehind,
    freshness_status: freshness.status,
    freshness_reason: freshness.reason,
    source_status: "preserved_after_refresh_failure"
  };
}
