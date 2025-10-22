/**
 * Lightweight indicator helpers for quick feature engineering.
 * All helpers operate on plain arrays of numbers and guard against
 * insufficient data by returning null.
 */

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function takeLast(values, count) {
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }
    if (values.length <= count) {
        return [...values];
    }
    return values.slice(values.length - count);
}

function sum(values) {
    return values.reduce((acc, value) => acc + value, 0);
}

function average(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    return sum(values) / values.length;
}

function simpleMovingAverage(values, period) {
    if (!Array.isArray(values) || values.length < period || period <= 0) {
        return null;
    }
    const window = takeLast(values, period);
    return average(window);
}

function simpleMovingAverageSeries(values, period) {
    if (!Array.isArray(values) || values.length === 0 || period <= 0) {
        return [];
    }
    const result = [];
    let runningSum = 0;
    for (let i = 0; i < values.length; i += 1) {
        runningSum += values[i];
        if (i >= period) {
            runningSum -= values[i - period];
        }
        if (i >= period - 1) {
            result.push(runningSum / period);
        } else {
            result.push(null);
        }
    }
    return result;
}

function exponentialMovingAverageSeries(values, period) {
    if (!Array.isArray(values) || values.length === 0 || period <= 0) {
        return [];
    }
    const k = 2 / (period + 1);
    const result = [];
    let ema = values[0];
    result.push(ema);
    for (let i = 1; i < values.length; i += 1) {
        ema = values[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

function exponentialMovingAverage(values, period) {
    const series = exponentialMovingAverageSeries(values, period);
    return series.length === 0 ? null : series[series.length - 1];
}

function standardDeviation(values, period) {
    if (!Array.isArray(values) || values.length < period || period <= 1) {
        return null;
    }
    const window = takeLast(values, period);
    const mean = average(window);
    const variance = window.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / window.length;
    return Math.sqrt(variance);
}

function median(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function trueRange(high, low, prevClose) {
    const highLow = high - low;
    const highClose = Math.abs(high - prevClose);
    const lowClose = Math.abs(low - prevClose);
    return Math.max(highLow, highClose, lowClose);
}

function atrSeries(highs, lows, closes, period) {
    if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) {
        return [];
    }
    if (highs.length !== lows.length || highs.length !== closes.length) {
        return [];
    }
    if (highs.length < period + 1) {
        return [];
    }
    const trs = [];
    for (let i = 1; i < highs.length; i += 1) {
        trs.push(trueRange(highs[i], lows[i], closes[i - 1]));
    }
    const atrValues = [];
    let atr = average(trs.slice(0, period));
    if (!isFiniteNumber(atr)) {
        return [];
    }
    atrValues.push(atr);
    const smoothing = (period - 1);
    for (let i = period; i < trs.length; i += 1) {
        atr = (atr * smoothing + trs[i]) / period;
        atrValues.push(atr);
    }
    // Align length with input arrays by padding front with nulls
    const padding = Array.from({ length: highs.length - atrValues.length - 1 }, () => null);
    return [...padding, ...atrValues];
}

function averageTrueRange(highs, lows, closes, period) {
    const series = atrSeries(highs, lows, closes, period);
    return series.length === 0 ? null : series[series.length - 1];
}

function rsiSeries(closes, period) {
    if (!Array.isArray(closes) || closes.length < period + 1) {
        return [];
    }
    const gains = [];
    const losses = [];
    for (let i = 1; i < closes.length; i += 1) {
        const delta = closes[i] - closes[i - 1];
        gains.push(Math.max(delta, 0));
        losses.push(Math.max(-delta, 0));
    }
    let avgGain = average(gains.slice(0, period));
    let avgLoss = average(losses.slice(0, period));
    const rsis = Array.from({ length: period }, () => null);
    if (!isFiniteNumber(avgGain) || !isFiniteNumber(avgLoss)) {
        return rsis;
    }
    const firstRS = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    rsis.push(firstRS);
    for (let i = period; i < gains.length; i += 1) {
        avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
        avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
        if (avgLoss === 0) {
            rsis.push(100);
        } else {
            const rs = avgGain / avgLoss;
            rsis.push(100 - (100 / (1 + rs)));
        }
    }
    return rsis;
}

function rsi(closes, period) {
    const series = rsiSeries(closes, period);
    return series.length === 0 ? null : series[series.length - 1];
}

function macdSeries(closes, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
    if (!Array.isArray(closes) || closes.length === 0) {
        return { macd: [], signal: [], histogram: [] };
    }
    const shortEma = exponentialMovingAverageSeries(closes, shortPeriod);
    const longEma = exponentialMovingAverageSeries(closes, longPeriod);
    const macdLine = shortEma.map((value, index) => {
        if (!isFiniteNumber(value) || !isFiniteNumber(longEma[index])) {
            return null;
        }
        return value - longEma[index];
    });
    const validMacd = macdLine.map((value) => (value === null ? 0 : value));
    const signalLine = exponentialMovingAverageSeries(validMacd, signalPeriod);
    const histogram = macdLine.map((value, index) => {
        if (!isFiniteNumber(value) || !isFiniteNumber(signalLine[index])) {
            return null;
        }
        return value - signalLine[index];
    });
    return {
        macd: macdLine,
        signal: signalLine,
        histogram
    };
}

function macd(closes, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
    const { macd: macdLine, signal, histogram } = macdSeries(closes, shortPeriod, longPeriod, signalPeriod);
    if (macdLine.length === 0) {
        return { macd: null, signal: null, histogram: null };
    }
    return {
        macd: macdLine[macdLine.length - 1],
        signal: signal[signal.length - 1],
        histogram: histogram[histogram.length - 1],
        previousHistogram: histogram.length >= 2 ? histogram[histogram.length - 2] : null
    };
}

function obvSeries(closes, volumes) {
    if (!Array.isArray(closes) || !Array.isArray(volumes)) {
        return [];
    }
    if (closes.length !== volumes.length) {
        return [];
    }
    let current = 0;
    const result = [current];
    for (let i = 1; i < closes.length; i += 1) {
        if (closes[i] > closes[i - 1]) {
            current += volumes[i];
        } else if (closes[i] < closes[i - 1]) {
            current -= volumes[i];
        }
        result.push(current);
    }
    return result;
}

function obvDirection(closes, volumes, lookback = 5) {
    const series = obvSeries(closes, volumes);
    if (series.length < lookback + 1) {
        return 0;
    }
    const recent = series.slice(-lookback);
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (last > first) {
        return 1;
    }
    if (last < first) {
        return -1;
    }
    return 0;
}

function percentileRank(value, series) {
    if (!isFiniteNumber(value) || !Array.isArray(series) || series.length === 0) {
        return null;
    }
    const sorted = [...series].filter(isFiniteNumber).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return null;
    }
    const index = sorted.findIndex((item) => item > value);
    if (index === -1) {
        return 100;
    }
    return (index / sorted.length) * 100;
}

function toFixedNumber(value, decimals = 8) {
    if (!isFiniteNumber(value)) {
        return null;
    }
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

module.exports = {
    average,
    averageTrueRange,
    atrSeries,
    exponentialMovingAverage,
    exponentialMovingAverageSeries,
    macd,
    macdSeries,
    median,
    obvDirection,
    obvSeries,
    percentileRank,
    rsi,
    rsiSeries,
    simpleMovingAverage,
    simpleMovingAverageSeries,
    standardDeviation,
    takeLast,
    toFixedNumber,
    trueRange
};
