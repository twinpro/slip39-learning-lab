import { readFileSync } from "node:fs";
import {
  num,
  guardVenueUnits,
  fiveSessionSpanDays,
  assessEtfFreshness,
  computeSourceHealth,
  classifyFreshness,
  buildHealthStatus,
  validateSnapshot,
  CORE_VENUES
} from "./btc-lib.mjs";
import {
  assessAutomationHeartbeat,
  BTC_DISPLAY_TIME_ZONE,
  classifyDashboardFreshness,
  formatEtDateTime,
  formatEtHistoryTick,
  formatEtTime,
} from "../assets/js/btc-dashboard-time.mjs";

let total = 0, failed = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) console.log(`PASS ${String(total).padStart(2, "0")} ${name}`);
  else {
    failed++;
    console.error(`FAIL ${String(total).padStart(2, "0")} ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

check("dashboard display timezone is America/New_York", BTC_DISPLAY_TIME_ZONE === "America/New_York");
check("summer UTC snapshot renders in ET", formatEtDateTime("2026-08-25T00:24:41Z") === "8/24/2026, 8:24:41 PM ET", formatEtDateTime("2026-08-25T00:24:41Z"));
check("winter UTC snapshot observes Eastern standard offset", formatEtDateTime("2026-01-15T05:00:00Z") === "1/15/2026, 12:00:00 AM ET", formatEtDateTime("2026-01-15T05:00:00Z"));
check("compact dashboard timestamp is labeled ET", formatEtTime("2026-08-25T00:24:41Z") === "8:24:41 PM ET", formatEtTime("2026-08-25T00:24:41Z"));
check("hourly history tick converts UTC to ET", formatEtHistoryTick("2026-08-25T00:00:00Z") === "8/24 20:00 ET", formatEtHistoryTick("2026-08-25T00:00:00Z"));
check("long-range history date is labeled ET", formatEtHistoryTick("2026-08-25T00:00:00Z", true) === "Aug 24 ET", formatEtHistoryTick("2026-08-25T00:00:00Z", true));
check("invalid display timestamp is rejected safely", formatEtDateTime("not-a-date") === "—");
const heartbeatNow = Date.parse("2026-08-25T01:00:00Z");
const heartbeatBase = {
  lastSuccessfulAt: "2026-08-25T00:25:00Z",
  generatedAt: "2026-08-25T00:25:00Z",
  nowMs: heartbeatNow,
};
{
  const heartbeat = assessAutomationHeartbeat({ ...heartbeatBase, attemptedAt: "2026-08-25T00:30:00Z", snapshotValid: true });
  check("fresh valid heartbeat reports automation running and data verified", heartbeat.state === "running_verified" && heartbeat.label === "AUTOMATION RUNNING · DATA VERIFIED", JSON.stringify(heartbeat));
}
{
  const heartbeat = assessAutomationHeartbeat({ ...heartbeatBase, attemptedAt: "2026-08-25T00:30:00Z", snapshotValid: false });
  check("fresh rejected heartbeat reports automation running and source degraded", heartbeat.state === "running_degraded" && heartbeat.label === "AUTOMATION RUNNING · SOURCE DEGRADED", JSON.stringify(heartbeat));
}
{
  const heartbeat = assessAutomationHeartbeat({ ...heartbeatBase, attemptedAt: "2026-08-24T23:59:00Z", snapshotValid: true });
  check("heartbeat above 60 through 180 minutes reports automation delayed", heartbeat.state === "delayed" && heartbeat.label === "AUTOMATION DELAYED", JSON.stringify(heartbeat));
}
{
  const heartbeat = assessAutomationHeartbeat({ ...heartbeatBase, attemptedAt: "2026-08-24T21:59:59Z", snapshotValid: true });
  check("heartbeat above 180 minutes reports automation stale", heartbeat.state === "stale" && heartbeat.label === "AUTOMATION STALE", JSON.stringify(heartbeat));
}
{
  const heartbeat = assessAutomationHeartbeat({ ...heartbeatBase, attemptedAt: "2026-08-25T00:30:00Z", lastSuccessfulAt: "2026-08-25T00:20:00Z", snapshotValid: true });
  check("fresh incoherent published timestamps report source degraded", heartbeat.state === "running_degraded" && !heartbeat.dataVerified, JSON.stringify(heartbeat));
}
check("heartbeat boundaries remain fresh through 60 and delayed through 180 minutes", classifyDashboardFreshness(60) === "fresh" && classifyDashboardFreshness(180) === "delayed" && classifyDashboardFreshness(180.01) === "stale");
const dashboardSource = readFileSync(new URL("../pages/btc-real-vs-paper-v11b.html", import.meta.url), "utf8");
check("live dashboard clock uses trusted server time", dashboardSource.includes("const now=()=>new Date(trustedNowMs());"));
check("dashboard timestamp paths avoid browser-local formatting", !/new Date\([^\n]+\)\.toLocale|\.toTimeString\(/.test(dashboardSource));
check("dashboard startup awaits trusted clock before logging", /async function startDashboard\(\)\{\s*await loadSnapshot\(\);[\s\S]*?log\('Bitcoin Real vs Paper opened/.test(dashboardSource));

check("num rejects null", num(null) === null);
check("num rejects undefined", num(undefined) === null);
check("num rejects empty string", num("") === null);
check("num rejects whitespace string", num("   ") === null);
check("num rejects boolean", num(false) === null);
check("num accepts numeric string", num("123.4") === 123.4);
check("num rejects garbage", num("abc") === null);

const day = 86_400_000;
const rows = [0,1,2,3,4].map(i => ({ timestamp: i * day }));
check("five-session span is four calendar days", fiveSessionSpanDays(rows) === 4);
check("five-session span needs five rows", fiveSessionSpanDays(rows.slice(0,4)) === null);
check("freshness is FRESH through exactly 60 minutes", classifyFreshness(60) === "fresh");
check("freshness is DELAYED above 60 through exactly 180 minutes", classifyFreshness(60.01) === "delayed" && classifyFreshness(180) === "delayed");
check("freshness is STALE above 180 minutes or with an invalid age", classifyFreshness(180.01) === "stale" && classifyFreshness(NaN) === "stale");

const fridayEtf = Date.parse("2026-08-21T00:00:00Z");
{
  const freshness = assessEtfFreshness(fridayEtf, Date.parse("2026-08-25T00:24:00Z"));
  check("Friday ETF data remains fresh through Tuesday 00:24 UTC", freshness.ok && freshness.weekdaysElapsed === 2, JSON.stringify(freshness));
}
{
  const freshness = assessEtfFreshness(fridayEtf, Date.parse("2026-08-26T00:00:00Z"));
  check("Friday ETF data is stale by Wednesday UTC", !freshness.ok && freshness.reason === "weekday_age" && freshness.weekdaysElapsed === 3, JSON.stringify(freshness));
}
{
  const freshness = assessEtfFreshness(fridayEtf, Date.parse("2026-08-29T00:00:01Z"));
  check("ETF freshness retains a seven-calendar-day absolute limit", !freshness.ok && freshness.reason === "absolute_age", JSON.stringify(freshness));
}

{
  const venues = {
    kraken: { status:"ok", oi_usd:3_400_000, open_interest_raw:3_400_000, mark_price:78_000 },
    hyperliquid: { status:"ok", oi_btc:33_000, mark_price:78_000, oi_usd:33_000*78_000 }
  };
  const rejected = guardVenueUnits(venues);
  check("correct Kraken OI passes unit guard", !rejected.includes("kraken"), JSON.stringify(venues.kraken));
  check("correct Hyperliquid OI passes unit guard", !rejected.includes("hyperliquid"), JSON.stringify(venues.hyperliquid));
  check("unit guard annotates implied BTC", venues.hyperliquid.implied_btc === 33000, String(venues.hyperliquid.implied_btc));
}

{
  const venues = {
    kraken: { status:"ok", oi_usd:3_400_000*78_000, open_interest_raw:3_400_000, mark_price:78_000 }
  };
  const rejected = guardVenueUnits(venues);
  check("old Kraken openInterest × markPrice bug is rejected", rejected.includes("kraken"), venues.kraken.rejected_reason);
}

{
  const venues = {
    hyperliquid: { status:"ok", oi_btc:33_000, mark_price:78_000, oi_usd:33_000 }
  };
  const rejected = guardVenueUnits(venues);
  check("Hyperliquid BTC-as-USD unit bug is rejected", rejected.includes("hyperliquid"), venues.hyperliquid.rejected_reason);
}

function goodSnapshot() {
  const venueRows = {
    okx: { status:"ok", oi_usd:2_300_000_000, mark_price:78_000, funding_rate_percent:0.01, unit_check:"ok" },
    deribit: { status:"ok", oi_usd:900_000_000, mark_price:78_000, funding_rate_percent:0.001, unit_check:"ok" },
    bitmex: { status:"ok", oi_usd:22_000_000, mark_price:78_000, funding_rate_percent:0.01, unit_check:"ok" },
    hyperliquid: { status:"ok", oi_btc:33_000, mark_price:78_000, oi_usd:2_574_000_000, funding_rate_percent:0.01, unit_check:"ok" },
    kraken: { status:"ok", oi_usd:3_400_000, open_interest_raw:3_400_000, mark_price:78_000, funding_rate_percent:-0.01, unit_check:"ok" }
  };
  const sum = Object.values(venueRows).reduce((a,v)=>a+v.oi_usd,0);
  const snapshot = {
    schema:12,
    generated_at:"2026-08-22T18:00:00Z",
    sources:{},
    etf:{
      status:"ok", latest_date:"2026-08-22", latest_age_days:0, flow_5d_usd:150,
      last_5_trading_sessions:[1,2,3,4,5].map((x,i)=>({date:`2026-08-${18+i}`,flow_usd:x*10}))
    },
    derivatives:{ venues:venueRows, aggregate:{
      status:"ok", core_expected_venues:[...CORE_VENUES], core_working_venues:[...CORE_VENUES],
      core_missing_venues:[], core_comparable_status:"ok", core_comparable_oi_usd:sum
    }},
    spot:{
      status:"ok", premium_status:"usdt_normalized",
      coinbase_usd:78010, kraken_usd:77990, okx_usdt:78005,
      coinbase_usdt_usd:0.9997, kraken_usdt_usd:0.9999, usdt_usd:0.9998,
      us_spot_average_usd:78000, okx_usd_equivalent:78005*0.9998,
      us_spot_premium_percent:+((78000/(78005*0.9998)-1)*100).toFixed(4)
    },
    exchange_supply:{ status:"unavailable_free_reliable", score:null }
  };
  snapshot.health = computeSourceHealth(snapshot);
  return snapshot;
}

{
  const d = goodSnapshot();
  const v = validateSnapshot(d);
  check("known-good snapshot validates", v.ok, v.errors.join(" | "));
}
{
  const d = goodSnapshot();
  d.generated_at = "2026-08-25T00:24:00Z";
  d.etf.latest_date = "2026-08-21";
  d.etf.latest_age_days = 4.02;
  d.health = computeSourceHealth(d);
  const v = validateSnapshot(d);
  check("snapshot validator accepts Friday ETF data on Tuesday", v.ok, v.errors.join(" | "));
}
{
  const d = goodSnapshot();
  d.generated_at = "2026-08-26T00:00:00Z";
  d.etf.latest_date = "2026-08-21";
  d.etf.latest_age_days = 5;
  d.health = computeSourceHealth(d);
  const v = validateSnapshot(d);
  check("snapshot validator rejects Friday ETF data on Wednesday", !v.ok && v.errors.some(x => x.includes("weekday_age")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.sources.unit_guard_rejected="kraken";
  const v = validateSnapshot(d);
  check("validator refuses a unit-guard rejection", !v.ok && v.errors.some(x=>x.includes("unit guard rejected")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.derivatives.venues.kraken.oi_usd *= 78_000;
  const v = validateSnapshot(d);
  check("validator catches Kraken raw/open-interest mismatch", !v.ok && v.errors.some(x=>x.includes("Kraken invariant")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.spot.usdt_usd=0.8;
  const v = validateSnapshot(d);
  check("validator rejects bad USDT/USD peg", !v.ok && v.errors.some(x=>x.includes("usdt_usd")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.exchange_supply.score=75;
  const v = validateSnapshot(d);
  check("validator prevents invented exchange-supply scoring", !v.ok && v.errors.some(x=>x.includes("exchange_supply score")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.etf.status="unavailable"; d.derivatives.aggregate.status="unavailable"; d.spot.status="error";
  const v = validateSnapshot(d);
  check("validator refuses all-sections-dead snapshot", !v.ok && v.errors.some(x=>x.includes("dead snapshot")), v.errors.join(" | "));
}
{
  const d = goodSnapshot(); d.derivatives.aggregate.core_expected_venues=["okx"];
  const v = validateSnapshot(d);
  check("validator locks fixed five-venue core", !v.ok && v.errors.some(x=>x.includes("core_expected_venues")), v.errors.join(" | "));
}

{
  const d = goodSnapshot();
  check("all required source-health sections are verified", d.health.overall.quality === "verified", JSON.stringify(d.health));
}
{
  const d = goodSnapshot();
  d.spot.kraken_usdt_usd = null;
  d.spot.usdt_usd = d.spot.coinbase_usdt_usd;
  d.spot.okx_usd_equivalent = d.spot.okx_usdt * d.spot.usdt_usd;
  d.spot.us_spot_premium_percent = +((d.spot.us_spot_average_usd/d.spot.okx_usd_equivalent-1)*100).toFixed(4);
  d.health = computeSourceHealth(d);
  check("one valid USDT quote is PARTIAL but usable", d.health.sections.spot.quality === "partial", JSON.stringify(d.health.sections.spot));
  check("partial spot health still validates", validateSnapshot(d).ok, validateSnapshot(d).errors.join(" | "));
}
{
  const d = goodSnapshot();
  d.spot.coinbase_usdt_usd = 0.998;
  d.spot.kraken_usdt_usd = 1.0025;
  d.spot.usdt_usd = (d.spot.coinbase_usdt_usd + d.spot.kraken_usdt_usd) / 2;
  d.spot.okx_usd_equivalent = d.spot.okx_usdt * d.spot.usdt_usd;
  d.spot.us_spot_premium_percent = +((d.spot.us_spot_average_usd/d.spot.okx_usd_equivalent-1)*100).toFixed(4);
  d.health = computeSourceHealth(d);
  check("divergent USDT quotes produce CONFLICT", d.health.sections.spot.quality === "conflict", JSON.stringify(d.health.sections.spot));
  check("a valid conflict snapshot is published with affected scoring gated", validateSnapshot(d).ok, validateSnapshot(d).errors.join(" | "));
}
{
  const d = goodSnapshot();
  d.derivatives.venues.kraken.funding_rate_percent = null;
  d.health = computeSourceHealth(d);
  check("missing Kraken funding does not invalidate Kraken OI", d.health.sections.derivatives_oi.quality === "verified");
  check("missing Kraken funding makes funding PARTIAL", d.health.sections.funding.quality === "partial", JSON.stringify(d.health.sections.funding));
}
{
  const d = goodSnapshot();
  delete d.health;
  const status = buildHealthStatus(d, { last_successful_at:"2026-08-22T17:00:00Z" });
  check("unclassified snapshot is rejected into publication CONFLICT", !status.snapshot_valid && status.health.sections.publication?.quality === "conflict", JSON.stringify(status));
  check("rejected attempt preserves last successful timestamp", status.last_successful_at === "2026-08-22T17:00:00Z");
}
{
  const d = goodSnapshot();
  d.sources.unit_guard_rejected = "kraken";
  d.derivatives.venues.kraken.status = "rejected";
  d.health = computeSourceHealth(d);
  const status = buildHealthStatus(d);
  check("unit rejection reports derivatives CONFLICT without a generic publication conflict", !status.snapshot_valid && status.health.sections.derivatives_oi.quality === "conflict" && !status.health.sections.publication, JSON.stringify(status));
}
{
  const d = goodSnapshot();
  d.derivatives.venues.bybit = { status:"error", core:false, error:"403" };
  d.health = computeSourceHealth(d);
  check("optional Bybit failure does not downgrade overall health", d.health.overall.quality === "verified", JSON.stringify(d.health));
}
{
  const d = goodSnapshot();
  d.derivatives.venues.kraken.status = "error";
  d.derivatives.aggregate.core_working_venues = CORE_VENUES.slice(0,4);
  d.derivatives.aggregate.core_missing_venues = ["kraken"];
  d.derivatives.aggregate.core_comparable_status = "incomplete";
  d.derivatives.aggregate.core_comparable_oi_usd = null;
  d.health = computeSourceHealth(d);
  check("four-of-five core coverage is PARTIAL", d.health.sections.derivatives_oi.quality === "partial", JSON.stringify(d.health.sections.derivatives_oi));
}
{
  const d = goodSnapshot();
  d.health.sections.spot.quality = "verified-but-tampered";
  const v = validateSnapshot(d);
  check("validator rejects tampered health classification", !v.ok && v.errors.some(x=>x.includes("health spot quality")), v.errors.join(" | "));
}

console.log(`\n${total-failed}/${total} collector safety tests passed`);
process.exit(failed ? 1 : 0);
