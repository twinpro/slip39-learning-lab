// Native GitHub issue alerts: one per prolonged outage, then one recovery closure.
import fs from 'node:fs/promises';
import { outageState, reconcileOutageIssues } from './btc-alert-lib.mjs';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) throw new Error('GitHub repository/token missing');
async function api(endpoint, method = 'GET', body) {
  const r = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, { method,
    signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function read(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
const snapshot = await read('data/btc-market.json');
const health = await read('data/btc-market-health.json');
const state = outageState(snapshot, health);
await reconcileOutageIssues(api, state, snapshot, health, repo);
// Watchdog only recovers a missed collector; provider degradation does not trigger extra jobs.
if (state.stale) {
  const lists = await Promise.all(['btc-market-data.yml', 'btc-market-recovery.yml'].map(w => api(`actions/workflows/${w}/runs?per_page=30`)));
  const recent = lists.flatMap(x => x.workflow_runs).some(r => r.status !== 'completed' || Date.now() - Date.parse(r.created_at) < 30 * 60000);
  if (!recent) await api('actions/workflows/btc-market-data.yml/dispatches', 'POST', { ref: 'main' });
}
console.log(JSON.stringify(state));
