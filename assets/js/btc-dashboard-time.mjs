export const BTC_DISPLAY_TIME_ZONE = "America/New_York";

function dateFrom(value) {
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
