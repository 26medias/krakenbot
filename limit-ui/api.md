# Local Kraken API Server

Run the server with:
```bash
node server
```
(Inherits `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` from the environment. Set `KRAKEN_API_PORT` to override the default `3000`.)

## Endpoints

### GET /balances
- **Description:** Returns the raw Kraken balance map.
- **Query Parameters:** none
- **Response:**
  ```json
  {
    "XETH": "0.0000000000",
    "XXDG": "4920.24000000",
    "ZUSD": "1002.0211"
  }
  ```

### GET /price
- **Description:** Fetches the latest OHLC snapshot for a trading pair.
- **Query Parameters:**
  - `pair` (string, required) – Pair symbol, e.g. `DOGEUSD`.
- **Response:**
  ```json
  {
    "o": 0.18941,
    "h": 0.19012,
    "l": 0.18777,
    "c": 0.18853,
    "v": 127345.2145
  }
  ```

### GET /pairs
- **Description:** Lists tradable asset pairs filtered to symbols that include `USD`.
- **Query Parameters:** none
- **Response:** Array of simplified pair metadata with headline fee percentages.
  ```json
  [
    {
      "pair": "1INCHUSD",
      "altname": "1INCHUSD",
      "wsname": "1INCH/USD",
      "base": "1INCH",
      "quote": "ZUSD",
      "lot": "unit",
      "pair_decimals": 4,
      "lot_decimals": 8,
      "lot_multiplier": 1,
      "fee_volume_currency": "ZUSD",
      "fees": 0.4,
      "fees_maker": 0.25,
      "ordermin": 11,
      "costmin": 0.5,
      "tick_size": 0.0001,
      "status": "online"
    }
  ]
  ```

### GET /orders/open
- **Description:** Lists all open orders.
- **Query Parameters:** none
- **Response:** Array of order objects, one per transaction.
  ```json
  [
    {
      "txid": "OABC123",
      "refid": null,
      "userref": null,
      "status": "open",
      "opentm": 1715884920,
      "closetm": null,
      "starttm": 0,
      "expiretm": 0,
      "vol": 100,
      "vol_exec": 0,
      "cost": 0,
      "fee": 0,
      "price": 0.145,
      "limitprice": 0,
      "descr": {
        "pair": "DOGEUSD",
        "type": "buy",
        "ordertype": "limit",
        "price": "0.145",
        "price2": "0",
        "leverage": "none",
        "order": "buy 100 DOGEUSD @ limit 0.145"
      }
    }
  ]
  ```

### GET /orders/closed
- **Description:** Returns up to the 50 most recent filled orders.
- **Query Parameters:** none
- **Response:** Array ordered by close time descending.
  ```json
  [
    {
      "txid": "CXYZ789",
      "status": "closed",
      "opentm": 1715800000,
      "closetm": 1715800600,
      "vol": 50,
      "vol_exec": 50,
      "cost": 9.25,
      "fee": 0.02,
      "price": 0.185,
      "limitprice": 0,
      "descr": {
        "pair": "DOGEUSD",
        "type": "sell",
        "ordertype": "limit",
        "price": "0.185",
        "price2": "0",
        "order": "sell 50 DOGEUSD @ limit 0.185"
      }
    }
  ]
  ```

### POST /orders/limit
- **Description:** Places a limit order via Kraken.
- **Body Parameters (JSON):**
  - `pair` (string, required)
  - `type` (string, required) – `buy` or `sell`
  - `price` (number, required) – Limit price
  - `qty` (number, required) – Order volume
- **Response:**
  ```json
  {
    "result": {
      "descr": {
        "order": "buy 25 DOGEUSD @ limit 0.01"
      },
      "txid": ["OABC123"]
    }
  }
  ```

### POST /orders/cancel
- **Description:** Cancels open limit orders for a pair based on a price threshold.
- **Body Parameters (JSON):**
  - `asset` (string, required) – Pair to filter, e.g. `DOGEUSD`.
  - `op` (string, required) – `gt` (cancel if price greater than limit) or `lt`.
  - `limit` (number, required) – Price threshold.
- **Response:** Cancellation summary.
  ```json
  {
    "total": 2,
    "cancelled": [
      { "txid": "OABC123", "response": { "count": 1 } }
    ],
    "failed": [
      { "txid": "OABC456", "error": "Order already closed" }
    ]
  }
  ```
