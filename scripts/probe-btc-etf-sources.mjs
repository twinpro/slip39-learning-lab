// Manual research only. Never imported by the collector or publisher.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectFarsideHtml } from './btc-etf-diagnostic-lib.mjs';
const targets = [
  'https://farside.co.uk/robots.txt',
  'https://farside.co.uk/btc/',
  'https://farside.co.uk/bitcoin-etf-flow-all-data/',
  'https://bitcoin-data.com/v1/etf-flow-btc?startday=2026-10-01&endday=2026-10-15'
];
const results = [];
for (const url of targets) {
  const started = Date.now();
  try {
    // No credentials, proxy, browser impersonation, challenge bypass or retry.
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
    const body = await response.text();
    const result = {
      url, status: response.status, status_text: response.statusText, server_date: response.headers.get('date'),
      content_type: response.headers.get('content-type'),
      cf_mitigated: response.headers.get('cf-mitigated'), server: response.headers.get('server'),
      location: response.headers.get('location'),
      challenge: response.headers.get('cf-mitigated') === 'challenge' || /Just a moment|challenge-platform/i.test(body),
      bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'),
      duration_ms: Date.now() - started
    };
    if (url.endsWith('/robots.txt')) result.robots = body.slice(0,4000);
    if (url.includes('farside') && !url.endsWith('/robots.txt')) {
      result.has_table = /<table\b/i.test(body);
      result.has_usd_million_heading = /US\$m/.test(body);
      result.completeness = response.ok && !result.challenge ? inspectFarsideHtml(body) : {status:'not_assessable_access_denied'};
    }
    if (url.includes('bitcoin-data') && response.ok) {
      const rows = JSON.parse(body);
      result.row_count = Array.isArray(rows) ? rows.length : null;
      result.first_row = Array.isArray(rows) ? rows[0] : null;
      result.last_row = Array.isArray(rows) ? rows.at(-1) : null;
    }
    results.push(result);
  } catch (error) {
    results.push({url,error:error.message,duration_ms:Date.now()-started});
  }
}
const report = {
  recorded_at: new Date().toISOString(), runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
  run_id: process.env.GITHUB_RUN_ID || null, commit: process.env.GITHUB_SHA || null,
  note: 'Access observations only. Not permission, production integration, data validation or a reliability guarantee.', results
};
const output = process.argv[2];
if (output) await fs.writeFile(output, JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
