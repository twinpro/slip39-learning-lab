import fs from "node:fs";
import { shouldRecoverMarketSnapshot } from "./btc-market-recovery-lib.mjs";

const snapshotPath = process.env.BTC_MARKET_SNAPSHOT || new URL("../data/btc-market.json", import.meta.url);
const sidecarPath = process.env.BTC_MARKET_HEALTH || new URL("../data/btc-market-health.json", import.meta.url);
const outputPath = process.env.GITHUB_OUTPUT || "";
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
let sidecar = {};

try {
  sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
} catch {
  sidecar = {};
}

const result = shouldRecoverMarketSnapshot({
  snapshot,
  lastAttemptAt: sidecar.attempted_at || null
});

const lines = [
  `should_recover=${result.shouldRecover}`,
  `stale=${result.stale}`,
  `throttled=${result.throttled}`,
  `age_minutes=${result.ageMinutes}`,
  `stale_threshold_minutes=${result.staleThresholdMinutes}`,
  `throttle_minutes=${result.throttleMinutes}`
];

if (outputPath) fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
