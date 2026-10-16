// Only run in a disposable Actions checkout. Never force-push or merge JSON text.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
if (process.env.GITHUB_ACTIONS !== 'true' || path.resolve(process.env.GITHUB_WORKSPACE || '') !== process.cwd()) throw new Error('Requires disposable GitHub Actions workspace');
const files = ['data/btc-market.json', 'data/btc-market-history.jsonl', 'data/btc-market-health.json'];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = script => { if (spawnSync(process.execPath, [script], { stdio: 'inherit' }).status !== 0) throw new Error(script + ' failed'); };
function commit() {
  const changed = git('diff', '--name-only').split('\n').filter(Boolean);
  if (changed.some(f => !files.includes(f))) throw new Error('Unexpected working-tree edits');
  git('add', '--', ...files);
  if (git('diff', '--cached', '--name-only').split('\n').filter(Boolean).some(f => !files.includes(f))) throw new Error('Unexpected staged file');
  if (!git('diff', '--cached', '--name-only')) return false;
  git('commit', '-m', 'Update verified BTC market data');
  return true;
}
git('config', 'user.name', 'btc-data-bot');
git('config', 'user.email', 'actions@users.noreply.github.com');
if (commit()) {
  let pushed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (spawnSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'inherit' }).status === 0) { pushed = true; break; }
    git('fetch', 'origin', 'main');
    // A remote advance is required before discarding this attempt's data commit.
    if (git('rev-parse', 'origin/main') === git('rev-parse', 'HEAD^')) throw new Error('Push failed without remote advance; check contents permission/branch protection');
    if (attempt === 2) break;
    // Recollect against current main: preserve remote observations/history and source changes.
    git('reset', '--hard', 'origin/main');
    run('scripts/publish-btc-market.mjs');
    if (!commit()) { pushed = true; break; }
  }
  if (!pushed) throw new Error('Push failed after three bounded attempts');
}
git('fetch', 'origin', 'main');
for (const file of files) {
  if (git('hash-object', file) !== git('rev-parse', 'origin/main:' + file)) throw new Error('Published file differs from origin/main: ' + file);
}
console.log('Remote publication verified for snapshot, history and health');
