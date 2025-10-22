const Indicators = require('./Indicators');

const DEFAULT_TIMEFRAMES = Object.freeze({
    '1m': { interval: 1, lookback: 300 },
    '5m': { interval: 5, lookback: 300 },
    '15m': { interval: 15, lookback: 300 },
    '1h': { interval: 60, lookback: 360 },
    '4h': { interval: 240, lookback: 360 },
    '1d': { interval: 1440, lookback: 120 }
});

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toZScore(value, sample) {
    if (!Array.isArray(sample) || sample.length === 0) {
        return null;
    }
    const mean = Indicators.average(sample);
    const std = Indicators.standardDeviation(sample, sample.length);
    if (!Number.isFinite(std) || std === 0) {
        return 0;
    }
    return (value - mean) / std;
}

function wickPercentages(candle) {
    const open = safeNumber(candle.o);
    const close = safeNumber(candle.c);
    const high = safeNumber(candle.h);
    const low = safeNumber(candle.l);
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const range = high - low;
    if (!Number.isFinite(range) || range <= 0) {
        return { upper: 0, lower: 0 };
    }
    const upper = Math.max(0, high - bodyHigh) / range;
    const lower = Math.max(0, bodyLow - low) / range;
    return { upper, lower };
}

function swingDistances(candles, atr) {
    if (!Array.isArray(candles) || candles.length === 0 || !Number.isFinite(atr) || atr === 0) {
        return {
            toLastHighAtr: null,
            toLastLowAtr: null
        };
    }
    const closes = candles.map((item) => safeNumber(item.c));
    const highs = candles.map((item) => safeNumber(item.h));
    const lows = candles.map((item) => safeNumber(item.l));
    const lastClose = closes[closes.length - 1];
    const lastHigh = Math.max(...Indicators.takeLast(highs, 50));
    const lastLow = Math.min(...Indicators.takeLast(lows, 50));
    return {
        toLastHighAtr: (lastHigh - lastClose) / atr,
        toLastLowAtr: (lastClose - lastLow) / atr
    };
}

function computeTrueRangeSeries(candles) {
    if (!Array.isArray(candles) || candles.length < 2) {
        return [];
    }
    const result = [];
    for (let i = 1; i < candles.length; i += 1) {
        const high = safeNumber(candles[i].h);
        const low = safeNumber(candles[i].l);
        const prevClose = safeNumber(candles[i - 1].c);
        result.push(Indicators.trueRange(high, low, prevClose));
    }
    return result;
}

function calcRangeCompression(trSeries) {
    if (!Array.isArray(trSeries) || trSeries.length === 0) {
        return null;
    }
    const latest = trSeries[trSeries.length - 1];
    const reference = Indicators.median(Indicators.takeLast(trSeries, 20));
    if (!Number.isFinite(latest) || !Number.isFinite(reference) || reference === 0) {
        return null;
    }
    return latest / reference;
}

class FeatureBuilder {
    constructor(options = {}) {
        const {
            pair,
            dataClient,
            logger,
            timeframes = DEFAULT_TIMEFRAMES,
            slippageNotional = 500
        } = options || {};

        if (!pair) {
            throw new Error('FeatureBuilder requires a trading pair');
        }
        if (!dataClient) {
            throw new Error('FeatureBuilder requires a data client');
        }

        this.pair = pair;
        this.data = dataClient;
        this.logger = logger || console;
        this.timeframes = timeframes;
        this.slippageNotional = slippageNotional;
        this.orderBookSnapshot = null;
        this.latestPrice = null;
        this.lastComputed = null;
    }

    setOrderBookSnapshot(snapshot) {
        this.orderBookSnapshot = snapshot;
    }

    setLatestPrice(priceData) {
        if (!priceData) {
            return;
        }
        const close = safeNumber(priceData.close);
        const timestamp = priceData.timestampUnix || Date.now();
        if (Number.isFinite(close)) {
            this.latestPrice = {
                close,
                timestamp
            };
        }
    }

