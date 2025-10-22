# Kraken Bot Control – Comprehensive Documentation

## Install & Requirements

- **Node.js**: v18+ (tested with the current LTS).  
- **npm**: to install dependencies declared in `bot/package.json`.  
- **Kraken API credentials**: export `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` in the environment before running any scripts that touch private endpoints.

```bash
cd bot
npm install
export KRAKEN_API_KEY=...
export KRAKEN_API_SECRET=...
```

The HTTP server is started with:

```bash
node bot.js [--port <number>] [--pair <pair>] [--risk <percent>]
```


## Script Options

The CLI is powered by `commander` and supports:

| Option         | Default | Description                                                                    |
|----------------|---------|--------------------------------------------------------------------------------|
| `--port <n>`   | `3007`  | TCP port for the control server + WebSocket feed.                              |
| `--pair <id>`  | `XDGUSD`| Initial trading pair (Kraken altname).                                         |
| `--risk <n>`   | `50`    | Risk allocation percentage (1–100) used to size orders/balances.              |

On start the server listens for HTTP and WebSocket traffic and initialises a `TradingBotManager` using the provided pair & risk. Settings are persisted per pair at `bot/config/bot-settings.json`.


## HTTP & WebSocket Endpoints

Base URL: `http://localhost:<port>`

| Method & Path            | Params (body/query)                                                                                   | Returns                                                                                                   |
|--------------------------|--------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `GET /`                  | –                                                                                                      | Static dashboard UI (`bot/static/page.html`).                                                              |
| `GET /api/status`        | –                                                                                                      | `{ pair, risk, running, settings }` describing the live manager state.                                     |
| `GET /api/dashboard`     | `pair` (query, optional)                                                                               | Full snapshot `{ pair, risk, running, settings, price, balances, openOrders, distribution }`.             |
| `GET /api/pairs`         | –                                                                                                      | Kraken USD pairs with metadata (`altname`, `wsname`, decimals, etc.).                                      |
| `PATCH /api/settings`    | JSON `{ pair?, risk?, settings? }`                                                                    | Updated dashboard snapshot after persisting the new configuration (used by “Apply Changes”).              |
| `POST /api/bot/start`    | JSON `{ pair?, risk?, settings? }`                                                                    | Snapshot after the bot has been started (initialises subscriptions / orders if necessary).                |
| `POST /api/bot/stop`     | –                                                                                                      | `{ pair, risk, running, settings }` reflecting the stopped state.                                          |
| `POST /api/orders/cancel`| JSON `{ pair? }`                                                                                       | `{ success: true, result }` summarising cancelled orders for the chosen pair.                              |
| `POST /api/orders/reset` | JSON `{ pair? }`                                                                                       | `{ success: true, result }` after cancelling and recreating the limit grid.                                |
| `POST /api/preview`      | JSON `{ pair?, risk?, settings? }`                                                                    | Snapshot using supplied inputs **without** mutating live settings (drives UI previews).                    |
| `GET /ws/price`          | Query `pair` (optional; defaults to current)                                                           | WebSocket feed; messages every ≤30s `{ type: 'price', pair, price: { o,h,l,c,v, retrievedAt }, timestamp }`. |

**Error handling**: API responses use HTTP status codes and JSON `{ error: message }` on failure.


## Dashboard UI Reference

The dashboard (`/`) is the primary way to monitor and tune the strategy.

- **Header widgets**
  - Pair selector: loads per‑pair defaults from `bot-settings.json` and reconnects the price stream.
  - Live price: updated via WebSocket (30 s cadence max).
  - Balances: shows total account balances and risk-adjusted allocations (`balance × risk%`).
  - Status pill + Start/Stop button: reflects bot lifecycle state.

- **Bot Controls**
  - `Risk Allocation`: slider (1–100%, 0.5 step). Drives risk-adjusted balances and ladder sizing. Changes preview instantly but are only committed when you click **Apply Changes**.
  - `Orders per Side`: integer input controlling ladder depth (applies symmetrically to buy/sell).
  - `Minimum Order Value (USD)`: floor per order; orders below the limit are rescaled/filtered.
  - Buttons:
    - `Apply Changes`: persists current pending settings/risk to the bot.
    - `Clear Orders`: cancels all live limit orders for the active pair.
    - `Reset Orders`: cancels and immediately rebuilds the ladder using current settings.

