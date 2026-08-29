import fs from "node:fs";

const file = process.env.BTC_MARKET_SNAPSHOT || new URL("../data/btc-market.json", import.meta.url);
const outputPath = process.env.GITHUB_ENV || "";
let before = "";
let allowInvalidBefore = false;

try {
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number.isFinite(Date.parse(snapshot?.generated_at || ""))) {
    before = snapshot.generated_at;
  } else {
    allowInvalidBefore = true;
  }
} catch {
  allowInvalidBefore = true;
}

const lines = [`BTC_MARKET_BEFORE_GENERATED_AT=${before}`];
if (allowInvalidBefore) lines.push("BTC_MARKET_ALLOW_INVALID_BEFORE=true");

if (outputPath) fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
