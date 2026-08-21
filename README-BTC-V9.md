# BTC Real vs Paper V9 — FREE source failover build

No paid API key. No subscription.

What V9 changes:
- Farside remains the first ETF source.
- If Farside blocks GitHub Actions, V9 tries a public Farside-data mirror.
- A mirror is accepted ONLY when its newest trading date is fresh (max 5 days). Stale data is rejected.
- Bybit is optional. A Bybit 403 no longer matters.
- Futures coverage now attempts OKX, Deribit, BitMEX, Hyperliquid and Bybit independently.
- At least two working futures venues are required before leverage is scored.
- Futures OI is always labeled PARTIAL, never global.
- Exchange BTC balance remains Verification Needed because no reliable free automated all-exchange feed has been verified.

Deploy:
1. Copy this ZIP over your existing repository. KEEP `.git`.
2. Commit and push.
3. GitHub -> Actions -> Update BTC real-vs-paper data FREE V9 -> Run workflow.
4. Open data/btc-market.json and verify source statuses.
5. Then test pages/btc-real-vs-paper-v9.html.
