import fs from "node:fs";

const page = fs.readFileSync(new URL("../pages/btc-real-vs-paper-v11b.html", import.meta.url), "utf8");
const macro = JSON.parse(fs.readFileSync(new URL("../data/btc-macro.json", import.meta.url), "utf8"));
const btc = JSON.parse(fs.readFileSync(new URL("../data/btc-daily-history.json", import.meta.url), "utf8"));
const failures = [];
const DAY = 86400000;

function ok(condition, message) {
  if (!condition) failures.push(message);
}

function rowsInRange(rows, range) {
  const t = Date.now();
  const start = range === "1y" ? t - 365 * DAY
    : range === "5y" ? t - 5 * 365 * DAY
    : range === "btc" ? Date.parse("2009-01-03T00:00:00Z")
    : 0;
  return (rows || []).filter(r => Number.isFinite(Number(r.value)) && Date.parse(`${r.date || ""}T00:00:00Z`) >= start);
}

function pairedMacroRows(macroRows, btcRows) {
  const btcByDate = new Map((btcRows || []).filter(r => Number(r.value) > 0).map(r => [r.date, Number(r.value)]));
  const pairs = (macroRows || []).filter(r => Number(r.value) > 0 && btcByDate.has(r.date)).map(r => ({ date: r.date, macro: Number(r.value), btc: btcByDate.get(r.date) }));
  const base = pairs[0];
  return base && base.macro > 0 && base.btc > 0 ? {
    macro: pairs.map(r => ({ date: r.date, value: r.macro / base.macro * 100 })),
    btc: pairs.map(r => ({ date: r.date, value: r.btc / base.btc * 100 }))
  } : { macro: [], btc: [] };
}

function pathFor(rows, domainRows) {
  const times = domainRows.map(p => Date.parse(`${p.date}T00:00:00Z`)).filter(Number.isFinite);
  const vals = rows.map(p => p.value);
  const x0 = Math.min(...times), x1 = Math.max(...times);
  const y0 = Math.min(...vals) * .96, y1 = Math.max(...vals) * 1.04, yr = (y1 - y0) || 1;
  const m = { l: 34, r: 10, t: 12, b: 24 }, w = 640, h = 230, pw = w - m.l - m.r, ph = h - m.t - m.b;
  const px = t => m.l + (t - x0) / (x1 - x0 || 1) * pw;
  const py = v => m.t + (1 - (v - y0) / yr) * ph;
  return rows.map((p, i) => `${i ? "L" : "M"}${px(Date.parse(`${p.date}T00:00:00Z`)).toFixed(1)} ${py(p.value).toFixed(1)}`).join(" ");
}

const btcRows = (btc.observations || []).map(r => ({ date: String(r.time).slice(0, 10), value: Number(r.PriceUSD) })).filter(r => r.date && Number.isFinite(r.value));
const required = ["dollar_exchange", "gold", "nasdaq", "fed_funds"];

ok(page.includes("<svg id=\"macroChart\""), "macro chart must render as visible SVG");
ok(page.includes("macro-line-selected"), "selected macro series path must be rendered");
ok(page.includes("macroLegend"), "macro chart must include a legend");

for (const id of required) {
  const card = macro.series.find(s => s.id === id);
  ok(!!card, `${id} must exist`);
  if (!card) continue;
  const paths = {};
  for (const range of ["1y", "5y", "btc", "max"]) {
    const paired = pairedMacroRows(rowsInRange(card.history, range), rowsInRange(btcRows, range));
    ok(paired.macro.length >= 2, `${id} ${range} must have a visible macro path`);
    ok(paired.btc.length >= 2, `${id} ${range} must have a visible BTC path`);
    paths[range] = pathFor(paired.macro, [...rowsInRange(card.history, range), ...rowsInRange(btcRows, range)]);
  }
  ok(new Set(Object.values(paths)).size > 1, `${id} range changes must alter rendered path geometry`);
}

const dxy = macro.series.find(s => s.id === "dollar_exchange");
if (dxy) {
  const since = pairedMacroRows(rowsInRange(dxy.history, "btc"), rowsInRange(btcRows, "btc"));
  const max = pairedMacroRows(rowsInRange(dxy.history, "max"), rowsInRange(btcRows, "max"));
  ok(pathFor(since.macro, [...rowsInRange(dxy.history, "btc"), ...rowsInRange(btcRows, "btc")]) !== pathFor(max.macro, [...rowsInRange(dxy.history, "max"), ...rowsInRange(btcRows, "max")]), "DXY Since Bitcoin and Maximum ranges must render different geometry");
}

if (failures.length) {
  for (const failure of failures) console.error("FAIL", failure);
  process.exit(1);
}

console.log("MACRO CHART INTERACTION TEST PASS");
