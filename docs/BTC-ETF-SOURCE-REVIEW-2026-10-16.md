# ETF source investigation — original pre-push review

Follow-up: the user subsequently approved diagnostic-branch testing only. See [actual hosted-runner results](BTC-ETF-RUNNER-RESULTS-2026-10-16.md). The original review below records the state before that approval.

Date: 2026-10-16. Repository baseline: `a9b3b2dc2b34d5c8e874b9c4f10c1e471dcc644b`.

## Decision

Do not enable Farside in production yet. Direct credential-free Node requests received HTTP 403 challenges for both its current table and all-data table. Automated collection/republication permission is unconfirmed, and one overlapping date has a material discrepancy. No ETF provider, dashboard, scoring, or published data has been changed. SoSoValue remains intact.

No commit, push, deployment, remote issue mutation, or hosted-runner test was performed for this follow-up. The user explicitly required review before pushing. The prepared research branch workflow is the next reviewable step, not a restoration claim.

## Source comparison

| Source | Access and permission evidence | Data suitability | Decision |
| --- | --- | --- | --- |
| [Farside current table](https://farside.co.uk/btc/) and [all data](https://farside.co.uk/bitcoin-etf-flow-all-data/) | Research browser could read both. Plain Node fetch returned 403 with Cloudflare challenge. No credentials, browser impersonation, proxies or challenge bypass used. No explicit automated collection/republication license found in the reviewed pages. | Dated USD-million daily and fund totals. Twelve ticker columns. Current-day total can be zero while every fund is missing. One historical disagreement exceeds conservative rounding. | Not production-ready; hosted-runner access and permission remain unverified. |
| SoSoValue official API v2 | Existing production runner returned 403 despite configured secret during the deployed repair. | Existing USD-flow methodology and archived verified records. | Preserve implementation and secret handling for possible recovery/fallback. |
| [BGeometrics free API](https://bitcoin-data.com/bguser/free-features.html) | One keyless request returned 200. Documentation advertises free access; [terms](https://charts.bgeometrics.com/terms.html) also describe keys, redistribution and multiple-IP restrictions. Clarification needed for public JSON and rotating hosted runners. | `etf-flow-btc` returns BTC amounts, not the USD net creations/redemptions used by our scoring. Sample ended Oct 14 despite an Oct 15 end date. | Useful free candidate for research, not a drop-in source. Do not multiply by today's BTC price or substitute holdings changes. |
| [Bitbo API](https://bitbo.io/api/docs/) | Requires Pro++ and key. Its [usage page](https://charts.bitbo.io/btc-api/) restricts the API to private/internal purposes and excludes public-facing websites. | ETF metrics exist, but access/use does not meet this dashboard's constraints. | Reject for this free public dashboard. |
| [CoinGlass API](https://docs.coinglass.com/reference/etf-flows-history) | Documented ETF API is on subscription plans; [official guide](https://www.coinglass.com/id/learn/CoinGlass-API-Full-Guide-en) describes paid pricing. | Daily USD totals and fund breakdowns fit structurally. | No verified free keyless supported path; do not use undocumented endpoints. |
| [BTCETF.io](https://btcetf.io/) | Current domain is a sale landing page. | No live feed found. | Reject stale search-result references. |

BGeometrics free limits are 15/day and conservatively 8/hour according to its terms (some other documentation says 10/hour). A 30-minute collector would exceed the daily limit without separate provider throttling. Its public pages disagree about key requirements; a successful keyless request resolves access for that request only, not licensing or reliability.

## Farside permission and access

Reviewed the flow pages, [privacy policy](https://farside.co.uk/privacy-policy/), [team/contact page](https://farside.co.uk/team/), and [sign-up page](https://farside.co.uk/sign-up/). The privacy policy governs personal data; sign-up concerns professional investment clients. Neither supplies an ETF data automation license. The footer reserves rights. No explicit blanket scraping prohibition or grant was located in these pages; permission is **unresolved**, not established as forbidden or allowed.

The [robots file](https://farside.co.uk/robots.txt) returned HTTP 200 with only `User-agent: Twitterbot` and an empty `Disallow`. This is not a reuse license or permission for our collector. No contact message was sent. Before ongoing collection, ask Farside to confirm a supported free endpoint, permitted polling rate, attribution, public redistribution of daily observations, and treatment of pending/zero fund cells.

Local HTTP server-date evidence:

- 2026-10-16 19:00:55 UTC: `/btc/` 403, challenge page; `/robots.txt` 200.
- 2026-10-16 19:03:03 UTC: `/bitcoin-etf-flow-all-data/` 403, challenge page.
- 2026-10-16 19:03:03 UTC: BGeometrics documented ETF endpoint 200, ten observations Oct 1–14.

The local machine clock differs from external server time, as identified in the original repair. These timestamps come from HTTP Date headers. Production timing guards were not relaxed. Browser/research access is not proof that ordinary GitHub runner requests succeed.

## Dates, completeness and overlap

Farside labels its unit US$m; convert explicitly by 1,000,000. Parentheses mean negative. An explicit numeric `0.0` is distinct from `-` or a blank.

Observed tickers: IBIT, FBTC, BITB, ARKB, BTCO, EZBC, BRRR, HODL, BTCW, MSBT, GBTC, BTC. This verifies visible coverage, not independent issuer accuracy or equivalence to the old provider's fund universe. Our old snapshot stores only total flows, so fund-by-fund reconciliation cannot be performed from that record.

As observed, Oct 15 was the last fully numeric row. Oct 16 had twelve missing fund cells but a total of 0.0. That is an incomplete report, never a zero-flow session. Earlier all-data rows also contain pre-launch fund dashes and market-holiday placeholder rows. A parser cannot simply drop dashes, sum available cells, or take the last five HTML rows.

Compared all 25 archived observations, Sep 3–Oct 8, against the displayed all-data totals. Details: [overlap CSV](BTC-ETF-OVERLAP-2026-10-16.csv). Archived source: `git show ab5f1379^:data/btc-market.json`, generated Oct 14 at 19:48:20.073Z, with original ETF fetch Oct 9 at 13:03:18.238Z. The archived snapshot also passes the current snapshot validator at its recorded generation time. This is historical comparison evidence only; it is not current input.

| Session | Stored SoSoValue USD millions | Farside USD millions | Farside minus stored |
| --- | ---: | ---: | ---: |
| 2026-10-02 | 189.844086 | 189.9 | +0.055914 |
| 2026-10-05 | -89.897783 | -89.8 | +0.097783 |
| 2026-10-06 | 118.862452 | 118.8 | -0.062452 |
| 2026-10-07 | -487.067412 | -484.9 | **+2.167412** |
| 2026-10-08 | -244.125629 | -244.1 | +0.025629 |
| Five-session sum | -512.384286 | -510.1 | +2.284286 |

Twenty-four of 25 daily differences are below $0.65m, a conservative diagnostic allowance of twelve rounded fund cells plus a rounded total, each at $0.05m. This is not proof of identical methodology or a provider-specified tolerance. Oct 7 exceeds even that allowance. Revisions, coverage, and methodology have not been distinguished; do not silently overwrite the archived record or call the feeds fully reconciled.

The five fully numeric recent sessions Oct 9, 12, 13, 14, 15 sum to -$124.9m in the displayed table. This is an investigative calculation, not a validated production reading. It does not prove that numeric zeros are final reports.

## Expected ETF integration, only after the gates pass

1. Strict provider adapter: validate USD-million heading, ticker/date schema, row width, signed numbers, unique dates, active-fund coverage and total-vs-components rounding. Missing stays null; any unreported active fund blocks that session. Detect new/missing columns rather than silently changing the fund universe.
2. Select five consecutive valid U.S. exchange sessions. Check the official exchange calendar including holidays, special closures and early closes; a nine-calendar-day span alone does not prove no session was skipped. Historical pre-launch cells need explicit effective dates, not zero conversion.
3. Preserve report date separately from fetch time. Keep the existing New York calendar/reporting-lag labels and absolute stale guard; never rejuvenate cached data by changing its fetch time. The existing 20:00 ET reporting convention is not a verified Farside SLA. Require a confirmed finalization rule before treating pending reports as complete. Delayed reports must remain visibly delayed; stale reports cannot score.
4. Preserve the original five-session sum and piecewise score anchors: -$1bn=0, $0=50, +$0.5bn=75, +$1bn=90, +$2bn=100. Institutional demand continues to weigh ETF 65% and spot 35%. Do not mix provider rows to manufacture a five-session series.
5. Preserve SoSoValue as optional fallback using the same validation/freshness checks, with per-provider diagnostics and correct selected-source attribution. If both fail, keep ETF unavailable and publish healthy unrelated components through the existing guarded pipeline.
6. Update only ETF source attribution text if integration is later approved. Dashboard layout, spot/leverage formulas, historical returns and Time Machine remain untouched.

No Farside collector/parser has been connected because the access, permission and reconciliation gates have not passed. No sampled research values enter `data/`.

## Notification findings and prepared fix

The public repository issues API returned no issues at 19:00:55 UTC. There is no live outage/recovery issue lifecycle to verify yet. The deployed health file records `unhealthy_since: 2026-10-16T18:45:07.106Z`; if uninterrupted, the 24-hour threshold is Oct 17 at 18:45:07.106Z. The hourly :43 watchdog would normally catch it on a later run, not exactly at the threshold.

The old implementation only read the first 100 issues and required the exact title. An old or renamed issue could therefore be missed and duplicated. Recovery closed an issue before commenting, which could leave the recovery comment missing if the POST failed.

Local changes:

- `scripts/btc-alert-lib.mjs`: paginate all issues and comments; identify managed alerts by a valid outage marker even if renamed; suppress repeat issues for the same episode including manual closure; recognize an already-open managed outage; leave unrelated issues/PRs alone. On recovery, close managed open episodes dated no later than the recovered snapshot.
- Recovery comment precedes closure and has a stable episode marker. A failed closure retries without repeating the comment. Existing workflow concurrency continues to serialize watchdog runs. GitHub failures fail closed rather than create an unverified duplicate.
- `scripts/watch-btc-market.mjs`: use the tested reconciliation helper. Existing missed-run dispatch behavior is unchanged.
- `tests/btc-alert.test.mjs`: 13 tests covering threshold, repeats, pagination, renamed/manual-closed issues, new episodes, unrelated/future markers, recovery and retry behavior.
- `.github/workflows/btc-market-recovery.yml`: include those tests in existing safety checks.

Healthy still means a fresh, validated snapshot whose required scored components are verified or partial. Optional source failures do not prevent recovery; unresolved required ETF data does. This preserves the deployed policy.

Local verification: 100 collector + 21 history + 9 recovery + 25 pipeline + 20 daily-history/Time-Machine + 13 alert tests = **188 passed**. JavaScript syntax checks and `git diff --check` passed. A separate YAML parser check was unavailable because PyYAML is not installed; the hosted workflow is not yet executed. Real GitHub issue creation/closure has not been exercised by these mocks. A lost GitHub API response is reconciled from persisted markers on the next run; deleting the issue or marker removes that record.

To stop per-run emails: open [GitHub notification settings](https://github.com/settings/notifications), find **System → Actions**, deselect **Email** (keep **On GitHub** if desired), or choose **Don't notify**, and save. **Only notify for failed workflows** still sends failure emails. Issue subscriptions are separate: retain issue notifications or repository Watch → Custom → Issues for outage alerts. These are account settings; repository YAML cannot change them. [Official Actions notification documentation](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).

## Proposed next step and unresolved gates

Prepared `scripts/probe-btc-etf-sources.mjs` and `.github/workflows/btc-etf-source-probe.yml`. On approval, push the reviewable changes to **codex/etf-source-review**, not main. Its branch-push trigger runs a read-only Ubuntu/Node 24 diagnostic, executes alert mocks, and uploads access metadata. It has no schedule, provider secrets, issue writes, repository writes or publisher invocation. The existing collector push trigger is main-only; Pages is configured for main.

The probe uses ordinary unauthenticated requests, bounded timeouts and no challenge retries. Its successful job status means the diagnostic completed, not that a provider is usable: inspect each response status, challenge flag and table metadata. Re-run across separate runners and reporting windows before calling access reliable; one HTTP 200 cannot establish this. It is deliberately not a production parser.

After runner results, report the exact run URL and unresolved permission/data discrepancies before requesting production deployment approval. Activation remains blocked until a legitimate source meets all gates. Then run the full collector on the actual runner, verify the committed JSON and GitHub Pages publication/content, and verify that the visible ETF date/score/source match the approved input. No restoration claim before those checks pass.
