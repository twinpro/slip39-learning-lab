import {
  num,
  guardVenueUnits,
  fiveSessionSpanDays,
  validateSnapshot,
  CORE_VENUES
} from "./btc-lib.mjs";

let total = 0, failed = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) console.log(`PASS ${String(total).padStart(2, "0")} ${name}`);
  else {
    failed++;
    console.error(`FAIL ${String(total).padStart(2, "0")} ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

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
  return {
    schema:12,
    generated_at:"2026-08-22T18:00:00Z",
    sources:{},
    etf:{
      status:"ok", latest_age_days:1, flow_5d_usd:150,
      last_5_trading_sessions:[1,2,3,4,5].map((x,i)=>({date:`2026-08-${18+i}`,flow_usd:x*10}))
    },
    derivatives:{ venues:venueRows, aggregate:{
      status:"ok", core_expected_venues:[...CORE_VENUES], core_working_venues:[...CORE_VENUES],
      core_missing_venues:[], core_comparable_status:"ok", core_comparable_oi_usd:sum
    }},
    spot:{ status:"ok", premium_status:"usdt_normalized", usdt_usd:0.9998, us_spot_average_usd:78000, okx_usd_equivalent:77990, us_spot_premium_percent:+((78000/77990-1)*100).toFixed(4) },
    exchange_supply:{ status:"unavailable_free_reliable", score:null }
  };
}

{
  const d = goodSnapshot();
  const v = validateSnapshot(d);
  check("known-good snapshot validates", v.ok, v.errors.join(" | "));
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

console.log(`\n${total-failed}/${total} collector safety tests passed`);
process.exit(failed ? 1 : 0);
