export const BTC_DISPLAY_TIME_ZONE = "America/New_York";
export const BTC_FRESH_MINUTES = 60;
export const BTC_STALE_MINUTES = 180;

export const AUTOMATION_HEARTBEAT_LABELS = Object.freeze({
  running_verified: "AUTOMATION RUNNING · DATA VERIFIED",
  running_degraded: "AUTOMATION RUNNING · SOURCE DEGRADED",
  delayed: "AUTOMATION DELAYED",
  stale: "AUTOMATION STALE",
});

function timestampMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function classifyDashboardFreshness(ageMinutes) {
  if (!Number.isFinite(ageMinutes) || ageMinutes > BTC_STALE_MINUTES) return "stale";
  return ageMinutes > BTC_FRESH_MINUTES ? "delayed" : "fresh";
}

export function assessAutomationHeartbeat({
  attemptedAt,
  lastSuccessfulAt,
  snapshotValid,
  generatedAt,
  nowMs,
}) {
  const attemptedMs = timestampMs(attemptedAt);
  const lastSuccessfulMs = timestampMs(lastSuccessfulAt);
  const generatedMs = timestampMs(generatedAt);
  const currentMs = typeof nowMs === "number" ? nowMs : timestampMs(nowMs);
  const ageMinutes = attemptedMs == null || currentMs == null ? null : (currentMs - attemptedMs) / 60_000;
  const freshness = classifyDashboardFreshness(ageMinutes);
  const dataVerified = snapshotValid === true
    && attemptedMs != null
    && generatedMs != null
    && lastSuccessfulMs === generatedMs
    && attemptedMs >= generatedMs;

  const state = freshness === "stale"
    ? "stale"
    : freshness === "delayed"
      ? "delayed"
      : dataVerified
        ? "running_verified"
        : "running_degraded";

  return {
    state,
    label: AUTOMATION_HEARTBEAT_LABELS[state],
    freshness,
    ageMinutes,
    dataVerified,
  };
}

function dateFrom(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parts(value, options) {
  const date = dateFrom(value);
  if (!date) return null;
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BTC_DISPLAY_TIME_ZONE,
      ...options,
    }).formatToParts(date).map(({ type, value: part }) => [type, part]),
  );
}

export function formatEtDateTime(value) {
  const p = parts(value, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  if (!p) return "—";
  return `${p.month}/${p.day}/${p.year}, ${p.hour}:${p.minute}:${p.second} ${p.dayPeriod} ET`;
}

export function formatEtTime(value) {
  const p = parts(value, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  if (!p) return "—";
  return `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod} ET`;
}

export function formatEtHistoryTick(value, dateOnly = false) {
  if (dateOnly) {
    const p = parts(value, { month: "short", day: "numeric" });
    return p ? `${p.month} ${p.day} ET` : "—";
  }
  const p = parts(value, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return p ? `${p.month}/${p.day} ${p.hour}:${p.minute} ET` : "—";
}