- **Distribution Controls**
  - `Price Spacing` (slider −100→100): shapes intra-ladder spacing. Negative skews density closer to the current price on the buy side, positive does the opposite. Neutral (`0`) spaces evenly.
  - `Spacing Margin`: trims a % from the far side of the distribution; allows “padding” away from extremes.
  - `Order Value Spread`: similar control but for capital allocation per level (weighting).
  - `Value Margin`: margins applied to the value weighting curve.
  - `Price Range Period (min)`: lookback window for `DataTools.getPriceRange` (default 120 min).
  - `Range Multiplier`: multiplier applied to the raw high/low spread before converting to % of price.

Adjustments update the preview chart and table via `/api/preview`. The live bot only changes after `Apply Changes` or `Start Bot`.

- **Order Distribution Panel**
  - `Scatter`, `Bar`, `Bubble` toggles: change the Chart.js renderer; all plots include a dashed current-price line.
  - Tables display open limit orders (price, quantity, value, distance %, status). Totals are recalculated on every preview or snapshot refresh.

- **Summary Tiles**
  - Total orders, combined order value, total USD balance (actual account figure).


## Internal Structure

### Key Modules

- **`bot/bot.js`**  
  - `Bot` class encapsulates Kraken interactions (balances, order placement, rebalance logic).  
  - `TradingBotManager` manages the active bot instance, settings persistence (per pair), REST/websocket server wiring.  
  - HTTP handler exposes endpoints; `startServer` ties everything together.
- **`bot/static/page.html`**  
  Tailwind/Chart.js UI. Shows settings, live price feed, charts and open orders; previews adjustments locally before applying.
- **Supporting modules**  
  - `Data.js`: thin Kraken REST client with retry + signing helpers.
  - `DataTools.js`: analytics helpers (price range, volatility, etc.).  
  - `LimitOrders.js`: calculates buy/sell ladders given settings.  
  - `KrakenMonitor.js`: websocket subscriptions for price and execution events.

### Persistence

`bot/config/bot-settings.json` stores per-pair `{ risk, settings }`. When the server starts or the UI selects a pair, the manager pulls defaults from this file; applying changes overwrites the entry.


## Code Logic Overview

1. **Startup** (`node bot.js …`)  
   - CLI arguments initialise `TradingBotManager`.  
   - Manager loads saved settings for the chosen pair (fallback to defaults).  
   - HTTP + WebSocket server spins up.

2. **UI Flow**  
   - On load the dashboard fetches `/api/status` and `/api/dashboard`.  
   - Slider changes update a pending settings profile, trigger `/api/preview`, and re-render charts/balance projections in real time.  
   - Clicking **Apply Changes** (or **Start Bot**) sends the pending payload to `/api/settings`/`/api/bot/start`, which persists the configuration and updates the live bot.

3. **Bot Execution** (`TradingBotManager.start`)  
   - Normalises inputs, updates persistence, and calls `Bot.init()`.  
   - `Bot` subscribes to Kraken execution events, checks existing limit orders, rebuilds if one side is empty, and keeps risk-adjusted balances cached.

4. **Rebalancing** (`Bot.onRebalance`)  
   - Triggered on limit fills.  
   - Recomputes open orders using current settings (`calculateLimitRanges`), cancels depleted sides, and recreates orders as needed while throttling concurrent runs via `this.busy`.

5. **Order Management**  
   - `calculateLimitRanges` pulls price ranges (with period + multiplier), applies distribution controls, and returns ladder summaries (buy/sell arrays plus totals).  
   - `createLimitOrders` normalises precision, submits Kraken `AddOrder` requests, logs outcomes, and persists snapshots (`openOrders.json`, `orders.json`).

6. **Shutdown**  
   - SIGINT/SIGTERM handlers stop the HTTP server and call `TradingBotManager.stop`, which closes websocket subscriptions cleanly.

## Strategy & Mathematics

### Core Idea

The bot maintains a symmetric ladder of limit orders around the current price for a chosen Kraken pair. Capital allocation and spacing are derived from recent price action, user-configurable distribution curves, and risk settings. The approach seeks to capture mean reversion: buys execute when price dips into the ladder, sells when price rises. Filled orders trigger rebalancing and regeneration of the depleted side.

### Price Range & Volatility Inputs

