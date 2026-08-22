/** Read-only compact health report for the just-generated BTC snapshot. */
import fs from "node:fs/promises";

const file = new URL("../data/btc-market.json", import.meta.url);
let d;
try {
  d = JSON.parse(await fs.readFile(file, "utf8"));
} catch (e) {
  console.log("could not read data/btc-market.json: " + String(e.message || e));
  process.exit(0);
}

const pad = (v,n) => String(v ?? "-").padEnd(n);
const money = v => v == null ? "-" : v >= 1e9 ? `$${(v/1e9).toFixed(3)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : `$${Number(v).toFixed(0)}`;

console.log(`\nBTC REAL VS PAPER SNAPSHOT  ${d.generated_at}  schema=${d.schema}`);
console.log("=".repeat(112));
console.log(pad("VENUE",14)+pad("STATUS",11)+pad("OI USD",14)+pad("IMPLIED BTC",15)+pad("FUND %8H",12)+"UNIT / NOTE");
console.log("-".repeat(112));
for (const [name,v] of Object.entries(d.derivatives?.venues ?? {})) {
  console.log(
    pad(name,14)+pad(v.status,11)+pad(money(v.oi_usd),14)+pad(v.implied_btc ?? "-",15)+
    pad(v.funding_rate_percent == null ? "-" : Number(v.funding_rate_percent).toFixed(5),12)+
    (v.rejected_reason || v.unit_check || v.error || v.contract || "")
  );
}
const ag=d.derivatives?.aggregate ?? {};
console.log("-".repeat(112));
console.log(`CORE ${ag.core_comparable_status ?? "-"}  working=${(ag.core_working_venues||[]).join(",") || "-"}  missing=${(ag.core_missing_venues||[]).join(",") || "none"}`);
console.log(`OI ${money(ag.core_comparable_oi_usd ?? ag.oi_usd)}  weighted funding=${ag.funding_rate_percent == null ? "-" : Number(ag.funding_rate_percent).toFixed(5)+"%"}`);
console.log(`ETF ${d.etf?.status ?? "-"}  5-session=${money(d.etf?.flow_5d_usd)}  latest=${d.etf?.latest_date ?? "-"}`);
console.log(`SPOT ${d.spot?.status ?? "-"}  premium=${d.spot?.us_spot_premium_percent ?? "-"}%  USDT/USD=${d.spot?.usdt_usd ?? "-"}`);
console.log(`EXCHANGE SUPPLY ${d.exchange_supply?.status ?? "-"}  score=${d.exchange_supply?.score ?? "null (expected)"}`);
if (d.sources?.unit_guard_rejected) console.log(`UNIT GUARD REJECTED: ${d.sources.unit_guard_rejected}`);
console.log("");
