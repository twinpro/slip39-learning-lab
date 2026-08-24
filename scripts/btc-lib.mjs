/**
 * Pure safety helpers for the BTC Real vs Paper collector.
 * No network access, file writes, or implicit clock reads.
 */

export const CORE_VENUES = ["okx", "deribit", "bitmex", "hyperliquid", "kraken"];
export const MAX_ETF_5_SESSION_SPAN_DAYS = 9;
export const IMPLIED_BTC_MIN = 0.5;
export const IMPLIED_BTC_MAX = 5_000_000;
export const VENUE_OI_MAX_USD = 1_000_000_000_000;
export const FUNDING_SANITY_PERCENT_8H = 5;
export const HEALTH_SCHEMA = 1;
export const USDT_QUOTE_CONFLICT_PERCENT = 0.2;
export const BTC_SPOT_CONFLICT_PERCENT = 0.5;
export const SNAPSHOT_WARN_MINUTES = 60;
export const SNAPSHOT_MAX_MINUTES = 180;

export const num = x => {
  if (x === null || x === undefined || typeof x === "boolean") return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

export function fiveSessionSpanDays(rowsAscending) {
  const last5 = (rowsAscending || []).slice(-5);
  if (last5.length < 5) return null;
  return (last5.at(-1).timestamp - last5[0].timestamp) / 86_400_000;
}

function approxEqual(a, b, relTol = 1e-9, absTol = 1e-6) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));
}

function relativeSpreadPercent(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / ((a + b) / 2) * 100;
}

function healthSection(quality, coverage, reason, extra = {}) {
  return { quality, coverage, reason, ...extra };
}

/**
 * Classify data integrity independently from snapshot age.
 *
 * VERIFIED means the configured automated checks passed. It does not claim
 * independent two-source confirmation; verification_depth makes that explicit.
 * Fresh/delayed/stale is calculated by the browser from generated_at using the
 * trusted HTTP clock, so a fresh but incomplete snapshot remains PARTIAL.
 */