1. **Latest Price (`latest.c`)**: pulled from Kraken OHLC data (1 min interval).
2. **Historical Range**: `DataTools.getPriceRange(period)` returns `{ high, low }` for the configured lookback window (e.g. 120 minutes).
3. **Range Multiplier**: user-provided scalar (>0) that expands or contracts the raw high–low difference.
4. **Percent Range**: `pctRange = ((high - low) × multiplier / currentPrice) × 100`, with a fallback to 20% if the math yields a non-finite or zero value.
5. **Positive & Negative Ranges**: distances applied above and below the current price; defaults use the same % range. For rebalances the bot may pass explicit distances derived from the surviving side of the book.

### Risk-Adjusted Balances

- Account balances are fetched via private `/Balance`.
- Risk slider `r` (1–100) scales the quote/base holdings:  
  - `quoteAlloc = balance.quote × r / 100`  
  - `baseAlloc = balance.base × r / 100`
- These allocs represent the capital that the strategy is allowed to deploy and are also displayed in the UI.

### Distribution Maths (`LimitOrders`)

Given inputs `{ currentPrice, positiveRange, negativeRange, ordersPerSide, usdBalance, assetBalance, minOrderValue, spacingSpread, spacingMargin*, valueSpread, valueMargin*, ... }`, the algorithm proceeds:

1. **Spacing Curve**
   - Converts slider `spacingSpread` from `[-1,1]` to a normalized exponent with `#normalizeSpread`.
   - `calculatePointPositions(count, spread, marginLeftPercent, marginRightPercent)` computes a normalized `[0,1]` position array:
     - `spread = 0`: linear spacing.
     - `spread < 0`: exponential concentration near the left margin (closer buys near current price).
     - `spread > 0`: exponential concentration near the right margin (denser far-out orders).
   - Margins remove a fixed percentage of the normalized interval on either side, shrinking the effective width where orders can sit.

2. **Value Weights**
   - The same normalized positions are mirrored and potentially reversed to generate `buyWeights` and `sellWeights`.
   - `valueSpread` modifies the weights analogous to spacing (exponential heavy-left/right).
   - Margin settings let you shift weighting concentration.

3. **Order Construction**
   - Buy levels: price = `currentPrice - negativeRange + negativeRange × normalizedPosition`.
   - Sell levels: price = `currentPrice + positiveRange × mirroredPosition`.
   - Quote allocation per level = `(weight / Σweights) × usdBalance`.
   - Base quantity = `value / price`.
   - Orders are filtered/adjusted to respect `minOrderValue`. Residual amounts are redistributed proportionally where possible.
   - Sell orders are sorted descending (highest price first) for readability and Kraken submission order.

4. **Outputs**
   - `buyOrders` / `sellOrders`: arrays of `{ price, quantity, value, distance, status }`.
   - Summaries (e.g., total quantities/values) used later for UI display and logging.

### Rebalance Strategy

- `Bot.onRebalance(event)` gates concurrent executions with `this.busy`.
- If one side of the book is empty (no buy or sell orders), the bot cancels everything, recomputes the full ladder, and repopulates both sides.
- Otherwise:
  - Retrieves open orders, finds the lowest buy and highest sell to estimate spread consumption.
  - Pulls the latest price.
  - Calls `calculateLimitRanges` with overrides for the depleted side’s range.
  - Cancels orders beyond the execution price (e.g., all sells above the fill when a buy completes).
  - Repopulates only the affected side with newly calculated orders.
- Every non-dry run submission eventually persists snapshots to `openOrders.json` and `orders.json` for auditing.

### Risk Controls & Persistence

- Each pair’s current configuration is saved in `bot/config/bot-settings.json` whenever the user applies changes or the bot is started with new inputs.
- On launch or pair switch, the manager reloads the saved state and recovers the latest risk/slider settings to ensure continuity.
- Risk is bounded in `[1,100]` by `clamp`; sliders enforce min/max on the client.

### Execution Safety

- Kraken nonce/timeout resilience is handled in `Data.js` with retries/backoff.
- Order submissions round price/volume to Kraken’s `pair_decimals` / `lot_decimals`.
- Cancelling uses pre-filtered order lists to avoid acting on other pairs.
- Websocket unsubscribe/close logic prevents leaking sockets when the bot stops.

With these components, the system offers a configurable mean-reversion limit grid that continuously adapts to recent volatility, with a real-time UI sandbox for testing parameters before applying them live. 
