// The deadline covers headers AND body. Retry transient failures at most once.
export async function getJson(url, opts = {}, { fetchImpl = fetch, timeoutMs = 12000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retry = false, delay = 500;
    try {
      const r = await fetchImpl(url, { ...opts, signal: controller.signal,
        headers: { 'User-Agent': 'btc-real-vs-paper/12', Accept: 'application/json', ...opts.headers } });
      if (!r.ok) {
        retry = r.status === 429 || r.status >= 500;
        delay = Math.min(2000, Math.max(500, (Number(r.headers.get('retry-after')) || 0) * 1000));
        await r.body?.cancel();
        throw new Error(`HTTP ${r.status} ${r.statusText}`);
      }
      return await r.json();
    } catch (error) {
      retry ||= error.name === 'AbortError' || error instanceof TypeError;
      if (!retry || attempt === 1) throw error;
    } finally { clearTimeout(timer); }
    await sleep(delay);
  }
}

export function observationTime(value, fetchedAt, maxAgeMinutes = 60) {
  const ts = typeof value === 'number' || /^\d{13}$/.test(String(value)) ? Number(value) : Date.parse(value);
  const now = Date.parse(fetchedAt);
  if (!Number.isFinite(ts) || ts > now + 60000 || now - ts > maxAgeMinutes * 60000) {
    throw new Error(`invalid, future or stale source timestamp: ${value}`);
  }
  return new Date(ts).toISOString();
}