export function computeSourceHealth(d) {
  const etf = d?.etf ?? {};
  const etfRows = Array.isArray(etf.last_5_trading_sessions) ? etf.last_5_trading_sessions : [];
  const etfUsable = etf.status === "ok" && num(etf.flow_5d_usd) != null &&
    etfRows.length === 5 && etfRows.every(r => num(r?.flow_usd) != null);
  const etfHealth = etfUsable
    ? healthSection("verified", "5/5 sessions · 1 source", "Automated date, schema, magnitude, and five-session checks passed.", { verification_depth: 1 })
    : healthSection("unknown", "0 usable ETF series", "The configured ETF feed did not produce a validated five-session series.", { verification_depth: 0 });

  const spot = d?.spot ?? {};
  const btcPrices = [num(spot.coinbase_usd), num(spot.kraken_usd), num(spot.okx_usdt)];
  const btcLegsValid = btcPrices.every(v => v > 0);
  const pegQuotes = [num(spot.coinbase_usdt_usd), num(spot.kraken_usdt_usd)]
    .filter(v => v != null && v > 0.97 && v < 1.03);
  const btcUsdSpread = btcLegsValid ? relativeSpreadPercent(btcPrices[0], btcPrices[1]) : null;
  const pegSpread = pegQuotes.length === 2 ? relativeSpreadPercent(pegQuotes[0], pegQuotes[1]) : null;
  let spotHealth;
  if (spot.status !== "ok" || !btcLegsValid || !(num(spot.usdt_usd) > 0.97 && num(spot.usdt_usd) < 1.03) || spot.premium_status !== "usdt_normalized") {
    spotHealth = healthSection("unknown", `${btcPrices.filter(v => v > 0).length}/3 BTC legs · ${pegQuotes.length}/2 peg quotes`, "The normalized U.S. spot proxy cannot be calculated from all required BTC price legs.");
  } else if (btcUsdSpread > BTC_SPOT_CONFLICT_PERCENT) {
    spotHealth = healthSection("conflict", `3/3 BTC legs · ${pegQuotes.length}/2 peg quotes`, `Coinbase and Kraken BTC/USD differ by ${btcUsdSpread.toFixed(3)}%, above the ${BTC_SPOT_CONFLICT_PERCENT.toFixed(1)}% conflict limit.`);
  } else if (pegSpread > USDT_QUOTE_CONFLICT_PERCENT) {
    spotHealth = healthSection("conflict", "3/3 BTC legs · 2/2 peg quotes", `Coinbase and Kraken USDT/USD differ by ${pegSpread.toFixed(3)}%, above the ${USDT_QUOTE_CONFLICT_PERCENT.toFixed(1)}% conflict limit.`);
  } else if (pegQuotes.length === 1) {
    spotHealth = healthSection("partial", "3/3 BTC legs · 1/2 peg quotes", "The proxy is normalized with one valid USDT/USD quote; scoring may continue with an amber warning.");
  } else {
    spotHealth = healthSection("verified", "3/3 BTC legs · 2/2 peg quotes", "All BTC price legs and both USDT/USD normalization quotes passed checks.");
  }

  const venues = d?.derivatives?.venues ?? {};
  const workingCore = CORE_VENUES.filter(name => venues[name]?.status === "ok" && num(venues[name]?.oi_usd) > 0);
  const rejectedCore = CORE_VENUES.filter(name => venues[name]?.status === "rejected" || String(d?.sources?.unit_guard_rejected || "").split(/\s*,\s*/).includes(name));
  let oiHealth;
  if (rejectedCore.length) {
    oiHealth = healthSection("conflict", `${workingCore.length}/5 core venues`, `Unit guard rejected: ${rejectedCore.join(", ")}. Derivatives scoring is disabled.`);
  } else if (workingCore.length === CORE_VENUES.length) {
    oiHealth = healthSection("verified", "5/5 core venues", "The fixed five-venue OI core is complete and comparable.");
  } else if (workingCore.length >= 2) {
    oiHealth = healthSection("partial", `${workingCore.length}/5 core venues`, `Missing ${CORE_VENUES.filter(v => !workingCore.includes(v)).join(", ")}; current partial OI may display, but history comparison is disabled.`);
  } else {
    oiHealth = healthSection("unknown", `${workingCore.length}/5 core venues`, "Fewer than two valid core venues are available.");
  }

  const badFunding = workingCore.filter(name => {
    const f = num(venues[name]?.funding_rate_percent);
    return f != null && Math.abs(f) > FUNDING_SANITY_PERCENT_8H;
  });
  const fundingVenues = workingCore.filter(name => {
    const f = num(venues[name]?.funding_rate_percent);
    return f != null && Math.abs(f) <= FUNDING_SANITY_PERCENT_8H;
  });
  let fundingHealth;
  if (rejectedCore.length || badFunding.length) {
    const names = [...new Set([...rejectedCore, ...badFunding])];
    fundingHealth = healthSection("conflict", `${fundingVenues.length}/5 comparable venues`, `Funding or unit validation failed for: ${names.join(", ")}.`);
  } else if (fundingVenues.length === CORE_VENUES.length) {
    fundingHealth = healthSection("verified", "5/5 comparable venues", "All fixed-core funding rates are normalized to an 8-hour basis.");
  } else if (fundingVenues.length >= 2) {
    fundingHealth = healthSection("partial", `${fundingVenues.length}/5 comparable venues`, "Live leverage health may display, but fixed-core funding history is not comparable.");
  } else {
    fundingHealth = healthSection("unknown", `${fundingVenues.length}/5 comparable venues`, "Fewer than two comparable funding venues are available.");
  }

  const bybit = venues.bybit ?? {};
  const bybitHealth = bybit.status === "ok" && num(bybit.oi_usd) > 0
    ? healthSection("verified", "optional", "Bybit is available but excluded from the fixed core.", { optional: true })
    : healthSection("unknown", "optional", "Bybit is unavailable and has no effect on dashboard health.", { optional: true });

  const sections = {
    etf: etfHealth,
    spot: spotHealth,
    derivatives_oi: oiHealth,
    funding: fundingHealth,
    exchange_supply: healthSection("unknown", "not scored", "No verified free automated all-exchange BTC balance source is configured.", { excluded_from_overall: true }),
    bybit: bybitHealth
  };
  const required = [etfHealth, spotHealth, oiHealth, fundingHealth];
  const priority = { verified: 0, partial: 1, unknown: 2, conflict: 3 };
  const overallQuality = required.reduce((worst, section) =>
    priority[section.quality] > priority[worst] ? section.quality : worst, "verified");

  return {
    schema: HEALTH_SCHEMA,
    assessed_at: d?.generated_at ?? null,
    overall: {
      quality: overallQuality,
      reason: overallQuality === "verified"
        ? "All required scored components passed their configured checks."
        : "At least one required scored component is not fully verified."
    },
    sections
  };
}

export function classifyFreshness(ageMinutes) {
  if (!Number.isFinite(ageMinutes) || ageMinutes > SNAPSHOT_MAX_MINUTES) return "stale";
  if (ageMinutes > SNAPSHOT_WARN_MINUTES) return "delayed";
  return "fresh";
}

