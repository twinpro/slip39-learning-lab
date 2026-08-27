import fs from "node:fs";

const data = JSON.parse(fs.readFileSync(new URL("../data/btc-macro.json", import.meta.url), "utf8"));
const required = [
  "dollar_exchange", "dollar_purchasing_power", "cpi", "pce_core", "fed_funds",
  "treasury_2y", "treasury_10y", "real_yield_10y", "m2", "fed_assets", "tga",
  "reverse_repo", "nasdaq", "vix", "unemployment", "gold", "oil", "btc_supply",
  "btc_hash", "btc_fees", "stablecoin_supply", "etf_flows", "futures_funding"
];
const events = ["fomc", "cpi", "pce", "employment"];
const failures = [];

function ok(condition, message) {
  if (!condition) failures.push(message);
}

ok(data.schema === 1, "schema must be 1");
ok(/\d{4}-\d{2}-\d{2}T/.test(data.generated_at || ""), "generated_at must be ISO-like");
ok(data.api_keys_required === false, "macro collector must be keyless");
ok(/do not predict its price/i.test(data.note || ""), "macro note must state non-predictive context");

const byId = new Map((data.series || []).map(s => [s.id, s]));
for (const id of required) {
  const s = byId.get(id);
  ok(!!s, `missing series ${id}`);
  if (!s) continue;
  ok(["ok", "unavailable"].includes(s.status), `${id} has invalid status`);
  ok(["Tailwind", "Neutral", "Headwind"].includes(s.weather), `${id} has invalid weather`);
  ok(typeof s.explanation === "string" && s.explanation.length > 8, `${id} needs explanation`);
  ok(typeof s.source === "string" && s.source.length > 2, `${id} needs source`);
  if (s.status === "ok") {
    ok(Number.isFinite(Number(s.latest_value)), `${id} ok series needs numeric latest value`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(s.observation_date || ""), `${id} needs observation date`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(s.data_start_date || ""), `${id} needs start date`);
    ok(Array.isArray(s.history) && s.history.length > 0, `${id} needs history`);
  } else {
    ok(s.latest_value === null, `${id} unavailable latest value must be null`);
    ok(!s.history || s.history.length === 0, `${id} unavailable history must be empty`);
  }
}

const eventIds = new Set((data.events || []).map(e => e.id));
for (const id of events) ok(eventIds.has(id), `missing event ${id}`);
for (const e of data.events || []) {
  ok(Date.parse(e.datetime), `${e.id} event datetime must parse`);
  ok(typeof e.source === "string" && e.source.length > 2, `${e.id} event needs source`);
  ok(Number.isFinite(Number(e.countdown_days)), `${e.id} event needs countdown`);
}

if (failures.length) {
  for (const f of failures) console.error("FAIL", f);
  process.exit(1);
}

console.log(`MACRO TEST PASS (${required.length} cards, ${events.length} events)`);
