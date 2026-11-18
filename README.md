# Deriv Intelligence AI — MVP 0.1

A mobile-friendly, read-only research dashboard for Deriv synthetic indices.

## Included
- Public Deriv WebSocket connection (no Deriv account token required)
- Synthetic/derived market discovery
- Candle history and live tick updates
- Multiple candle timeframes
- Lightweight chart
- Transparent EMA/RSI/momentum research bias
- Browser notification permission and session signal log
- Responsive phone layout

## Important limitations
- This is an experimental MVP, not a profitable or validated trading system.
- BUY BIAS / SELL BIAS are indicator agreement labels, **not trade instructions or win probabilities**.
- No automatic execution, no account login, no order placement.
- No historical backtest engine or Telegram delivery in this first package.
- Market classification depends on Deriv's current active-symbol metadata and may need adjustment.
- The browser needs an internet connection and access to the Deriv public WebSocket endpoint.
- Lightweight Charts is loaded from unpkg CDN.

## Publish from a phone
1. Download and extract `deriv-intelligence-ai-mvp.zip` on your device if your browser/file manager supports extraction.
2. Publish the contents of the extracted folder to a static hosting service such as Netlify Drop or a Git-based static host.
3. Make sure `index.html` is at the published site's root, and the `static` folder is alongside it.
4. Open the HTTPS website link on your phone.
5. Wait for the connection indicator to show Connected. Select a market and timeframe.

A static hosting service may require signing in and may have a different upload flow on mobile. Do not share account passwords with anyone.

## Local desktop preview
Serve the folder with any static HTTP server, then open the local URL. For example:
`python -m http.server 8000`
Open `http://localhost:8000`.

## Troubleshooting
- If the market list is empty, reload and check whether the Deriv public WebSocket is reachable on your network.
- If the chart library does not load, check internet access to unpkg.com.
- If you see "Disconnected", wait for automatic reconnect or tap Refresh data after reconnecting.
- Browser notifications require HTTPS (or localhost) and permission.
- If a symbol does not appear, the market metadata filter may need to be updated.

## Version
0.1.0 — first test build. No profitability claims.