export function buildHealthStatus(snapshot, previous = null, nowIso = new Date().toISOString()) {
  const validation = validateSnapshot(snapshot);
  const computed = computeSourceHealth(snapshot);
  if (!validation.ok && !Object.values(computed.sections).some(section => section.quality === "conflict")) {
    computed.overall = {
      quality: "conflict",
      reason: "The latest collection attempt failed publication validation."
    };
    computed.sections.publication = {
      quality: "conflict",
      coverage: "rejected attempt",
      reason: validation.errors[0] || "Snapshot validation failed."
    };
  }
  const attemptedAt = Number.isFinite(Date.parse(snapshot?.generated_at)) ? snapshot.generated_at : nowIso;
  return {
    schema: HEALTH_SCHEMA,
    attempted_at: attemptedAt,
    snapshot_valid: validation.ok,
    last_successful_at: validation.ok ? snapshot.generated_at : previous?.last_successful_at ?? null,
    health: validation.ok ? snapshot.health : computed,
    validation_errors: validation.errors
  };
}

/**
 * Defense-in-depth unit checks for venue open interest.
 *
 * These checks do not redefine venue contract math. They verify invariants that the
 * collector already claims to have applied. Any rejected venue is excluded from the
 * aggregate by the caller, and the post-collection validator refuses publication.
 */
export function guardVenueUnits(venues) {
  const rejected = [];
  if (!venues || typeof venues !== "object") return rejected;

  for (const [name, v] of Object.entries(venues)) {
    if (!v || v.status !== "ok") continue;

    const oi = num(v.oi_usd);
    const mark = num(v.mark_price);
    if (!(oi > 0)) {
      v.status = "rejected";
      v.unit_check = "rejected";
      v.rejected_reason = "oi_usd is missing, zero, or non-finite";
      rejected.push(name);
      continue;
    }

    if (oi > VENUE_OI_MAX_USD) {
      v.status = "rejected";
      v.unit_check = "rejected";
      v.rejected_reason = `oi_usd ${oi.toExponential(3)} exceeds the ${VENUE_OI_MAX_USD.toExponential(3)} USD safety ceiling`;
      rejected.push(name);
      continue;
    }

    if (mark > 0) {
      const implied = oi / mark;
      v.implied_btc = +implied.toFixed(4);
      if (implied < IMPLIED_BTC_MIN || implied > IMPLIED_BTC_MAX) {
        v.status = "rejected";
        v.unit_check = "rejected";
        v.rejected_reason = `oi_usd / mark_price implies ${implied.toExponential(3)} BTC, outside ${IMPLIED_BTC_MIN} .. ${IMPLIED_BTC_MAX}`;
        rejected.push(name);
        continue;
      }
    } else {
      v.implied_btc = null;
    }

    // Contract-specific invariants catch the exact classes of unit mistakes that have
    // already occurred in this project.
    if (name === "kraken") {
      const raw = num(v.open_interest_raw);
      if (raw == null || !approxEqual(oi, raw)) {
        v.status = "rejected";
        v.unit_check = "rejected";
        v.rejected_reason = "Kraken PI_XBTUSD oi_usd must equal raw openInterest because 1 contract = 1 USD";
        rejected.push(name);
        continue;
      }
    }

    if (name === "hyperliquid") {
      const btc = num(v.oi_btc);
      if (btc != null && mark > 0 && !approxEqual(oi, btc * mark, 1e-9, 0.05)) {
        v.status = "rejected";
        v.unit_check = "rejected";
        v.rejected_reason = "Hyperliquid oi_usd must equal openInterest(BTC) × mark price";
        rejected.push(name);
        continue;
      }
    }

    v.unit_check = "ok";
  }

  return rejected;
}

