export function outageState(snapshot, health, nowMs = Date.now()) {
  const generated = Date.parse(snapshot?.generated_at);
  const age = (nowMs - generated) / 60000;
  const stale = !Number.isFinite(age) || age < -1 || age > 180;
  const healthy = !stale && health?.snapshot_valid === true && ['verified', 'partial'].includes(health.health?.overall?.quality);
  const start = health?.unhealthy_since || (stale && Number.isFinite(generated) ? new Date(generated + 180 * 60000).toISOString() : health?.attempted_at);
  return { healthy, stale, since: start || null, alert: !healthy && Number.isFinite(Date.parse(start)) && nowMs - Date.parse(start) >= 24 * 3600000 };
}
