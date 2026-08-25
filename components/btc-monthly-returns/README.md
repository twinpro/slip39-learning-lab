# Bitcoin Monthly Returns prototype

An isolated component backed by the free Coin Metrics Community API. It visually follows the Bitcoin Real vs Paper dashboard without importing its DOM, CSS, JavaScript, data collectors, or scoring logic.

## Run

From the repository root, start any static HTTP server, then open `components/btc-monthly-returns/index.html`. For example:

```sh
python -m http.server 8000
```

Then visit `http://localhost:8000/components/btc-monthly-returns/index.html`.

Tests require Node.js 20 or newer:

```sh
node --test components/btc-monthly-returns/monthly-returns.test.mjs
```

Refresh and validate the live data with:

```sh
node scripts/update-btc-monthly-returns.mjs
node --test scripts/test-monthly-returns-live.mjs components/btc-monthly-returns/monthly-returns.test.mjs
```

The updater requests daily `PriceUSD` observations beginning December 1, 2012, selects the final available observation in each month, and calculates returns from consecutive monthly closes. Stored return precision is eight decimal places; display precision is one decimal place. The incomplete month is marked `MTD` and excluded from summary statistics.

The component loads `data/btc-monthly-returns.json`. If that live file cannot be loaded, it may use the development fixture, but the UI explicitly displays `PREVIEW DATA · NOT LIVE` and a warning.

Production integration is intentionally out of scope. No production page, data pipeline, or score imports this component.
