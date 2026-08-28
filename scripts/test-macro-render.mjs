import fs from "node:fs";

const page = fs.readFileSync(new URL("../pages/btc-real-vs-paper-v11b.html", import.meta.url), "utf8");
const data = JSON.parse(fs.readFileSync(new URL("../data/btc-macro.json", import.meta.url), "utf8"));
const failures = [];

function ok(condition, message) {
  if (!condition) failures.push(message);
}

ok(page.includes("BTC MACRO WEATHER"), "page must include BTC Macro Weather section");
ok(page.includes("macroCards"), "page must include macro card container");
ok(page.includes("macroEvents"), "page must include macro event container");
ok(page.includes("btc-macro.json"), "page must load generated macro data");
ok(page.includes("macro-regime"), "page must render BTC macro regime correlations");
ok(page.includes("MIXED/TRANSITION"), "page must include macro regime labels");
ok(page.includes("pairedMacroRows"), "macro comparison chart must pair BTC and macro dates");
ok(page.includes("btcByDate.has"), "macro comparison chart must require matching BTC dates");
ok(page.includes("does not affect the Real-vs-Paper score"), "page must state score separation");
ok(page.includes("correlation does not prove causation"), "page must state correlation caveat");
ok(!page.includes("macroScore"), "page must not create a macro score");
ok(data.series.some(s => s.status === "unavailable" && s.latest_value === null), "unavailable data must remain unknown");
ok(data.series.filter(s => s.status === "ok").length >= 12, "macro render needs available cards");

if (failures.length) {
  for (const f of failures) console.error("FAIL", f);
  process.exit(1);
}

console.log("MACRO RENDER TEST PASS");
