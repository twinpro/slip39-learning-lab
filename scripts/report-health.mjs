/**
 * report-health.mjs — prints what the collector just wrote, in a form where a
 * unit error is obvious at a glance. Replaces inline `node -e` in the workflow,
 * where shell quoting around $ was a live footgun.
 */
import fs from "node:fs";

const d = JSON.parse(fs.readFileSync(new URL("../data/btc-market.json", import.meta.url), "utf8"));
const pad = (s, n) => String(s ?? "").padEnd(n);
const b = v => v == null ? "-" : (v / 1e9).toFixed(4) + "B";

console.log("\nSNAPSHOT " + d.generated_at + "  schema " + d.schema);
console.log("=".repeat(104));
console.log(pad("VENUE", 14) + pad("STATUS", 11) + pad("OI USD", 12) + pad("IMPLIED BTC", 14) + pad("MARK DEV %", 12) + "NOTE");
console.log("-".repeat(104));

for (const [k, v] of Object.entries(d.derivatives.venues)){
  console.log(
    pad(k, 14) + pad(v.status, 11) + pad(b(v.oi_usd), 12) +
    pad(v.implied_btc ?? "-", 14) +
    pad(v.mark_deviation_percent ?? "-", 12) +
    (v.rejected_reason || v.mark_warning || v.funding_rejected_reason || v.error || v.contract || "")
  );
}

const ag = d.derivatives.aggregate;
console.log("-".repeat(104));
console.log("AGGREGATE     " + pad(ag.status, 11) + pad(b(ag.oi_usd), 12) +
            "venues: " + (ag.venue_set || "-"));
if (d.sources.plausibility_rejected) console.log("REJECTED      " + d.sources.plausibility_rejected);

console.log("\nETF       " + d.etf.status +
            "  source=" + (d.etf.source ?? "-") +
            "  latest=" + (d.etf.latest_date ?? "-") +
            "  5d=" + (d.etf.flow_5d_usd != null ? "$" + (d.etf.flow_5d_usd / 1e6).toFixed(1) + "M" : "-") +
            "  cross-check=" + (d.etf.cross_check?.agreement ?? "-") +
            (d.etf.cross_check?.divergence_percent != null ? " (" + d.etf.cross_check.divergence_percent + "%)" : "") +
            (d.etf.error ? "  error=" + d.etf.error : ""));

console.log("PREMIUM   " + (d.spot.premium_status ?? d.spot.status) +
            "  raw=" + (d.spot.us_spot_premium_percent_raw ?? "-") + "%" +
            "  adjusted=" + (d.spot.us_spot_premium_percent ?? "UNSCORED") +
            "  usdc_usdt=" + (d.spot.usdc_usdt ?? "-"));

console.log("\nSOURCES");
for (const [k, v] of Object.entries(d.sources)) console.log("  " + pad(k, 26) + v);
console.log("");
