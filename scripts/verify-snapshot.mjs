import fs from "node:fs/promises";
import { validateSnapshot } from "./btc-lib.mjs";

const file = new URL("../data/btc-market.json", import.meta.url);
let d;
try {
  d = JSON.parse(await fs.readFile(file, "utf8"));
} catch (e) {
  console.error("SNAPSHOT VERIFY FAIL: cannot read data/btc-market.json:", String(e.message || e));
  process.exit(1);
}

const result = validateSnapshot(d);
for (const w of result.warnings) console.warn("WARN:", w);
if (!result.ok) {
  for (const e of result.errors) console.error("FAIL:", e);
  console.error(`SNAPSHOT VERIFY FAILED (${result.errors.length} error${result.errors.length===1?"":"s"})`);
  process.exit(1);
}
console.log("SNAPSHOT VERIFY PASS");