export function validateSnapshot(d) {
  const errors = [];
  const warnings = [];
  const fail = m => errors.push(m);
  const warn = m => warnings.push(m);

  if (!d || typeof d !== "object") return { ok: false, errors: ["snapshot is not an object"], warnings };
  if (d.schema !== 12) fail(`schema must be 12, got ${d.schema}`);
  if (!Number.isFinite(Date.parse(d.generated_at))) fail("generated_at is missing or invalid");

  const unitRejected = String(d.sources?.unit_guard_rejected || "").trim();
  if (unitRejected) fail(`unit guard rejected venue(s): ${unitRejected}`);

  const etf = d.etf || {};
  if (etf.status === "ok") {
    const rows = Array.isArray(etf.last_5_trading_sessions) ? etf.last_5_trading_sessions : [];
    if (rows.length !== 5) fail(`ETF status ok but last_5_trading_sessions has ${rows.length} rows`);
    const flows = rows.map(r => num(r?.flow_usd));
    if (flows.some(v => v == null)) fail("ETF five-session rows contain a non-numeric flow");
    if (flows.every(v => v != null)) {
      const sum = flows.reduce((a, b) => a + b, 0);
      if (!approxEqual(sum, num(etf.flow_5d_usd), 1e-10, 0.01)) fail("ETF flow_5d_usd does not equal the five session rows");
    }
    const age = num(etf.latest_age_days);
    if (age == null || age < -1 || age > 4) fail(`ETF latest_age_days out of guard range: ${etf.latest_age_days}`);
  } else {
    warn("ETF source unavailable in this snapshot");
  }

  const venues = d.derivatives?.venues || {};
  for (const [name, v] of Object.entries(venues)) {
    if (v?.status !== "ok") continue;
    if (!(num(v.oi_usd) > 0)) fail(`${name}: status ok but oi_usd is not positive`);
    const f = num(v.funding_rate_percent);
    if (f != null && Math.abs(f) > FUNDING_SANITY_PERCENT_8H) fail(`${name}: funding ${f}% exceeds ±${FUNDING_SANITY_PERCENT_8H}% 8h sanity bound`);
  }

  const kraken = venues.kraken;
  if (kraken?.status === "ok") {
    const oi = num(kraken.oi_usd), raw = num(kraken.open_interest_raw);
    if (oi == null || raw == null || !approxEqual(oi, raw)) fail("Kraken invariant failed: oi_usd must equal open_interest_raw");
  }

  const hl = venues.hyperliquid;
  if (hl?.status === "ok") {
    const oi = num(hl.oi_usd), btc = num(hl.oi_btc), mark = num(hl.mark_price);
    if (oi != null && btc != null && mark > 0 && !approxEqual(oi, btc * mark, 1e-9, 0.05)) {
      fail("Hyperliquid invariant failed: oi_usd must equal oi_btc × mark_price");
    }
  }

  const ag = d.derivatives?.aggregate || {};
  const expected = ag.core_expected_venues || [];
  if (JSON.stringify(expected) !== JSON.stringify(CORE_VENUES)) fail(`core_expected_venues must be ${CORE_VENUES.join(", ")}`);

  if (ag.core_comparable_status === "ok") {
    const working = ag.core_working_venues || [];
    const missing = ag.core_missing_venues || [];
    if (JSON.stringify(working) !== JSON.stringify(CORE_VENUES)) fail("core marked complete but working venue set differs from fixed core");
    if (missing.length) fail("core marked complete but core_missing_venues is not empty");
    const sum = CORE_VENUES.reduce((a, name) => a + (num(venues?.[name]?.oi_usd) || 0), 0);
    if (!approxEqual(sum, num(ag.core_comparable_oi_usd), 1e-10, 0.01)) fail("core_comparable_oi_usd does not equal the five core venues");
  }

  const spot = d.spot || {};
  if (spot.status === "ok") {
    const peg = num(spot.usdt_usd);
    if (!(peg > 0.97 && peg < 1.03)) fail(`spot status ok but usdt_usd ${spot.usdt_usd} is outside 0.97..1.03`);
    if (spot.premium_status !== "usdt_normalized") fail("spot status ok but premium_status is not usdt_normalized");
    const usdAvg = num(spot.us_spot_average_usd);
    const okxUsd = num(spot.okx_usd_equivalent);
    const prem = num(spot.us_spot_premium_percent);
    if (usdAvg > 0 && okxUsd > 0 && prem != null) {
      const expectedPrem = (usdAvg / okxUsd - 1) * 100;
      if (!approxEqual(expectedPrem, prem, 0, 0.00011)) fail("normalized U.S. spot premium does not match its source fields");
    }
  } else {
    warn("spot proxy unavailable in this snapshot");
  }

  const xs = d.exchange_supply || {};
  if (xs.score !== null && xs.score !== undefined) fail("exchange_supply score must remain null");

  const expectedHealth = computeSourceHealth(d);
  const health = d.health || {};
  if (health.schema !== HEALTH_SCHEMA) {
    fail(`health schema must be ${HEALTH_SCHEMA}, got ${health.schema}`);
  } else {
    if (health.assessed_at !== d.generated_at) fail("health.assessed_at must equal generated_at");
    if (health.overall?.quality !== expectedHealth.overall.quality) {
      fail(`health overall quality must be ${expectedHealth.overall.quality}, got ${health.overall?.quality}`);
    }
    for (const name of Object.keys(expectedHealth.sections)) {
      const actual = health.sections?.[name];
      const expected = expectedHealth.sections[name];
      if (actual?.quality !== expected.quality) fail(`health ${name} quality must be ${expected.quality}, got ${actual?.quality}`);
      if (actual?.coverage !== expected.coverage) fail(`health ${name} coverage must be ${expected.coverage}, got ${actual?.coverage}`);
    }
  }

  const dead = etf.status !== "ok" && ag.status !== "ok" && spot.status !== "ok";
  if (dead) fail("ETF, derivatives aggregate, and spot are all unavailable; refuse dead snapshot");

  return { ok: errors.length === 0, errors, warnings };
}
