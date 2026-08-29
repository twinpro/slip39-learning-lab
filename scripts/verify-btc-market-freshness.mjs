import fs from "node:fs";
import { execFileSync } from "node:child_process";

const file = process.env.BTC_MARKET_SNAPSHOT || new URL("../data/btc-market.json", import.meta.url);
const before = process.env.BTC_MARKET_BEFORE_GENERATED_AT || "";
const mode = process.argv[2] || "after-collect";
const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
const after = snapshot.generated_at || "";
const beforeMs = Date.parse(before);
const afterMs = Date.parse(after);

function fail(message) {
  console.error(`BTC MARKET FRESHNESS FAIL: ${message}`);
  process.exit(1);
}

if (!Number.isFinite(afterMs)) fail("data/btc-market.json generated_at is missing or invalid");

if (mode === "after-collect") {
  if (!Number.isFinite(beforeMs)) {
    if (process.env.BTC_MARKET_ALLOW_INVALID_BEFORE === "true") {
      console.log(`BTC market generated_at recovered from invalid pre-run timestamp: ${after}`);
    } else {
      fail("pre-collection generated_at is missing or invalid");
    }
  } else if (afterMs <= beforeMs) fail(`generated_at did not advance: before=${before} after=${after}`);
  console.log(`BTC market generated_at advanced: ${before} -> ${after}`);
} else if (mode === "after-commit") {
  const status = execFileSync("git", ["status", "--porcelain", "--", "data/btc-market.json", "data/btc-market-history.jsonl", "data/btc-market-health.json"], { encoding: "utf8" }).trim();
  if (status) fail(`market data changes remain uncommitted:\n${status}`);
  console.log(`BTC market data commit check passed at generated_at=${after}`);
} else {
  fail(`unknown mode ${mode}`);
}
