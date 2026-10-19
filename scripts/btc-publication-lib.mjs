import { validateSnapshot, validateHistoricalSnapshot, historicalEtfReading, computeSourceHealth, buildHealthStatus, guardVenueUnits } from './btc-lib.mjs';

export function preserveVerifiedReadings(next, previous) {
  // Preserve ETF observations independently of age, derived freshness metadata,
  // and outages in unrelated sections. Retained values never set status to ok.
  if (next.etf && next.etf.status !== 'ok') {
    const saved = historicalEtfReading(previous, Date.parse(next.generated_at));
    if (saved) next.etf.last_verified = saved;
  }
  if (!previous || !validateHistoricalSnapshot(previous).ok || Date.parse(previous.generated_at) > Date.parse(next.generated_at)) return;
  for (const [name, current] of Object.entries(next.derivatives?.venues || {})) {
    const old = previous.derivatives?.venues?.[name];
    if (current.status === 'ok' || !old) continue;
    if (old.status === 'ok') {
      const value = structuredClone(old); delete value.last_verified;
      current.last_verified = {observed_at:old.observed_at || previous.generated_at, value};
    } else if (old.last_verified) {
      const saved = structuredClone(old.last_verified);
      const checked = {[name]: saved.value};
      if (Date.parse(saved.observed_at) <= Date.parse(next.generated_at) && saved.value?.status === 'ok' && guardVenueUnits(checked).length === 0) current.last_verified = saved;
    }
  }
  for (const name of ['spot', 'derivatives']) {
    const current = next[name];
    const old = previous[name];
    const healthKeys = name === 'derivatives' ? ['derivatives_oi', 'funding'] : [name];
    const usable = healthKeys.every(k => ['verified', 'partial'].includes(previous.health.sections[k]?.quality));
    const oldOk = name === 'derivatives' ? old?.aggregate?.status === 'ok' : old?.status === 'ok';
    const currentOk = name === 'derivatives' ? current?.aggregate?.status === 'ok' : current?.status === 'ok';
    if (!currentOk && usable && oldOk) {
      const value = structuredClone(old);
      delete value.last_verified;
      current.last_verified = { observed_at: old.observed_at || old.fetched_at || previous.generated_at, validated_at: previous.generated_at, value };
    } else if (!currentOk && old?.last_verified) {
      const saved = old.last_verified;
      const check = {schema:12, generated_at:saved.validated_at || saved.observed_at, sources:{}, etf:{status:'unavailable'}, spot:{status:'unavailable'}, derivatives:{venues:{},aggregate:{status:'unavailable',core_expected_venues:['okx','deribit','bitmex','hyperliquid','kraken']}},exchange_supply:{score:null}};
      check[name] = saved.value;
      check.health = computeSourceHealth(check);
      if (Date.parse(saved.observed_at) <= Date.parse(next.generated_at) && validateSnapshot(check).ok) current.last_verified = structuredClone(saved);
    }
  }
}

export function assessPublication(candidate, previousHealth, nowMs = Date.now()) {
  const result = validateSnapshot(candidate);
  const generated = Date.parse(candidate?.generated_at);
  if (generated > nowMs + 60000 || nowMs - generated > 60 * 60000) result.errors.push('candidate generated_at is future or older than 60 minutes');
  result.ok = result.errors.length === 0;
  const status = buildHealthStatus(candidate, previousHealth, new Date(nowMs).toISOString());
  status.snapshot_valid = result.ok;
  status.validation_errors = result.errors;
  status.last_successful_at = result.ok ? candidate.generated_at : previousHealth?.last_successful_at || null;
  const healthy = result.ok && ['verified', 'partial'].includes(computeSourceHealth(candidate).overall.quality);
  status.unhealthy_since = healthy ? null : previousHealth?.unhealthy_since || status.attempted_at;
  status.last_recovered_at = healthy && previousHealth?.unhealthy_since ? status.attempted_at : previousHealth?.last_recovered_at || null;
  return { publish: result.ok, status, result };
}
