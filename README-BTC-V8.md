# BTC Real vs Paper V8 — $0 data version

No paid API key is required. Do not buy CoinGlass or any other data subscription for this build.

Automated sources:
- Farside Investors public Bitcoin ETF flow table
- Bybit public BTC perpetual open interest / funding
- OKX public BTC perpetual open interest / funding
- Coinbase BTC-USD and OKX BTC-USDT public spot tickers

Important limitation:
A trustworthy free machine-readable all-exchange BTC balance history was not verified. V8 displays that metric as `Verification needed` and excludes it from the numerical verdict. This is deliberate.

Deployment:
1. Extract this ZIP over the existing local `slip39-learning-lab` folder. KEEP the existing `.git` folder.
2. Commit and push.
3. GitHub -> Actions -> `Update BTC real-vs-paper data FREE` -> Run workflow.
4. No GitHub secret is needed.
5. Open `/pages/btc-real-vs-paper-v8.html`.

The scheduled Action refreshes every 15 minutes.
