import {
  CORE_VENUES,
  DAY_MS,
  buildHistoryRow,
  parseHistory,
  serializeHistory,
  updateHistoryRows,
  validateHistoryRows
} from "./btc-history-lib.mjs";

let total = 0, failed = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) console.log(`PASS ${String(total).padStart(2, "0")} ${name}`);
  else {
    failed++;
    console.error(`FAIL ${String(total).padStart(2, "0")} ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function goodSnapshot(iso = "2026-08-22T19:07:00.000Z") {
  return {
    schema: 12,
    generated_at: iso,
    etf: { status: "ok", flow_5d_usd: 1_900_000_000, latest_date: "2026-08-21" },
    spot: { status: "ok", coinbase_usd: 77_250, premium_status: "usdt_normalized", us_spot_premium_percent: 0.0177, usdt_usd: 0.9999 },
    derivatives: { aggregate: {
      core_expected_venues: [...CORE_VENUES],
      core_working_venues: [...CORE_VENUES],
      core_missing_venues: [],
      core_comparable_status: "ok",
      core_comparable_oi_usd: 6_000_000_000,
      funding_rate_percent: 0.0125,
      funding_venue_count: 5,
      funding_venues: [...CORE_VENUES]
    }}
  };
}

{
  const row = buildHistoryRow(goodSnapshot());
  check("UTC bucket is aligned to the hour", row.bucket_utc === "2026-08-22T19:00:00.000Z", row.bucket_utc);
  check("history stores Coinbase snapshot price", row.btc_price_usd === 77_250);
  check("history stores normalized spot premium", row.spot.us_spot_premium_percent === 0.0177);
  check("complete fixed core stores comparable OI", row.derivatives.core_comparable_oi_usd === 6_000_000_000);
  check("complete fixed funding set is comparable", row.derivatives.funding_comparable === true);
  check("history row does not store exchange supply", !("exchange_supply" in row));
}

{
  const first = updateHistoryRows([], goodSnapshot("2026-08-22T19:07:00.000Z"));
  check("first verified snapshot appends", first.changed && first.rows.length === 1);
  const sameHour = updateHistoryRows(first.rows, goodSnapshot("2026-08-22T19:37:00.000Z"));
  check("later snapshot in same UTC hour is deduplicated", !sameHour.changed && sameHour.rows.length === 1);
  const nextHour = updateHistoryRows(first.rows, goodSnapshot("2026-08-22T20:07:00.000Z"));
  check("next UTC hour appends", nextHour.changed && nextHour.rows.length === 2);
}

{
  const newer = updateHistoryRows([], goodSnapshot("2026-08-22T20:07:00.000Z")).rows;
  let rejected = false;
  try { updateHistoryRows(newer, goodSnapshot("2026-08-22T19:07:00.000Z")); } catch { rejected = true; }
  check("backfill older than latest bucket is rejected", rejected);
}

{
  const current = Date.parse("2026-08-22T19:07:00.000Z");
  const old = goodSnapshot(new Date(current - 121 * DAY_MS).toISOString());
  old.etf.latest_date = new Date(current - 121 * DAY_MS).toISOString().slice(0, 10);
  const oldRows = updateHistoryRows([], old).rows;
  const currentRows = updateHistoryRows(oldRows, goodSnapshot("2026-08-22T19:07:00.000Z")).rows;
  check("rows older than 120 days are pruned", currentRows.length === 1 && currentRows[0].bucket_utc === "2026-08-22T19:00:00.000Z", JSON.stringify(currentRows.map(r => r.bucket_utc)));
}

{
  const s = goodSnapshot();
  s.derivatives.aggregate.core_working_venues = CORE_VENUES.slice(0, 4);
  s.derivatives.aggregate.core_missing_venues = ["kraken"];
  s.derivatives.aggregate.core_comparable_status = "incomplete";
  const row = buildHistoryRow(s);
  check("incomplete fixed core stores OI as null", row.derivatives.core_comparable_oi_usd === null);
  check("incomplete fixed core row still validates", validateHistoryRows([row], { nowMs: Date.parse(s.generated_at) }).ok);
}

{
  const s = goodSnapshot();
  s.derivatives.aggregate.funding_venues = CORE_VENUES.slice(0, 4);
  s.derivatives.aggregate.funding_venue_count = 4;
  const row = buildHistoryRow(s);
  check("partial funding set is flagged non-comparable", row.derivatives.funding_comparable === false);
  check("partial funding observation is retained for diagnostics", row.derivatives.weighted_funding_percent === 0.0125);
}

{
  const s = goodSnapshot();
  s.spot.premium_status = "raw_unverified";
  const row = buildHistoryRow(s);
  check("unnormalized spot premium is not stored as comparable", row.spot.us_spot_premium_percent === null && row.spot.usdt_usd === null);
}

{
  const s = goodSnapshot();
  s.health = { sections:{ spot:{ quality:"conflict" }, etf:{ quality:"verified" } } };
  const row = buildHistoryRow(s);
  check("conflicted spot health creates a history gap", row.spot.status === "conflict" && row.spot.us_spot_premium_percent === null);
}

{
  let rejected = false;
  try { parseHistory('{"ok":1}\n{bad json}\n'); } catch { rejected = true; }
  check("malformed JSONL is rejected", rejected);
}

{
  const row = buildHistoryRow(goodSnapshot());
  const result = validateHistoryRows([row, structuredClone(row)], { nowMs: Date.parse(row.generated_at) });
  check("duplicate UTC buckets are rejected", !result.ok && result.errors.some(e => e.includes("strictly increasing")), result.errors.join(" | "));
}

{
  const row = buildHistoryRow(goodSnapshot());
  row.exchange_supply = { score: 75 };
  const result = validateHistoryRows([row], { nowMs: Date.parse(row.generated_at) });
  check("history validator blocks invented exchange-supply storage", !result.ok && result.errors.some(e => e.includes("exchange_supply")), result.errors.join(" | "));
}

{
  const rows = [buildHistoryRow(goodSnapshot())];
  const roundTrip = parseHistory(serializeHistory(rows));
  check("JSONL serialize/parse round trip is stable", JSON.stringify(roundTrip) === JSON.stringify(rows));
}

console.log(`\n${total - failed}/${total} history safety tests passed`);
process.exit(failed ? 1 : 0);
