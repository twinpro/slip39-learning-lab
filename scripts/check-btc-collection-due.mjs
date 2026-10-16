import fs from 'node:fs';
let previous;
try { previous = JSON.parse(fs.readFileSync('data/btc-market-health.json','utf8')); } catch {}
const age = (Date.now() - Date.parse(previous?.attempted_at)) / 60000;
// Code pushes always validate/deploy; duplicate dispatches share a bounded retry cadence.
const due = process.env.GITHUB_EVENT_NAME === 'push' || !Number.isFinite(age) || age < 0 || age >= 25;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
console.log(due ? 'Collection due' : `Recent attempt ${age.toFixed(1)} minutes ago; duplicate dispatch skipped`);
