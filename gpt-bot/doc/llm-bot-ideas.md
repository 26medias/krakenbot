Love it. If you’re going to put an LLM in the loop, treat it like a **high-level, episodic decision maker**—not a tick-chaser. Here’s a pragmatic blueprint that won’t waste tokens and keeps you in control.

# 1) When to invoke the LLM (event-driven, not time-driven)

Use a **debounced event bus**. Only fire the LLM when the market *context changes meaningfully* or when risk controls need a decision. Concrete triggers:

## A. Regime & structure flips

* **Trend regime flip**: e.g., 15m/1h triple-MA state changes (fast crosses slow) with confirmation (price above/below VWAP & 1×ATR).
* **Volatility regime change**: 20-bar realized vol or ATR percentile crosses 70/30.
* **Market state switch**: Range → Breakout (close beyond 2× recent swing distance + volume spike).

## B. “Confluence score” changes

Maintain a rolling integer score from 0–5 based on independent signals:

* Directional bias (50/200 MA alignment)
* Momentum (RSI 14 crossing 50, MACD hist sign)
* Volume/OBV confirmation
* VWAP premium/discount (z-score)
* Market microstructure (order-book imbalance > X%)
  Only **on score deltas** (e.g., from 1→3 or 3→1) do you call the LLM.

## C. Liquidity/swing interactions

* **Sweep & reclaim**: Price wicks below prior swing low by >0.5×ATR then closes back above.
* **Break & hold**: 30m close beyond a daily HTF level (prior day high/low, weekly open).
* **Stop-run signature**: Large delta/volume burst at level + immediate mean reversion (use footprint if you have it; otherwise proxy with tick volume & wick metrics).

## D. Risk & PnL maintenance

* **Stop/TP proximity**: Unrealized R multiple crosses ±1.0R or ±2.0R.
* **Drawdown guardrail**: Daily realized PnL −X% → ask LLM whether to pause, reduce size, or continue.
* **Position age**: Trade open > N bars without reaching +0.5R or −0.5R (time stop).

## E. Scheduled, low-frequency checks

* **Bar closes only** on key TFs: 15m, 1h, 4h.
* **News calendar window** (if you include it): major crypto market events in ±10 min (optional for spot DOGE/USD).

> Debounce rule: If multiple triggers fire within 60s, coalesce into one LLM call with a merged “ReasonForCall” array.

---

# 2) What data to give the LLM (tight, multi-TF, engineered)

Do **not** stream raw bars. Hand the model *summaries and edges*—small, lossless(ish) features that matter for trading.

## Timeframes

* **Micro/entry**: 1m (compressed), 5m (primary), 15m (secondary)
* **Context**: 1h, 4h, 1d

## Price/vol features (per TF)

* OHLC of last close + **location vs.**: last 20-bar VWAP, rolling mid (SMA20), and **z-scores**:

  * `PriceZ20 = (Close − SMA20)/Std20`
  * `VWAPZ = (Close − VWAP)/Std20`
* **ATR(14)** absolute & as % of price; **ATR percentile** vs last 90 bars.
* **Range compression/expansion**: Current true range vs 20-bar median (ratio).
* **Swing structure**: distances to last 2 swing highs/lows (in ATRs), did we close above/below them, wick sizes (upper/lower as % of range).

## Momentum & trend

* **RSI(14)** raw + slope (ΔRSI/Δbar), distance from 50.
* **MACD(12,26,9)**: sign of histogram, cross state, histogram slope.
* **MA stack**: SMA20/50/200 ordering (encoded), **cloud** thickness (SMA50−SMA200 in ATRs).

## Volume & participation

* **Volume z-score (20)**, **OBV direction** over last N bars (−1/0/+1), **volume spike** flag (>2× median).
* If you have it: **tape delta proxy** (up-tick vs down-tick count) over last 20 bars.

## Microstructure (optional but powerful)

* **Order-book imbalance**: (bid depth − ask depth) / (bid + ask) at top 5 levels.
* **Spread** in bps, **slippage estimate** for your size (so LLM can weigh market vs limit).

## Higher-timeframe anchors

* Distance (in ATRs) to:

  * Prior day high/low, prior week high/low
  * Daily/weekly open
  * 1D VWAP (session) and rolling 1D VWAP from reset points

## Trade & risk state

* Current position: side, size, avg price, **unrealized R**, time-in-trade (bars)
* Active stops/TPs (distance in ATRs)
* Daily PnL, max drawdown today, **risk mode** (normal / tighten / pause)

## Event reason (why you’re calling)

* A compact list: `["TrendFlip(H1)", "Break&Hold(15m prior high)", "DDGuardrail(−2.1%)"]`

---

# 3) Action space (keep it narrow)

Make the LLM choose from deterministic primitives; you implement sizing math.

* `HOLD`
* `OPEN_LONG(size_pct, entry={market|limit}, limit_offset_bps, stop_atr, tp_atr)`
* `OPEN_SHORT(...)` *(omit if spot-only)*
* `ADD(size_pct, ... )`
* `TRIM(size_pct)`
* `CLOSE_PARTIAL(size_pct)` / `CLOSE_ALL`
* `MOVE_STOP(to={breakeven|entry±x*ATR})`
* `SET_TP(x*ATR)` / `CANCEL_TP`
* `PAUSE(minutes)` *(risk cool-off)*

Hard constraints you enforce regardless of LLM:

* Max risk per trade (e.g., **0.5–1.0% equity**).
* Max concurrent risk (e.g., **1.5% total**).
* No chasing: forbid limit-buy **above** last close or market buy if `RSI>75` and `PriceZ20>1.5` unless regime says breakout *and* volume spike flag is on.

