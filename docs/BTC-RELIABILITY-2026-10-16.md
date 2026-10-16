# BTC pipeline reliability investigation - 2026-10-16

## Starting state and evidence

Repository: twinpro/slip39-learning-lab; branch main. Initial local SHA:
`ad2442490937481ad0d0528a84ea2324bedeab10`. Fetched and fast-forwarded 842
remote data commits to `de13ee10dca19f3a5fd4b71c57206df9fe750d62` before edits.
Existing untracked `screenshots/` was preserved and excluded from commits.

Backup tags:
- `backup/btc-reliability-2026-10-16-ad24424` (original local revision)
- `backup/btc-reliability-2026-10-16-remote-de13ee10` (production before repair)

Confirmed failed run: https://github.com/twinpro/slip39-learning-lab/actions/runs/38946208877
Job 117125843566: setup, all 130 safety checks, collection, and timestamp advancement
passed. First failure: **Assert ETF health**, at 18:17:44 UTC, eight seconds after
run creation. Exact log: `ETF HEALTH FAIL: ETF status is unavailable: 403 Forbidden`.
The collector log reports `sosovalue: error: 403 Forbidden`. Every following
health/history/commit/publication step was skipped. Run 38946287060 has the same
first failing step. No evidence of a pre-collection test failure or push permission
failure in these runs: they never reached push.

## Confirmed defects and repairs

| Root cause | Evidence / affected files | Repair |
| --- | --- | --- |
| ETF outage vetoes healthy sources | Above hosted log; btc-market-data.yml, assert-etf-health.mjs | Main and recovery use one guarded publisher. ETF unavailability disables its score, not unrelated collection. Full schema validation remains mandatory. |
| Optional credential differs between main and recovery | Secret name SOSOVALUE_API_KEY exists; only old recovery passed it | Both paths pass the existing optional secret. No key is printed or made public. A 403 alone does not prove an invalid key; exact provider-side reason remains unknown. |
| Invalid snapshots could publish | Both YAML files used continue-on-error for verify-snapshot and explicitly committed failed candidates | Collector writes a temporary candidate; publisher validates snapshot and history before touching publishable files. Total outages publish health only. |
| Multiple independent market writers | Different concurrency groups and recovery triggered after three unrelated workflows | One shared reusable writer with main checkout after lock acquisition; remove unrelated workflow_run triggers. |
| Duplicate retries | GitHub API shows twinpro workflow_dispatch approximately every 15 minutes plus scheduled and github-actions watchdog runs | 25-minute attempt gate suppresses duplicate collection; watchdog checks active/recent runs and only dispatches for stale snapshots. No matching local Codex automation was found; origin of twinpro dispatches remains unverified. |
| JSON push conflicts | Old git pull --rebase could conflict on generated snapshot/history | Bounded ordinary pushes. On remote advance, discard only the disposable Actions attempt, recollect against latest main, preserve remote history and other files. Never force-push. |
| Incomplete HTTP deadline | Timer cleared when headers arrived; JSON body read afterward | Body-inclusive 12-second deadline; at most two attempts for network/429/5xx, bounded backoff; no 403 retry. |
| Source timestamps ignored | Original non-ETF parsers did not check provider observation time | Validate available provider timestamps, funding age and future values. APIs without observation timestamps explicitly use response-received time. |
| Failed refresh erased verified readings | Only still-fresh ETF had a fallback | Retain last verified sections/venues with original timestamps. They are explicitly STALE and excluded from current scoring. Already-lost historical ETF observations remain in Git history and historical data. |
| Fresh attempt could imply fresh old data | Candidate and public snapshot were conflated; old ETF text said live/fresh | Snapshot age gates scores; rejected attempt cannot override published source classifications. Preserved readings show their original time, never LIVE. |

## Signals before repair

Public snapshot: `2026-10-16T09:52:27.364Z`. At the initial HTTP observation around
18:29 UTC it was about 517 minutes old, exceeding the existing 180-minute limit.
- ETF: SoSoValue HTTP 403, unavailable and unscored. Last retained successful
  fetch found in Git (`ab5f1379^`) was `2026-10-09T13:03:18.238Z`, report date
  `2026-10-08`, five-session flow -512384285.595 USD. It was last preserved in
  the Oct 14 19:48 snapshot, then expired. It must not be promoted to current data.
- Spot: Coinbase BTC/USD and USDT/USD, Kraken BTC/USD and USDT/USD, OKX BTC/USDT
  passed schema/normalization checks in the 09:52 snapshot. Disabled only by age.