    async build(context = {}) {
        const timestamp = Date.now();
        const timeframeEntries = Object.entries(this.timeframes);

        const timeframeResults = await Promise.all(timeframeEntries.map(async ([name, config]) => {
            try {
                const features = await this.#computeTimeframeFeatures(name, config);
                return [name, features];
            } catch (error) {
                this.logger.warn(`[FeatureBuilder] Failed to compute ${name} features: ${error.message}`);
                return [name, null];
            }
        }));

        const timeframes = timeframeResults.reduce((acc, [name, features]) => {
            if (features) {
                acc[name] = features;
            }
            return acc;
        }, {});

        const htfAnchors = await this.#computeAnchors(timeframes['15m'], timeframes['1d'], timeframes['4h']);
        const orderbook = this.#computeOrderBookFeatures(timeframes['5m']);
        const confluence = this.#computeConfluence(timeframes);
        const liquidity = this.#extractLiquidity(timeframes, htfAnchors);
        const regime = this.#deriveRegime(timeframes);

        const snapshot = {
            pair: this.pair,
            timestamp,
            timeframes,
            htfAnchors,
            orderbook,
            confluence,
            liquidity,
            regime,
            position: context.position || null,
            risk: context.risk || null
        };

        this.lastComputed = snapshot;
        return snapshot;
    }