---

# 4) Call cadence & payload sizes

* **Primary cadence**: on **15m bar close** + **event coalescer** (earliest of: regime flip, liquidity interaction, risk guardrail).
* **Payload target**: **1–3 KB JSON**, ≤ 300 tokens. Summaries only; include the **last 3 bars** per TF as tiny tuples plus the engineered features above.

---

# 5) Prompt contract (deterministic, DRY)

Give the model a **strict schema** so you can parse reliably. Example:

```json
{
    "pair": "DOGE-USD",
    "reason_for_call": ["TrendFlip(H1)", "Break&Hold(15m prior high)"],
    "timeframes": {
        "5m": { "close": 0.1224, "rsi": 58.2, "macd_hist": 0.0007, "price_z20": 0.9, "atr": 0.0018, "vol_z20": 2.1, "vwap_z": 0.6, "swing": {"to_last_high_atr": 0.7, "to_last_low_atr": 1.9}, "range_ratio": 1.6 },
        "15m": { "...": "..." },
        "1h": { "...": "..." },
        "4h": { "...": "..." },
        "1d": { "...": "..." }
    },
    "htf_anchors": { "dist_to_prev_day_high_atr": 0.4, "dist_to_prev_day_low_atr": 3.2, "daily_open_z": 0.8 },
    "orderbook": { "imbalance": 0.18, "spread_bps": 1.2, "slippage_bps_for_size": 3.5 },
    "position": { "side": "FLAT", "size_pct": 0, "unrealized_R": 0, "age_bars_5m": 0 },
    "risk": { "daily_pnl_pct": -0.6, "risk_mode": "normal" },
    "constraints": { "max_trade_risk_pct": 0.75, "max_total_risk_pct": 1.5 }
}
```

**System prompt (summary):**

* “You are a tactical crypto trading assistant. You must output ONLY the JSON per the schema below. Choose one of: HOLD, OPEN_LONG, ADD, TRIM, CLOSE_PARTIAL, CLOSE_ALL, MOVE_STOP, SET_TP, PAUSE. Prefer high R multiple, avoid chasing, respect constraints. Explain *briefly* in `comment` (≤ 12 words).”

**Model output schema (strict):**

```json
{
    "action": "OPEN_LONG",
    "size_pct": 25,
    "entry": {"type": "limit", "offset_bps": -8},
    "stop_atr": 1.2,
    "tp_atr": 2.5,
    "followups": ["MOVE_STOP: breakeven on +1.0R", "TRIM 30% at +1.5R"],
    "comment": "Breakout with volume; buy discount into retest."
}
```

---

# 6) Guardrails & sanity checks (your code, not the LLM)

* **Pre-flight**: reject actions violating risk limits, or that conflict with microstructure (e.g., limit offset beyond spread×3).
* **Post-fill hooks**: auto-attach stop/TP specified by LLM; re-invoke only on next event.
* **Cool-offs**: after 2 losing trades in 60 min, require PAUSE or reduce `size_pct` by half unless confluence ≥4.

---

# 7) Minimal class skeleton (clean, DRY, event-driven)

```python
class FeaturePack:
    def __init__(self, pair):
        self.pair = pair
    def build(self, market_state) -> dict:
        # compute engineered features per TF, confluence score, anchors, position snapshot
        return {...}

class EventEngine:
    def __init__(self, rules):
        self.rules = rules
        self.last_score = None
    def detect(self, market_state) -> list[str]:
        # evaluate regime flips, volatility percentiles, liquidity interactions, risk events
        # debounce/coalesce and return reasons
        return ["TrendFlip(H1)", "Break&Hold(15m prior high)"]

class LLMDecider:
    def __init__(self, llm_client, constraints):
        self.llm = llm_client
        self.constraints = constraints
    def decide(self, features: dict, reasons: list[str]) -> dict:
        payload = {**features, "reason_for_call": reasons, "constraints": self.constraints}
        # call LLM with strict system prompt; return parsed JSON
        return self.llm.call(payload)

class ExecutionLayer:
    def __init__(self, broker):
        self.broker = broker
    def enforce_and_execute(self, decision: dict, market_state):
        # risk checks, translate offsets to prices, place orders/stops/TPs
        # log everything for paper trade analytics
        pass

class Bot:
    def __init__(self, feeds, rules, llm, broker, constraints):
        self.features = FeaturePack(pair="DOGE-USD")
        self.events = EventEngine(rules)
        self.decider = LLMDecider(llm, constraints)
        self.exec = ExecutionLayer(broker)
    def on_tick_or_bar(self, market_state):
        reasons = self.events.detect(market_state)
        if not reasons: 
            return
        feat = self.features.build(market_state)
        decision = self.decider.decide(feat, reasons)
        self.exec.enforce_and_execute(decision, market_state)
```

(Yes, 4-space tabs, classes, DRY.)

---

# 8) Starter thresholds (you’ll tune these)

* **Vol regime upshift**: ATR(14) percentile > 70 on 15m **and** volume z-score > 1.5.
* **Trend flip**: 15m SMA20 cross SMA50 with MACD hist sign agree **and** price above VWAP by >0.5 Std20.
* **Break & hold**: 15m close > prior day high by >0.3 ATR and retest holds (next 1–3 bars don’t close back inside).
* **Liquidity sweep**: wick > 0.6×ATR beyond prior swing, close back inside + volume z > 1.8.

---

# 9) Why this split works

* Indicators do **filtering**; the LLM does **judgment** on *conflicts* (e.g., momentum vs. liquidity signal disagreement).
* Event gating keeps token costs low and prevents overtrading.
* Action space + constraints make the LLM’s job concrete and auditable.
