// Staging and publication are separate: no failed candidate replaces public data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assessPublication } from './btc-publication-lib.mjs';
import { parseHistory, serializeHistory, updateHistoryRows, validateHistoryRows } from './btc-history-lib.mjs';
const root = process.env.BTC_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const snapshotPath = path.join(root, 'btc-market.json');
const healthPath = path.join(root, 'btc-market-health.json');
const historyPath = path.join(root, 'btc-market-history.jsonl');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'btc-candidate-'));
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
async function atomic(file, text) { await fs.writeFile(file + '.tmp', text); await fs.rename(file + '.tmp', file); }
try {
  const candidatePath = path.join(temp, 'candidate.json');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./update-btc-market.mjs', import.meta.url))], {
    stdio: 'inherit', env: { ...process.env, BTC_MARKET_OUTPUT: candidatePath, BTC_MARKET_PREVIOUS: snapshotPath }
  });
  if (run.status !== 0) throw new Error('Collector process failed');
  const candidate = await readJson(candidatePath);
  const { publish, status, result } = assessPublication(candidate, await readJson(healthPath));
  let history;
  if (publish) {
    let oldHistory = '';
    try { oldHistory = await fs.readFile(historyPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const updated = updateHistoryRows(parseHistory(oldHistory), candidate);
    const check = validateHistoryRows(updated.rows);
    if (!check.ok) throw new Error(check.errors.join('; '));
    history = serializeHistory(updated.rows);
  }
  await fs.mkdir(root, { recursive: true });
  await atomic(healthPath, JSON.stringify(status, null, 2) + '\n');
  if (publish) {
    await atomic(historyPath, history);
    await atomic(snapshotPath, JSON.stringify(candidate, null, 2) + '\n');
    console.log('PUBLICATION PASS: verified snapshot and history staged');
  } else {
    console.warn('::warning::Candidate rejected; existing snapshot and history preserved: ' + result.errors.join('; '));
  }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Market collection\n\nSnapshot published: ${publish}\n\nSource health: ${status.health.overall.quality}\n\n${JSON.stringify(candidate?.sources, null, 2)}\n\n${result.errors.join('\n')}\n`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