    async #computeTimeframeFeatures(name, config) {
        const { interval, lookback } = config;
        const candles = await this.data.historical(this.pair, interval, lookback);
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error(`No candles for ${name}`);
        }
        const last = candles[candles.length - 1];
        const closes = candles.map((candle) => safeNumber(candle.c));
        const highs = candles.map((candle) => safeNumber(candle.h));
        const lows = candles.map((candle) => safeNumber(candle.l));
        const volumes = candles.map((candle) => safeNumber(candle.v));
        const typicals = candles.map((candle) => (safeNumber(candle.h) + safeNumber(candle.l) + safeNumber(candle.c)) / 3);

        const sma20 = Indicators.simpleMovingAverage(closes, 20);
        const sma50 = Indicators.simpleMovingAverage(closes, 50);
        const sma200 = Indicators.simpleMovingAverage(closes, 200);
        const priceZ20 = toZScore(closes[closes.length - 1], Indicators.takeLast(closes, 20));

        const vwWindow = Indicators.takeLast(typicals, 20);
        const volWindow = Indicators.takeLast(volumes, 20);
        const weightedSum = vwWindow.reduce((acc, value, idx) => acc + (value * (volWindow[idx] || 0)), 0);
        const totalVolume = sumSafe(volWindow);
        const vwap20 = totalVolume > 0 ? weightedSum / totalVolume : typicals[typicals.length - 1];
        const vwapZ = toZScore(closes[closes.length - 1], vwWindow);

        const atrSeries = Indicators.atrSeries(highs, lows, closes, 14);
        const atr = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : null;
        const atrPercentile = Indicators.percentileRank(atr, Indicators.takeLast(atrSeries, 90));
        const atrPct = Number.isFinite(atr) && atr > 0 ? atr / closes[closes.length - 1] : null;

        const trSeries = computeTrueRangeSeries(candles);
        const rangeRatio = calcRangeCompression(trSeries);

        const rsiSeries = Indicators.rsiSeries(closes, 14);
        const rsiValue = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : null;
        const rsiPrev = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : null;
        const rsiSlope = (Number.isFinite(rsiValue) && Number.isFinite(rsiPrev)) ? rsiValue - rsiPrev : null;

        const { macd: macdValue, signal: macdSignal, histogram, previousHistogram } = Indicators.macd(closes);
        const histSlope = (Number.isFinite(histogram) && Number.isFinite(previousHistogram))
            ? histogram - previousHistogram
            : null;

        const volumeZ20 = toZScore(volumes[volumes.length - 1], volWindow);
        const obvDir = Indicators.obvDirection(closes, volumes, 8);

        const { upper: wickUpperPct, lower: wickLowerPct } = wickPercentages(last);
        const swings = swingDistances(candles, atr || 1);

        const maStack = this.#deriveMaStack(sma20, sma50, sma200);
        const flags = this.#detectFlags(candles, atr);

        const recent = candles.slice(-3).map((candle) => ({
            t: candle.t,
            o: candle.o,
            h: candle.h,
            l: candle.l,
            c: candle.c,
            v: candle.v
        }));

        return {
            interval,
            close: closes[closes.length - 1],
            open: safeNumber(last.o),
            high: safeNumber(last.h),
            low: safeNumber(last.l),
            volume: volumes[volumes.length - 1],
            sma20,
            sma50,
            sma200,
            maStack,
            priceZ20,
            vwap: vwap20,
            vwapZ,
            atr,
            atrPct,
            atrPercentile,
            rangeRatio,
            rsi: rsiValue,
            rsiSlope,
            macd: macdValue,
            macdSignal,
            macdHistogram: histogram,
            macdSlope: histSlope,
            volumeZScore: volumeZ20,
            obvDirection: obvDir,
            swing: {
                toLastHighAtr: swings.toLastHighAtr,
                toLastLowAtr: swings.toLastLowAtr,
                upperWickPct: wickUpperPct,
                lowerWickPct: wickLowerPct
            },
            flags,
            recent,
            atrSeries: atrSeries.length > 10 ? atrSeries.slice(-10) : atrSeries
        };
    }

    async #computeAnchors(tf15m, tf1d, tf4h) {
        try {
            const dailyCandles = await this.data.historical(this.pair, 1440, 5);
            const weeklyCandles = await this.data.historical(this.pair, 10080, 5);

            const prevDay = dailyCandles.length >= 2 ? dailyCandles[dailyCandles.length - 2] : null;
            const latestDay = dailyCandles[dailyCandles.length - 1] || null;
            const prevWeek = weeklyCandles.length >= 2 ? weeklyCandles[weeklyCandles.length - 2] : null;

            const close = tf15m?.close || latestDay?.c || null;
            const atrDailySeries = Indicators.atrSeries(
                dailyCandles.map((c) => safeNumber(c.h)),
                dailyCandles.map((c) => safeNumber(c.l)),
                dailyCandles.map((c) => safeNumber(c.c)),
                14
            );
            const atrDaily = atrDailySeries.length > 0 ? atrDailySeries[atrDailySeries.length - 1] : null;

            return {
                prevDayHigh: prevDay?.h ?? null,
                prevDayLow: prevDay?.l ?? null,
                prevWeekHigh: prevWeek?.h ?? null,
                prevWeekLow: prevWeek?.l ?? null,
                dailyOpen: latestDay?.o ?? null,
                distanceToPrevDayHighAtr: this.#distanceInAtr(close, prevDay?.h, atrDaily),
                distanceToPrevDayLowAtr: this.#distanceInAtr(close, prevDay?.l, atrDaily),
                distanceToPrevWeekHighAtr: this.#distanceInAtr(close, prevWeek?.h, atrDaily),
                distanceToPrevWeekLowAtr: this.#distanceInAtr(close, prevWeek?.l, atrDaily)
            };
        } catch (error) {
            this.logger.warn(`[FeatureBuilder] Failed to compute anchors: ${error.message}`);
            return {};
        }
    }

    #distanceInAtr(price, level, atr) {
        if (!Number.isFinite(price) || !Number.isFinite(level) || !Number.isFinite(atr) || atr === 0) {
            return null;
        }
        return (price - level) / atr;
    }

    #computeOrderBookFeatures(referenceTf) {
        if (!this.orderBookSnapshot) {
            return {
                imbalance: null,
                spreadBps: null,
                slippageBpsForSize: null,
                topBid: null,
                topAsk: null
            };
        }

        const bids = Array.isArray(this.orderBookSnapshot.buy) ? this.orderBookSnapshot.buy : [];
        const asks = Array.isArray(this.orderBookSnapshot.sell) ? this.orderBookSnapshot.sell : [];

        const topBid = bids.length > 0 ? safeNumber(bids[0].price) : null;
        const topAsk = asks.length > 0 ? safeNumber(asks[0].price) : null;

        const depthBid = bids.reduce((acc, level) => acc + safeNumber(level.qty), 0);
        const depthAsk = asks.reduce((acc, level) => acc + safeNumber(level.qty), 0);
        const totalDepth = depthBid + depthAsk;
        const imbalance = totalDepth > 0 ? (depthBid - depthAsk) / totalDepth : null;

        const spreadBps = (Number.isFinite(topBid) && Number.isFinite(topAsk) && topAsk > 0)
            ? ((topAsk - topBid) / ((topAsk + topBid) / 2)) * 10_000
            : null;

        const priceReference = Number.isFinite(referenceTf?.close) ? referenceTf.close : (topBid && topAsk ? (topBid + topAsk) / 2 : null);
        const slippage = this.#estimateSlippage(bids, asks, priceReference);

        return {
            imbalance,
            spreadBps,
            slippageBpsForSize: slippage,
            topBid,
            topAsk
        };
    }

    #estimateSlippage(bids, asks, referencePrice) {
        if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
            return null;
        }
        const targetNotional = this.slippageNotional;
        const mid = referencePrice;

        const calcSide = (levels, direction) => {
            let remaining = targetNotional;
            let priceAccumulator = 0;
            let quantityAccumulator = 0;
            for (const level of levels) {
                const price = safeNumber(level.price);
                const qty = safeNumber(level.qty);
                if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) {
                    continue;
                }
                const tradeValue = price * qty;
                if (tradeValue >= remaining) {
                    const partialQty = remaining / price;
                    priceAccumulator += price * partialQty;
                    quantityAccumulator += partialQty;
                    remaining = 0;
                    break;
                }
                priceAccumulator += price * qty;
                quantityAccumulator += qty;
                remaining -= tradeValue;
            }
            if (remaining > 0 || quantityAccumulator === 0) {
                return null;
            }
            const avgPrice = priceAccumulator / quantityAccumulator;
            const bps = (avgPrice - mid) / mid * 10_000 * direction;
            return bps;
        };

        const buySlippage = calcSide(asks, 1);
        const sellSlippage = calcSide(bids, -1);

        if (buySlippage === null || sellSlippage === null) {
            return buySlippage ?? sellSlippage;
        }
        return (Math.abs(buySlippage) + Math.abs(sellSlippage)) / 2;
    }

    #computeConfluence(timeframes) {
        let score = 0;
        const components = [];
        const tf5 = timeframes['5m'];
        const tf15 = timeframes['15m'];
        const tf1h = timeframes['1h'];

        if (tf15) {
            if (tf15.maStack === 'bull') {
                score += 2;
                components.push('TrendBull(15m)');
            } else if (tf15.maStack === 'bear') {
                score -= 2;
                components.push('TrendBear(15m)');
            }
            if (Number.isFinite(tf15.macdHistogram) && tf15.macdHistogram > 0) {
                score += 1;
                components.push('MACD>0(15m)');
            }
            if (Number.isFinite(tf15.rsi) && tf15.rsi > 55) {
                score += 1;
                components.push('RSI>55(15m)');
            } else if (Number.isFinite(tf15.rsi) && tf15.rsi < 45) {
                score -= 1;
                components.push('RSI<45(15m)');
            }
        }

        if (tf5) {
            if (Number.isFinite(tf5.priceZ20) && tf5.priceZ20 > 1.2) {
                score += 1;
                components.push('PriceZ>1(5m)');
            } else if (Number.isFinite(tf5.priceZ20) && tf5.priceZ20 < -1.2) {
                score -= 1;
                components.push('PriceZ<-1(5m)');
            }
            if (Number.isFinite(tf5.volumeZScore) && tf5.volumeZScore > 1.5) {
                score += 1;
                components.push('VolumeSpike(5m)');
            }
        }

        if (tf1h) {
            if (tf1h.maStack === 'bull') {
                score += 1;
                components.push('TrendBull(1h)');
            } else if (tf1h.maStack === 'bear') {
                score -= 1;
                components.push('TrendBear(1h)');
            }
        }

        return { score, components };
    }

    #extractLiquidity(timeframes, anchors) {
        const tf15 = timeframes['15m'];
        if (!tf15) {
            return {};
        }
        const close = tf15.close;
        const atr = tf15.atr || 1;
        const priorHigh = anchors?.prevDayHigh;
        const priorLow = anchors?.prevDayLow;

        const sweepLow = Number.isFinite(priorLow)
            && Number.isFinite(tf15.low)
            && tf15.low < (priorLow - 0.6 * atr)
            && tf15.close > priorLow;

        const sweepHigh = Number.isFinite(priorHigh)
            && Number.isFinite(tf15.high)
            && tf15.high > (priorHigh + 0.6 * atr)
            && tf15.close < priorHigh;

        const breakAndHoldHigh = Number.isFinite(priorHigh)
            && Number.isFinite(close)
            && close > (priorHigh + 0.3 * atr);

        const breakAndHoldLow = Number.isFinite(priorLow)
            && Number.isFinite(close)
            && close < (priorLow - 0.3 * atr);

        return {
            sweepLow,
            sweepHigh,
            breakAndHoldHigh,
            breakAndHoldLow
        };
    }

    #deriveRegime(timeframes) {
        const tf15 = timeframes['15m'];
        const tf1h = timeframes['1h'];
        const tf5 = timeframes['5m'];

        const trend = this.#determineTrend(tf15, tf1h);
        const volatility = this.#determineVolatility(tf15);
        const momentum = this.#determineMomentum(tf5, tf15);

        return { trend, volatility, momentum };
    }

    #determineTrend(tf15, tf1h) {
        const states = [];
        if (tf15?.maStack) {
            states.push(tf15.maStack);
        }
        if (tf1h?.maStack) {
            states.push(tf1h.maStack);
        }
        if (states.includes('bull') && !states.includes('bear')) {
            return 'bull';
        }
        if (states.includes('bear') && !states.includes('bull')) {
            return 'bear';
        }
        return 'neutral';
    }

    #determineVolatility(tf15) {
        const percentile = tf15?.atrPercentile;
        if (!Number.isFinite(percentile)) {
            return 'unknown';
        }
        if (percentile >= 70) {
            return 'high';
        }
        if (percentile <= 30) {
            return 'low';
        }
        return 'normal';
    }

    #determineMomentum(tf5, tf15) {
        const bullish = [];
        if (Number.isFinite(tf5?.macdHistogram) && tf5.macdHistogram > 0) {
            bullish.push(true);
        }
        if (Number.isFinite(tf15?.macdHistogram) && tf15.macdHistogram > 0) {
            bullish.push(true);
        }
        if (bullish.length === 0) {
            return 'neutral';
        }
        return bullish.every(Boolean) ? 'positive' : 'mixed';
    }

    #deriveMaStack(sma20, sma50, sma200) {
        if ([sma20, sma50, sma200].every(Number.isFinite)) {
            if (sma20 > sma50 && sma50 > sma200) {
                return 'bull';
            }
            if (sma20 < sma50 && sma50 < sma200) {
                return 'bear';
            }
        }
        if (Number.isFinite(sma20) && Number.isFinite(sma50)) {
            if (sma20 > sma50) {
                return 'bull';
            }
            if (sma20 < sma50) {
                return 'bear';
            }
        }
        return 'neutral';
    }

    #detectFlags(candles, atr) {
        const flags = {
            liquiditySweep: false,
            breakout: false
        };
        if (!Array.isArray(candles) || candles.length < 3 || !Number.isFinite(atr) || atr <= 0) {
            return flags;
        }
        const recent = candles.slice(-3);
        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];
        const range = safeNumber(last.h) - safeNumber(last.l);
        const prevRange = safeNumber(prev.h) - safeNumber(prev.l);
        if (Number.isFinite(range) && Number.isFinite(prevRange) && range > 0.6 * atr && prevRange < 0.4 * atr) {
            flags.breakout = true;
        }
        if (Number.isFinite(last.h) && Number.isFinite(prev.h) && Number.isFinite(last.l) && Number.isFinite(prev.l)) {
            const sweepHigh = last.h > prev.h + (0.5 * atr) && last.c < prev.h;
            const sweepLow = last.l < prev.l - (0.5 * atr) && last.c > prev.l;
            flags.liquiditySweep = sweepHigh || sweepLow;
        }
        return flags;
    }
}

function sumSafe(values) {
    return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

module.exports = FeatureBuilder;
