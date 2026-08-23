import fs from "node:fs/promises";
import { parseHistory, serializeHistory, updateHistoryRows } from "./btc-history-lib.mjs";

const SNAPSHOT = new URL("../data/btc-market.json", import.meta.url);
const HISTORY = new URL("../data/btc-market-history.jsonl", import.meta.url);

let snapshot;
try {
  snapshot = JSON.parse(await fs.readFile(SNAPSHOT, "utf8"));
} catch (e) {
  console.error("HISTORY UPDATE FAIL: cannot read verified data/btc-market.json:", String(e.message || e));
  process.exit(1);
}

let historyText = "";
try {
  historyText = await fs.readFile(HISTORY, "utf8");
} catch (e) {
  if (e?.code !== "ENOENT") {
    console.error("HISTORY UPDATE FAIL: cannot read data/btc-market-history.jsonl:", String(e.message || e));
    process.exit(1);
  }
}

try {
  const rows = parseHistory(historyText);
  const result = updateHistoryRows(rows, snapshot);
  if (!result.changed) {
    console.log(`HISTORY SKIP: UTC hour ${result.row.bucket_utc} already captured`);
    process.exit(0);
  }
  await fs.writeFile(HISTORY, serializeHistory(result.rows), "utf8");
  console.log(`HISTORY APPEND: ${result.row.bucket_utc} from snapshot ${result.row.generated_at}`);
  console.log(`HISTORY ROWS: ${result.rows.length}; retention=120 days; backfill=disabled`);
} catch (e) {
  console.error("HISTORY UPDATE FAIL:", String(e.message || e));
  process.exit(1);
}
