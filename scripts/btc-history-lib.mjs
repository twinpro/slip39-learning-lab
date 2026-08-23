export const HISTORY_SCHEMA = 1;
export const METHODOLOGY_VERSION = 12;
export const RETENTION_DAYS = 120;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const CORE_VENUES = ["okx", "deribit", "bitmex", "hyperliquid", "kraken"];

const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = value => isFiniteNumber(value) ? value : null;
const arrayOfStrings = value => Array.isArray(value) && value.every(x => typeof x === "string");
const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const unique = arr => new Set(arr).size === arr.length;

function utcHourIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid generated_at: ${value}`);
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
}

function normalizedCore(aggregate = {}) {
  const expected = Array.isArray(aggregate.core_expected_venues)
    ? aggregate.core_expected_venues.filter(x => typeof x === "string")
    : [];
  const working = Array.isArray(aggregate.core_working_venues)
    ? aggregate.core_working_venues.filter(x => typeof x === "string")
    : [];
  const missing = Array.isArray(aggregate.core_missing_venues)
    ? aggregate.core_missing_venues.filter(x => typeof x === "string")
    : [];
  const complete = sameArray(expected, CORE_VENUES) && sameArray(working, CORE_VENUES) && missing.length === 0 && aggregate.core_comparable_status === "ok";
  return { expected, working, missing, complete };
}

function normalizedFunding(aggregate = {}) {
  const venues = Array.isArray(aggregate.funding_venues)
    ? aggregate.funding_venues.filter(x => typeof x === "string")
    : [];
  const comparable = sameArray(venues, CORE_VENUES) && Number(aggregate.funding_venue_count) === CORE_VENUES.length;
  return { venues, comparable };
}

export function buildHistoryRow(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot must be an object");
  if (snapshot.schema !== METHODOLOGY_VERSION) throw new Error(`snapshot schema must be ${METHODOLOGY_VERSION}`);
  const generatedAt = snapshot.generated_at;
  const bucketUtc = utcHourIso(generatedAt);
  const aggregate = snapshot.derivatives?.aggregate ?? {};
  const core = normalizedCore(aggregate);
  const funding = normalizedFunding(aggregate);

  const spotOk = snapshot.spot?.status === "ok";
  const premiumNormalized = spotOk && snapshot.spot?.premium_status === "usdt_normalized";
  const etfOk = snapshot.etf?.status === "ok";

  return {
    history_schema: HISTORY_SCHEMA,
    methodology_version: METHODOLOGY_VERSION,
    bucket_utc: bucketUtc,
    generated_at: generatedAt,
    btc_price_usd: spotOk ? finiteOrNull(snapshot.spot?.coinbase_usd) : null,
    etf: {
      status: String(snapshot.etf?.status ?? "unavailable"),
      flow_5_sessions_usd: etfOk ? finiteOrNull(snapshot.etf?.flow_5d_usd) : null,
      latest_session_date: etfOk && typeof snapshot.etf?.latest_date === "string" ? snapshot.etf.latest_date : null
    },
    spot: {
      status: String(snapshot.spot?.status ?? "unavailable"),
      premium_status: String(snapshot.spot?.premium_status ?? "unavailable"),
      us_spot_premium_percent: premiumNormalized ? finiteOrNull(snapshot.spot?.us_spot_premium_percent) : null,
      usdt_usd: premiumNormalized ? finiteOrNull(snapshot.spot?.usdt_usd) : null
    },
    derivatives: {
      core_expected_venues: core.expected,
      core_working_venues: core.working,
      core_missing_venues: core.missing,
      core_comparable_status: String(aggregate.core_comparable_status ?? "unavailable"),
      core_comparable_oi_usd: core.complete ? finiteOrNull(aggregate.core_comparable_oi_usd) : null,
      weighted_funding_percent: finiteOrNull(aggregate.funding_rate_percent),
      funding_venue_count: Number.isInteger(aggregate.funding_venue_count) ? aggregate.funding_venue_count : funding.venues.length,
      funding_venues: funding.venues,
      funding_comparable: funding.comparable
    }
  };
}

export function parseHistory(text) {
  if (typeof text !== "string") throw new Error("history text must be a string");
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`history line ${i + 1} is invalid JSON: ${e.message}`);
    }
  }
  return rows;
}

function validDateOnly(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function checkFiniteOrNull(errors, path, value, { min = -Infinity, max = Infinity } = {}) {
  if (value === null) return;
  if (!isFiniteNumber(value) || value < min || value > max) errors.push(`${path} must be finite or null`);
}

export function validateHistoryRows(rows, { nowMs = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(rows)) return { ok: false, errors: ["history must be an array"], warnings };

  let previousBucketMs = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const p = `row ${i + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`${p} must be an object`);
      continue;
    }
    if (row.history_schema !== HISTORY_SCHEMA) errors.push(`${p} history_schema must be ${HISTORY_SCHEMA}`);
    if (row.methodology_version !== METHODOLOGY_VERSION) errors.push(`${p} methodology_version must be ${METHODOLOGY_VERSION}`);
    if (Object.prototype.hasOwnProperty.call(row, "exchange_supply")) errors.push(`${p} must not store exchange_supply`);
    if (Object.prototype.hasOwnProperty.call(row, "supply_squeeze")) errors.push(`${p} must not store supply_squeeze`);

    const bucketMs = Date.parse(row.bucket_utc);
    const generatedMs = Date.parse(row.generated_at);
    if (!Number.isFinite(bucketMs)) errors.push(`${p} bucket_utc is invalid`);
    if (!Number.isFinite(generatedMs)) errors.push(`${p} generated_at is invalid`);
    if (Number.isFinite(bucketMs)) {
      if (new Date(bucketMs).toISOString() !== row.bucket_utc) errors.push(`${p} bucket_utc must be canonical ISO UTC`);
      if (bucketMs % HOUR_MS !== 0) errors.push(`${p} bucket_utc must be aligned to the UTC hour`);
      if (bucketMs > nowMs + 5 * 60_000) errors.push(`${p} bucket_utc is in the future`);
      if (previousBucketMs !== null && bucketMs <= previousBucketMs) errors.push(`${p} bucket_utc must be strictly increasing with no duplicates`);
      previousBucketMs = bucketMs;
    }
    if (Number.isFinite(generatedMs)) {
      if (new Date(generatedMs).toISOString() !== row.generated_at) errors.push(`${p} generated_at must be canonical ISO UTC`);
      if (generatedMs > nowMs + 5 * 60_000) errors.push(`${p} generated_at is in the future`);
      if (Number.isFinite(bucketMs) && Math.floor(generatedMs / HOUR_MS) * HOUR_MS !== bucketMs) errors.push(`${p} generated_at must fall inside bucket_utc hour`);
    }

    checkFiniteOrNull(errors, `${p}.btc_price_usd`, row.btc_price_usd, { min: 0 });
    if (row.btc_price_usd === 0) errors.push(`${p}.btc_price_usd must be positive when present`);

    const etf = row.etf;
    if (!etf || typeof etf !== "object" || Array.isArray(etf)) errors.push(`${p}.etf must be an object`);
    else {
      if (typeof etf.status !== "string") errors.push(`${p}.etf.status must be a string`);
      checkFiniteOrNull(errors, `${p}.etf.flow_5_sessions_usd`, etf.flow_5_sessions_usd);
      if (!validDateOnly(etf.latest_session_date)) errors.push(`${p}.etf.latest_session_date must be YYYY-MM-DD or null`);
      if (etf.status === "ok" && (!isFiniteNumber(etf.flow_5_sessions_usd) || etf.latest_session_date === null)) errors.push(`${p}.etf ok status requires verified flow and latest session date`);
    }

    const spot = row.spot;
    if (!spot || typeof spot !== "object" || Array.isArray(spot)) errors.push(`${p}.spot must be an object`);
    else {
      if (typeof spot.status !== "string" || typeof spot.premium_status !== "string") errors.push(`${p}.spot status fields must be strings`);
      checkFiniteOrNull(errors, `${p}.spot.us_spot_premium_percent`, spot.us_spot_premium_percent);
      checkFiniteOrNull(errors, `${p}.spot.usdt_usd`, spot.usdt_usd, { min: 0 });
      if (spot.us_spot_premium_percent !== null && spot.premium_status !== "usdt_normalized") errors.push(`${p} may store premium only when premium_status is usdt_normalized`);
      if (spot.premium_status === "usdt_normalized" && spot.status === "ok" && (!isFiniteNumber(spot.us_spot_premium_percent) || !isFiniteNumber(spot.usdt_usd))) errors.push(`${p} normalized spot status requires premium and USDT/USD`);
    }

    const d = row.derivatives;
    if (!d || typeof d !== "object" || Array.isArray(d)) errors.push(`${p}.derivatives must be an object`);
    else {
      for (const key of ["core_expected_venues", "core_working_venues", "core_missing_venues", "funding_venues"]) {
        if (!arrayOfStrings(d[key])) errors.push(`${p}.derivatives.${key} must be an array of strings`);
        else if (!unique(d[key])) errors.push(`${p}.derivatives.${key} must not contain duplicates`);
      }
      if (arrayOfStrings(d.core_expected_venues) && !sameArray(d.core_expected_venues, CORE_VENUES)) errors.push(`${p} fixed core venue set/order changed`);
      if (arrayOfStrings(d.core_working_venues) && d.core_working_venues.some(v => !CORE_VENUES.includes(v))) errors.push(`${p} core_working_venues contains non-core venue`);
      if (arrayOfStrings(d.core_missing_venues) && d.core_missing_venues.some(v => !CORE_VENUES.includes(v))) errors.push(`${p} core_missing_venues contains non-core venue`);
      if (arrayOfStrings(d.core_working_venues) && arrayOfStrings(d.core_missing_venues)) {
        const expectedMissing = CORE_VENUES.filter(v => !d.core_working_venues.includes(v));
        if (!sameArray(d.core_missing_venues, expectedMissing)) errors.push(`${p} core_missing_venues does not match working set`);
      }
      const coreComplete = sameArray(d.core_working_venues, CORE_VENUES) && Array.isArray(d.core_missing_venues) && d.core_missing_venues.length === 0 && d.core_comparable_status === "ok";
      checkFiniteOrNull(errors, `${p}.derivatives.core_comparable_oi_usd`, d.core_comparable_oi_usd, { min: 0 });
      if (coreComplete && !isFiniteNumber(d.core_comparable_oi_usd)) errors.push(`${p} complete core requires comparable OI`);
      if (!coreComplete && d.core_comparable_oi_usd !== null) errors.push(`${p} incomplete core must store comparable OI as null`);

      checkFiniteOrNull(errors, `${p}.derivatives.weighted_funding_percent`, d.weighted_funding_percent);
      if (!Number.isInteger(d.funding_venue_count) || d.funding_venue_count < 0) errors.push(`${p}.derivatives.funding_venue_count must be a nonnegative integer`);
      if (arrayOfStrings(d.funding_venues)) {
        if (d.funding_venues.some(v => !CORE_VENUES.includes(v))) errors.push(`${p} funding_venues contains non-core venue`);
        if (Number.isInteger(d.funding_venue_count) && d.funding_venue_count !== d.funding_venues.length) errors.push(`${p} funding_venue_count does not match funding_venues`);
        const fundingComplete = sameArray(d.funding_venues, CORE_VENUES);
        if (d.funding_comparable !== fundingComplete) errors.push(`${p} funding_comparable does not match fixed-core funding coverage`);
        if (d.funding_venues.length > 0 && !isFiniteNumber(d.weighted_funding_percent)) errors.push(`${p} funding venues present but weighted funding is missing`);
      }
      if (typeof d.funding_comparable !== "boolean") errors.push(`${p}.derivatives.funding_comparable must be boolean`);
    }
  }

  if (rows.length > 1) {
    const firstMs = Date.parse(rows[0].bucket_utc);
    const lastMs = Date.parse(rows.at(-1).bucket_utc);
    if (Number.isFinite(firstMs) && Number.isFinite(lastMs) && firstMs < lastMs - RETENTION_DAYS * DAY_MS) {
      errors.push(`history exceeds ${RETENTION_DAYS}-day retention window`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function updateHistoryRows(rows, snapshot) {
  const before = validateHistoryRows(rows, { nowMs: Math.max(Date.now(), Date.parse(snapshot?.generated_at ?? "")) });
  if (!before.ok) throw new Error(`existing history invalid: ${before.errors.join(" | ")}`);

  const row = buildHistoryRow(snapshot);
  const bucketMs = Date.parse(row.bucket_utc);
  const existing = rows.find(r => r.bucket_utc === row.bucket_utc);
  if (existing) return { rows, changed: false, reason: "bucket_exists", row: existing };

  if (rows.length) {
    const latestMs = Date.parse(rows.at(-1).bucket_utc);
    if (bucketMs < latestMs) throw new Error(`snapshot bucket ${row.bucket_utc} is older than latest history bucket ${rows.at(-1).bucket_utc}; backfill is disabled`);
  }

  const cutoffMs = bucketMs - RETENTION_DAYS * DAY_MS;
  const kept = rows.filter(r => Date.parse(r.bucket_utc) >= cutoffMs);
  const next = [...kept, row];
  const after = validateHistoryRows(next, { nowMs: Math.max(Date.now(), Date.parse(snapshot.generated_at)) });
  if (!after.ok) throw new Error(`updated history invalid: ${after.errors.join(" | ")}`);
  return { rows: next, changed: true, reason: "appended", row };
}

export function serializeHistory(rows) {
  return rows.length ? rows.map(row => JSON.stringify(row)).join("\n") + "\n" : "";
}
