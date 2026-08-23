import fs from "node:fs/promises";
import { parseHistory, validateHistoryRows } from "./btc-history-lib.mjs";

const HISTORY = new URL("../data/btc-market-history.jsonl", import.meta.url);
let rows;
try {
  rows = parseHistory(await fs.readFile(HISTORY, "utf8"));
} catch (e) {
  console.error("HISTORY VERIFY FAIL: cannot parse data/btc-market-history.jsonl:", String(e.message || e));
  process.exit(1);
}

const result = validateHistoryRows(rows);
for (const w of result.warnings) console.warn("WARN:", w);
if (!result.ok) {
  for (const e of result.errors) console.error("FAIL:", e);
  console.error(`HISTORY VERIFY FAILED (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log(`HISTORY VERIFY PASS (${rows.length} row${rows.length === 1 ? "" : "s"})`);
