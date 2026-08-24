/**
 * Write a small health sidecar for the latest collection attempt.
 *
 * This file may be published even when the market snapshot fails validation.
 * The invalid market data is restored by the workflow before commit, while the
 * sidecar lets the dashboard report the failed attempt and disable only the
 * affected section.
 */
import fs from "node:fs/promises";
import { buildHealthStatus } from "./btc-lib.mjs";

const SNAPSHOT = new URL("../data/btc-market.json", import.meta.url);
const STATUS = new URL("../data/btc-market-health.json", import.meta.url);

let previous = null;
try {
  previous = JSON.parse(await fs.readFile(STATUS, "utf8"));
} catch (e) {
  if (e?.code !== "ENOENT") console.warn("HEALTH STATUS WARN: previous sidecar unreadable");
}

let snapshot;
try {
  snapshot = JSON.parse(await fs.readFile(SNAPSHOT, "utf8"));
} catch (e) {
  console.error("HEALTH STATUS FAIL: cannot read generated market snapshot:", String(e.message || e));
  process.exit(1);
}

const status = buildHealthStatus(snapshot, previous);

await fs.writeFile(STATUS, JSON.stringify(status, null, 2) + "\n", "utf8");
console.log(`HEALTH STATUS WRITE: ${status.snapshot_valid ? "VALID" : "REJECTED"} · ${status.health.overall.quality.toUpperCase()}`);
if (!status.snapshot_valid) {
  for (const error of status.validation_errors) console.warn("HEALTH STATUS REJECTED:", error);
}
