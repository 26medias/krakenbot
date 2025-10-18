# Kraken Test Utilities

Helper scripts and a lightweight SDK for experimenting with the Kraken exchange. Everything in this folder expects Node.js ≥18 and an `.env` (or exported variables) containing credentials for private endpoints.

```bash
export KRAKEN_API_KEY=your_key
export KRAKEN_API_SECRET=your_secret
```

## Scripts

### `limits.js`
Distributes a series of buy or sell limit orders between the current market price and a target.

| Flag | Required | Description |
| --- | --- | --- |
| `--type <buy,sell>` | ✅ | Order side. |
| `--asset <pair>` | ✅ | Trading pair, e.g. `DOGEUSD`. |
| `--target <price>` | ✅ | Limit price furthest from the current price. |
| `--count <number>` | ✅ | Number of orders to create. |
| `--pct <percentage>` | ❌ | Portion of the available balance to allocate (default `100`). |
| `--min-pct <percentage>` | ❌ | Minimum share reserved for the first order (default `1`). |

Example:

```bash
node limits --type buy --asset DOGEUSD --target 0.14 --count 20 --pct 50 --min-pct 5
```

The script fetches balances, pulls live ticker data, computes weighted order sizes that honor the minimum allocation, and prints a confirmation table before submitting.

### `cancel.js`
Filters and cancels existing limit orders for a symbol when the price crosses a threshold.

| Flag | Required | Description |
| --- | --- | --- |
| `--asset <pair>` | ✅ | Trading pair, e.g. `DOGEUSD`. |
| `--op <gt,lt>` | ✅ | Cancel when the order price is greater-than or less-than the provided limit. |
| `--limit <price>` | ✅ | Price threshold used with `--op`. |

Example:

```bash
node cancel --asset DOGEUSD --op lt --limit 0.14
```

You will see a preview of the matching orders and be prompted before any cancellations are sent.

### `test.js`
Simple smoke test that calls the public data helpers.

```bash
node test
```

Outputs the latest OHLC candle, a slice of historical data (default 60‑minute buckets), and ticker snapshots for the pairs in the sample.

## Classes

### `Data` (`Data.js`)
Primary SDK exposed to the scripts. It wraps Kraken's REST API with minimal convenience logic.

#### Constructor
```js
const Data = require('./Data');
const data = new Data();
```
Reads `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` from the environment for private calls.

#### Methods

- `makeRequest(path, params = {}, isPublic = true)`  
  Low-level request helper used internally. Returns a `Promise` resolving to the `result` payload or rejecting on Kraken errors.

- `latest(pair)`  
  Fetches the most recent OHLC candle for `pair`. Resolves to `{ o, h, l, c, v }`.  
  ```js
  const candle = await data.latest('DOGEUSD');
  console.log(`Close: ${candle.c}`);
  ```

- `historical(pair, interval = 60, count = null, since = null)`  
  Retrieves historical candles. Optional `count` limits the number of returned entries.  
  ```js
  const last24 = await data.historical('DOGEUSD', 60, 24);
  ```

- `getServerTime()`  
  Returns Kraken server time metadata.  
  ```js
  const { unixtime } = await data.getServerTime();
  ```

- `getAssetInfo(assets = null)`  
  Pulls asset metadata. Accepts a single symbol or array.  
  ```js
  const info = await data.getAssetInfo(['XXBT', 'ZUSD']);
  ```

- `getTradablePairs(pairs = null, info = 'info')`  
  Lists tradable pairs and related details.  
  ```js
  const pairs = await data.getTradablePairs('DOGEUSD', 'fees');
  ```

- `getTicker(pairs)`  
  Fetches ticker snapshots for one or many pairs.  
  ```js
  const ticker = await data.getTicker(['DOGEUSD', 'BTCUSD']);
  ```

### `KrakenAPI` (`limits.js`, `cancel.js`)
An internal subclass of `Data` that exposes authenticated helpers used by the scripts:

- `getBalance()` — returns the full balance map from `/0/private/Balance`.
- `addOrder(type, pair, orderType, price, volume)` — submits a limit order.
- `getOpenOrders()` — retrieves open orders (used by `cancel.js`).
- `cancelOrder(txid)` — cancels an order by transaction ID.

These methods are automatically invoked by their respective scripts; instantiate `new KrakenAPI()` only if you need direct access for additional tooling.

---

For experimentation, run the scripts with `node <script> --help` to see Commander’s auto-generated usage info. Tests or dry-run stubs are not included, so consider wrapping commands in paper trades before using live keys.



## Automation Strategy

Initial State:
- Create 