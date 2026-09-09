import fs from "node:fs";
import { assessEtfFreshness, num } from "./btc-lib.mjs";

const file = process.env.BTC_MARKET_SNAPSHOT || new URL("../data/btc-market.json", import.meta.url);
const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
const etf = snapshot.etf || {};
const fail = message => {
  console.error(`ETF HEALTH FAIL: ${message}`);
  process.exit(1);
};

if (etf.status !== "ok") fail(`ETF status is ${etf.status || "missing"}: ${etf.error || "no detail"}`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(etf.latest_date || ""))) fail(`latest_date is invalid: ${etf.latest_date}`);
if (num(etf.flow_5d_usd) == null) fail("flow_5d_usd is missing or non-finite");
const rows = Array.isArray(etf.last_5_trading_sessions) ? etf.last_5_trading_sessions : [];
if (rows.length !== 5) fail(`expected 5 ETF sessions, got ${rows.length}`);
for (const [index, row] of rows.entries()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || ""))) fail(`row ${index} date is invalid`);
  if (num(row?.flow_usd) == null) fail(`row ${index} flow_usd is missing or non-finite`);
}

const freshness = assessEtfFreshness(Date.parse(`${etf.latest_date}T00:00:00Z`), Date.parse(snapshot.generated_at));
if (!freshness.ok) fail(`freshness is ${freshness.status}: ${freshness.reason}`);
if (etf.freshness_status !== freshness.status) fail(`freshness_status mismatch: ${etf.freshness_status} vs ${freshness.status}`);
if (etf.expected_latest_session !== freshness.expectedLatestSession) fail(`expected_latest_session mismatch: ${etf.expected_latest_session} vs ${freshness.expectedLatestSession}`);
if (etf.sessions_behind !== freshness.sessionsBehind) fail(`sessions_behind mismatch: ${etf.sessions_behind} vs ${freshness.sessionsBehind}`);

console.log(`ETF HEALTH PASS: ${etf.freshness_status} · latest=${etf.latest_date} · expected=${etf.expected_latest_session} · sessionsBehind=${etf.sessions_behind} · flow=${etf.flow_5d_usd}`);
