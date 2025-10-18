const Data = require('./Data');
const MarketCycle = require('./MarketCycle');

class DataTools {
    constructor(pair, options = {}) {
        if (!pair) {
            throw new Error('A trading pair (e.g. DOGEUSD) is required to initialise DataTools');
        }

        this.pair = pair;
        this.interval = options.interval || 1; // candle size in minutes
        this.dataClient = options.dataClient || new Data();
    }

    async getprice() {
        return this.dataClient.latest(this.pair);
    }

    async getPriceRange(periodMinutes, options = {}) {
        const ohlc = await this._getHistoricalWindow(periodMinutes, options);
        const highs = ohlc.map((candle) => candle.h);
        const lows = ohlc.map((candle) => candle.l);

        return {
            high: Math.max(...highs),
            low: Math.min(...lows)
        };
    }

    async getVolatilityRange(periodMinutes, windowSize, options = {}) {
        if (!Number.isInteger(windowSize) || windowSize <= 0) {
            throw new Error('windowSize must be a positive integer');
        }

        const ohlc = await this._getHistoricalWindow(periodMinutes, options);
        if (ohlc.length < windowSize) {
            throw new Error('Not enough data to compute volatility range for the requested window size');
        }

        const highs = ohlc.map((candle) => candle.h);
        const lows = ohlc.map((candle) => candle.l);
        const ranges = [];

        for (let i = 0; i <= ohlc.length - windowSize; i += 1) {
            const windowHigh = Math.max(...highs.slice(i, i + windowSize));
            const windowLow = Math.min(...lows.slice(i, i + windowSize));
            ranges.push(windowHigh - windowLow);
        }

        const average = ranges.reduce((acc, value) => acc + value, 0) / ranges.length;
        const variance = ranges.reduce((acc, value) => acc + (value - average) ** 2, 0) / ranges.length;

        return {
            range: average,
            variance
        };
    }

    async getLinearRegression(periodMinutes, options = {}) {
        const ohlc = await this._getHistoricalWindow(periodMinutes, options);
        const closes = ohlc.map((candle) => candle.c);
        const x = closes.map((_, index) => index);

        const meanX = x.reduce((acc, value) => acc + value, 0) / x.length;
        const meanY = closes.reduce((acc, value) => acc + value, 0) / closes.length;

        const numerator = x.reduce((sum, xi, idx) => sum + (xi - meanX) * (closes[idx] - meanY), 0);
        const denominator = x.reduce((sum, xi) => sum + (xi - meanX) ** 2, 0);
        const slope = denominator === 0 ? 0 : numerator / denominator;
        const intercept = meanY - slope * meanX;
        const regressionY = x.map((xi) => intercept + slope * xi);

        return {
            x,
            y: regressionY,
            slope,
            intercept
        };
    }

    async getMarketCycle(periodMinutes, options = {}) {
        const ohlc = await this._getHistoricalWindow(periodMinutes, options);
        const opens = ohlc.map((candle) => candle.o);

        const marketCycle = new MarketCycle(opens);
        return marketCycle.build();
    }

    async _getHistoricalWindow(periodMinutes, options = {}) {
        const interval = options.interval || this.interval;

        if (typeof periodMinutes !== 'number' || !Number.isFinite(periodMinutes) || periodMinutes <= 0) {
            throw new Error('periodMinutes must be a positive number');
        }

        if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
            throw new Error('Candle interval must be a positive number');
        }

        const windowSize = Math.max(1, Math.ceil(periodMinutes / interval));
        const candles = await this.dataClient.historical(this.pair, interval, windowSize);

        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No historical data available for the requested parameters');
        }

        return candles.slice(-windowSize);
    }
}

module.exports = DataTools;


/*
    const tools = new DataTools("DOGEUSD");

    // Get the latest {o, h, l, c, v} price
    const price = await tools.getprice();

    // Get the high & low within 60min time period (in minutes)
    const { high, low } = await tools.getPriceRange(60);

    // Get the average range (high-low) of a 5-candles sliding windows within 60min time period (in minutes), along with the variance
    const { range, variance } = await tools.getVolatilityRange(60, 5);

    // Get linear regression within 60min time period (in minutes)
    const {x, y} = await tools.getLinearRegression(60);

    // Get the market cycle data using open prices & default values
    const marketCycle = await tools.getMarketCycle(60);
*/
