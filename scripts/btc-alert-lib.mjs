export function outageState(snapshot, health, nowMs = Date.now()) {
  const generated = Date.parse(snapshot?.generated_at);
  const age = (nowMs - generated) / 60000;
  const stale = !Number.isFinite(age) || age < -1 || age > 180;
  const healthy = !stale && health?.snapshot_valid === true && ['verified', 'partial'].includes(health.health?.overall?.quality);
  const start = health?.unhealthy_since || (stale && Number.isFinite(generated) ? new Date(generated + 180 * 60000).toISOString() : health?.attempted_at);
  return { healthy, stale, since: start || null, alert: !healthy && Number.isFinite(Date.parse(start)) && nowMs - Date.parse(start) >= 24 * 3600000 };
}

export const OUTAGE_TITLE = 'BTC dashboard: prolonged data outage';
const outageMarker = since => `<!-- btc-outage:${since} -->`;
function managedSince(issue) {
  if (issue.pull_request) return null;
  const value = /<!-- btc-outage:([^\s]+) -->/.exec(issue.body || '')?.[1];
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

async function allPages(api, endpoint) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub list response');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

// The workflow concurrency group serializes this reconciliation. A closed issue
// for the same episode remains a deduplication record, including manual closure.
export async function reconcileOutageIssues(api, state, snapshot, health, repo) {
  if (!state.alert && !state.healthy) return;
  const issues = (await allPages(api, 'issues?state=all&sort=created&direction=asc'))
    .filter(issue => managedSince(issue));
  if (state.alert) {
    if (issues.some(issue => issue.state === 'open' || managedSince(issue) === state.since)) return;
    await api('issues', 'POST', {
      title: OUTAGE_TITLE,
      body: `Market data has been continuously unhealthy since ${state.since}.\n\nCurrent snapshot: ${snapshot?.generated_at || 'missing'}.\nSource quality: ${health?.health?.overall?.quality || 'unknown'}.\n\nInspect [collector logs](https://github.com/${repo}/actions/workflows/btc-market-data.yml). No values or scores have been fabricated. This issue stays open without repeat comments until recovery.\n\n${outageMarker(state.since)}`
    });
    return;
  }
  const recoveredAt = Date.parse(snapshot?.generated_at);
  if (!Number.isFinite(recoveredAt)) return;
  for (const issue of issues.filter(issue => issue.state === 'open' && Date.parse(managedSince(issue)) <= recoveredAt)) {
    const marker = `<!-- btc-recovery:${managedSince(issue)} -->`;
    const comments = await allPages(api, `issues/${issue.number}/comments`);
    if (!comments.some(comment => comment.body?.includes(marker))) {
      // Comment before closing; if PATCH fails, the next run reuses this marker.
      await api(`issues/${issue.number}/comments`, 'POST', {
        body: `Recovered: verified usable market data published at ${snapshot.generated_at}.\n\n${marker}`
      });
    }
    await api(`issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
  }
}
