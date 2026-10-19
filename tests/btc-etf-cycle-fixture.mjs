// Subprocess-only deterministic clock/network fixture. Never imported by production.
const RealDate = Date;
const fixed = RealDate.parse(process.env.BTC_TEST_NOW);
if (!Number.isFinite(fixed)) throw new Error('BTC_TEST_NOW required');
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
  static now() { return fixed; }
};
await import('./btc-pipeline-fixture.mjs');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (String(url).includes('sosovalue') && process.env.BTC_TEST_ETF_ROWS) {
    return Promise.resolve(Response.json({code: 0, data: JSON.parse(process.env.BTC_TEST_ETF_ROWS)}));
  }
  return originalFetch(url, options);
};
