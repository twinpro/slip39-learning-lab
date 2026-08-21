# BTC Real vs Paper — V7 integration

This package is already merged into the current `slip39-learning-lab` project.

## Added

- `pages/btc-real-vs-paper-v7.html`
- `scripts/update-btc-market.mjs`
- `data/btc-market.json`
- `.github/workflows/btc-market-data.yml`

The existing Learning Lab pages, assets, simulators, 404 page and README are preserved.

## Required setup after you push the files

In GitHub:

**Repository → Settings → Secrets and variables → Actions → New repository secret**

Create:

`COINGLASS_API_KEY`

Use your CoinGlass API key as the value.

Do not put the key into HTML, JavaScript, README, or `data/btc-market.json`.

Then:

**Actions → Update BTC real-vs-paper data → Run workflow**

After the workflow succeeds, open:

`https://twinpro.github.io/slip39-learning-lab/pages/btc-real-vs-paper-v7.html`

## Data sources

### CoinGlass official API v4

V7 independently requests these endpoints so failure of one metric does not blank all others:

- `/api/futures/open-interest/exchange-list?symbol=BTC`
- `/api/exchange/balance/list?symbol=BTC`
- `/api/etf/bitcoin/flow-history`
- `/api/futures/pairs-markets?symbol=BTC` for OI-weighted funding

### Farside Investors

The GitHub Action reads the official Farside Bitcoin ETF table server-side. It is used as an independent ETF cross-check and as an ETF fallback if the CoinGlass ETF endpoint is unavailable.

### Public spot APIs

Coinbase BTC-USD and OKX BTC-USDT are fetched server-side to calculate the Coinbase premium. This is a U.S.-spot-demand proxy, not a direct measure of net BTC accumulation. USDT/USD drift can affect it.

### MacroMicro

MacroMicro is optional. The collector does not guess a private API endpoint.

If you have MacroMicro API access, add:

- `MACROMICRO_TOKEN`
- `MACROMICRO_API_URL`

The URL must be the exact Bitcoin Exchange Balance series-data endpoint supplied by MacroMicro to your account.

## Verdict logic

The real-BTC evidence score uses:

- ETF demand: 40%
- 30-day exchange-balance change: 35%
- Coinbase premium: 25%

The final supply-squeeze score is:

`80% real-BTC evidence + 20% inverse derivatives crowding`

Green also requires both ETF demand and exchange-balance tightening to pass minimum gates.

High open interest is not automatically bearish and is not treated as evidence of manipulation.

## Failure behavior

Missing or stale critical evidence displays:

`⚪ NOT ENOUGH FRESH DATA`

There are no hard-coded market values and no stale seed values.