- Leverage: OKX, Deribit, Hyperliquid, Kraken OI and funding available in that
  snapshot; BitMEX HTTP 403 left 4/5 coverage. Partial live leverage is permitted
  by existing rules; fixed-five-venue history remains non-comparable. Disabled by age.
- Exchange supply: no verified approved free all-exchange balance feed configured;
  deliberately UNKNOWN/null and excluded from scoring. No replacement invented.
- Optional Bybit: HTTP 403, excluded from core methodology.

The 65% ETF / 35% normalized U.S. spot formula and all score anchors are unchanged.
Overall demand remains unavailable whenever either required input is unavailable.
Leverage remains a separate signal. Holiday/weekend ETF reporting allowances and
existing 120-day history retention remain in effect.

## Schedule and notifications

Main cron before and after: `7,37 * * * *` (every 30 minutes). The old page incorrectly
said four times per hour. Watchdog remains hourly at minute 43. Completion-triggered
recovery is removed; explicit recovery uses the same writer and cadence gate.

Native GitHub issues provide one actionable alert after 24 hours of continuously
unhealthy required-source status, with one recovery closure/comment. Repeated runs
leave the issue untouched. The first persisted unhealthy attempt starts the clock;
no unsupported outage start time is invented. There is no paid service or additional
alert infrastructure. A prolonged provider outage is an operational degradation,
not a reason to fail a successfully validated partial collection. Code/test failures
still fail Actions and retain detailed logs.

Owner action: GitHub Settings > Notifications > System > Actions. Disable Actions
email to avoid per-run emails ("failed workflows only" still sends each failure).
Keep web notifications if desired; watch/subscribe to the outage issue to receive
its actionable alert and recovery. Repository code cannot override personal email
preferences. See https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
Disable the external 15-minute dispatcher at its origin if it is no longer needed;
its location was not identified during this investigation.

## Verification

- Collector safety: 100/100.
- History safety: 21/21.
- Recovery safety: 9/9.
- Pipeline faults/integration/actual renderer: 25/25.
- Daily history + Time Machine: 20/20.
- Macro render and macro chart interaction: both pass.
- Existing snapshot and 727 history rows validate.
- Mobile 390x844 and desktop 1440x1000 render without horizontal overflow; no layout
  or feature removal. Actual renderer tested with good, degraded, delayed, stale,
  future, rejected-sidecar and preserved-reading inputs.

Fault coverage includes healthy sources; ETF, spot and derivatives loss; HTTP 403,
429 and 500; malformed/empty responses; stale/future observations; missing/corrupt
snapshots; total outage; recovery; source-unit rejection; bounded body timeout;
weekend/holiday ETF handling; shared writer lock contract; and a real local bare-Git
non-fast-forward conflict followed by successful recollection and ordinary push.
Production simultaneous-run behavior and 24-hour elapsed alert delivery require
operational observation; tests do not claim those periods have elapsed.

Local live probes exposed a four-hour host-versus-provider HTTP clock discrepancy.
Timestamp checks correctly rejected the old provider readings in that environment;
no clock offset was hardcoded or validation widened to make a local probe pass.

## Changed files

- `.github/workflows/btc-market-data.yml`, `btc-market-recovery.yml`, `btc-market-watchdog.yml`
- `assets/js/btc-dashboard-time.mjs`
- `pages/btc-real-vs-paper-v11b.html`
- `scripts/btc-alert-lib.mjs`, `btc-http.mjs`, `btc-publication-lib.mjs`
- `scripts/btc-etf-lib.mjs`, `btc-lib.mjs`, `btc-market-recovery-lib.mjs`
- `scripts/check-btc-collection-due.mjs`, `check-btc-market-recovery.mjs`
- `scripts/commit-btc-market.mjs`, `publish-btc-market.mjs`, `watch-btc-market.mjs`
- `scripts/update-btc-market.mjs`, `test-collector.mjs`
- `tests/btc-pipeline-fixture.mjs`, `btc-pipeline.test.mjs`
- `docs/BTC-RELIABILITY-2026-10-16.md`

## Rollback

Prefer reverting the repair commit(s) to preserve newer bot data and history:
`git revert <repair-commit-sha>` followed by `git push origin main` after checks.
For an isolated inspection of the exact old site:
`git switch --detach backup/btc-reliability-2026-10-16-remote-de13ee10`.
Do not reset/force-push main to the backup: doing so would discard subsequent data.

## Deployment result

Pending hosted execution and published-site verification. Do not treat local tests
as proof of deployment. This section will be updated with actual run and data evidence.
