# ETF hosted-runner diagnostic — 2026-10-16

## Outcome

**Farside is not viable for the current credential-free GitHub Actions pipeline.** Both flow pages returned HTTP 403 challenges on the actual runner. Completeness could not be assessed from those responses. No access restriction was bypassed, and no retry, scheduled collection, production integration, or live issue test was started.

- Branch: `codex/etf-source-review` only.
- Tested commit: `0fe28b3f93066d79017e4e640efec38fd9b077ee`.
- [Diagnostic run 38953271744](https://github.com/twinpro/slip39-learning-lab/actions/runs/38953271744).
- [Job 117149705658](https://github.com/twinpro/slip39-learning-lab/actions/runs/38953271744/job/117149705658).
- Runner: GitHub-hosted Ubuntu 24.04, runner image `ubuntu24/20261012.334`, Node 24.
- Run completed successfully at 2026-10-16 19:13:16 UTC. Success means the diagnostic ran, not that Farside passed.
- Artifact: `etf-source-access-38953271744`, retained for 14 days, attached to that run.

## Exact access results

All response Date headers were **Fri, 16 Oct 2026 19:13:14 GMT**.

| URL | HTTP status / status text | Content-Type | Server | cf-mitigated | Data outcome |
| --- | --- | --- | --- | --- | --- |
| `https://farside.co.uk/robots.txt` | 200 / OK | text/plain | cloudflare | absent | `User-agent: Twitterbot\r\nDisallow:` |
| `https://farside.co.uk/btc/` | 403 / Forbidden | text/html; charset=UTF-8 | cloudflare | challenge | No table; completeness `not_assessable_access_denied` |
| `https://farside.co.uk/bitcoin-etf-flow-all-data/` | 403 / Forbidden | text/html; charset=UTF-8 | cloudflare | challenge | No table; completeness `not_assessable_access_denied` |
| `https://bitcoin-data.com/v1/etf-flow-btc?startday=2026-10-01&endday=2026-10-15` | 200 / empty status text | application/json | nginx/1.24.0 (Ubuntu) | absent | 10 observations; first Oct 1, last Oct 14 |

Requests used ordinary Node fetch without credentials, spoofed browser headers, cookies, proxies, redirect following or challenge solving. There was one request per listed endpoint and no retry. A readable robots file does not authorize data reuse. BGeometrics' successful response is still BTC-denominated and does not qualify it as a USD-flow replacement.

## Completeness findings

The runner received no Farside flow data, so it cannot certify fund coverage, current reporting dates, completeness, or reliability. Synthetic diagnostic tests establish that all-dash funds with a zero total, one missing fund, changed fund columns, malformed row widths, inconsistent totals and challenge HTML are distinguished from numeric rows.

The prior browser research remains separate evidence: the October 16 row had all twelve fund cells missing despite a 0.0 total; October 15 was fully numeric. Those are not runner-validated observations, and fully numeric cells alone do not establish final reporting. See the [original source review](BTC-ETF-SOURCE-REVIEW-2026-10-16.md).

## October 7 reconciliation

The exact stored SoSoValue value is **-$487,067,411.50**, dated 2026-10-07 (Unix timestamp 1791331200000). The earliest matching snapshot examined is [commit b6bceb17](https://github.com/twinpro/slip39-learning-lab/commit/b6bceb17be5cf65b0ef71a6b49f34d348110c522), generated/fetched **2026-10-08T05:18:19.913Z**, with source `SoSoValue official API v2` and source status `ok`.

Examined 201 data commits between October 8 and October 10 UTC. Of these, 179 contain that date, all with the identical value; the other 22 do not contain it. Latest matching snapshot in that interval: `f11439194ac1f8b50fddfaded7b7db5727904eb3`, generated October 9 at 23:48:18.450Z. These copies are lineage evidence, not 179 independent source confirmations. The discrepancy predates the October 16 pipeline repair.

The [Farside table](https://farside.co.uk/btc/) previously observed displays these nonzero October 7 flows (USD millions): IBIT -207.7, FBTC -105.1, BITB -27.6, ARKB -101.7, HODL -3.5, GBTC -39.3. Its other six displayed fund values, including MSBT, are zero. The components sum exactly at displayed precision to **-$484.9 million**.

Thus Farside minus the stored SoSoValue value is **+$2,167,411.50**, or **0.444992%** of the stored outflow magnitude. It is not explained by:

- summing Farside's displayed fund cells incorrectly;
- converting millions to dollars incorrectly;
- a new October 16 pipeline change;
- removing MSBT alone, whose displayed flow on that date is zero;
- ordinary one-decimal rounding under the conservative $650,000 diagnostic allowance.

The archived SoSoValue data contains daily aggregate totals, not the underlying per-fund response. Therefore we cannot identify the differing fund or reconstruct that provider's share-count/reference-price calculation. No matching primary-source per-fund archive or provider correction explaining this exact difference was established. A contemporaneous [secondary report](https://cryptoticker.io/en/bitcoin-etf-daily-outflow-reasons/) mentions both totals and attributes differences to estimation methods/cutoffs, but that general explanation is **not verified primary-source reconciliation**. Methodology, cutoff timing, later revisions, and other fund-coverage differences remain hypotheses.

No stored record was replaced, no adjustment was added, and the discrepancy remains unresolved. Resolving it requires dated per-fund records and methodology/correction confirmation from the providers.

## Read-only isolation verified

1. Runner logs list only **Contents: read** and **Metadata: read** for GITHUB_TOKEN. There are no repository, issue, Pages or deployment write permissions. No provider secret or GitHub token was passed to the diagnostic script.
2. Checkout uses `persist-credentials: false`. The diagnostic imports only its offline inspection helper and Node filesystem/crypto modules. It calls neither collector/publisher/commit scripts nor the live watchdog. The issue tests use an in-memory fake API.
3. Job guard requires `refs/heads/codex/etf-source-review`; its only automatic trigger is a path-filtered push to that exact branch. There is no schedule. Existing scheduled workflows run from the default branch, which was unchanged.
4. The only diagnostic output file is in the runner's temporary directory, uploaded as an Actions artifact. It is not written into `data/` or committed. The post-diagnostic tracked/unstaged/staged/untracked cleanliness and unchanged-HEAD checks all passed.
5. GitHub's runs API returned only this diagnostic for the tested commit. No collector, watchdog, data commit or deployment ran from it.
6. The Pages API confirmed source **main, /**, legacy branch publishing. The diagnostic branch is not its source.
7. `main` remained at `a9b3b2dc2b34d5c8e874b9c4f10c1e471dcc644b` after the diagnostic. No push or merge to main occurred. The issues API still returned an empty list; no live alert was created, closed or activated by this work. The existing main watchdog was not changed.
8. Production HTML, snapshot, health and history fetched after the run returned HTTP 200 and matched the baseline checkout, normalizing only CRLF/LF. Hashes below.

| Production path | SHA-256 after newline normalization |
| --- | --- |
| data/btc-market.json | e664bb8121dc833dbd0d94938c01e7eae31fb8b29a9232e15a7c2634bff0e8dc |
| data/btc-market-health.json | 0a47de7c486d72d8b59fa38d9fac62c6e840033f10990eff760aea01cac8e7a7 |
| data/btc-market-history.jsonl | ecd9202b30366da1bf0624b8ed0ff4d198f46f692757a13a2a20cf176659fd74 |
| pages/btc-real-vs-paper-v11b.html | a925005f76491c3bcc69963d2f473e3a8c57afac3ccd02e03ae313e1e5d1a98e |

## Tests and remaining gates

The actual GitHub runner passed **19/19 tests**: 13 alert lifecycle tests and 6 source-inspection tests. The same 19 passed locally. The preceding review passed 188 regression tests; those were not all rerun on this diagnostic runner. The hosted run parsed and executed the workflow successfully and passed the checkout-isolation step.

The runner reported an action-runtime deprecation warning for upload-artifact@v4 being forced from Node 20 to Node 24. Upload completed successfully; this warning did not affect the HTTP observations or permissions.

Permission for recurring Farside collection and public republication remains unestablished. Access is currently blocked on the tested hosted runner, and the October 7 discrepancy remains unresolved. Farside must not be activated. No further production change is proposed now. Any future production change or live GitHub issue test requires separate approval after these blockers are addressed.
