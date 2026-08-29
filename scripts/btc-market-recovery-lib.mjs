export const RECOVERY_STALE_MINUTES = 120;
export const RECOVERY_MIN_TRIGGER_INTERVAL_MINUTES = 30;

export function marketSnapshotAgeMinutes(snapshot, nowMs = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generated_at || "");
  if (!Number.isFinite(generatedAt)) return Infinity;
  return Math.floor((nowMs - generatedAt) / 60000);
}

export function shouldRecoverMarketSnapshot({ snapshot, nowMs = Date.now(), lastAttemptAt = null } = {}) {
  const ageMinutes = marketSnapshotAgeMinutes(snapshot, nowMs);
  const lastAttemptMs = Date.parse(lastAttemptAt || "");
  const minutesSinceLastAttempt = Number.isFinite(lastAttemptMs)
    ? Math.floor((nowMs - lastAttemptMs) / 60000)
    : Infinity;
  const stale = ageMinutes >= RECOVERY_STALE_MINUTES;
  const throttled = minutesSinceLastAttempt < RECOVERY_MIN_TRIGGER_INTERVAL_MINUTES;
  return {
    shouldRecover: stale && !throttled,
    stale,
    throttled,
    ageMinutes,
    minutesSinceLastAttempt,
    staleThresholdMinutes: RECOVERY_STALE_MINUTES,
    throttleMinutes: RECOVERY_MIN_TRIGGER_INTERVAL_MINUTES
  };
}
