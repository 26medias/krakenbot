class HelperTA {
    constructor() {}

    // Computes the rolling mean over a specified period.
    rollingMean(data, period) {
        const result = [];
        let windowSum = 0;
        const window = [];
        for (let i = 0; i < data.length; i++) {
            const value = data[i];
            window.push(value);
            windowSum += value;
            if (window.length > period) {
                windowSum -= window.shift();
            }
            // If the window is full and contains no nulls, compute the mean.
            if (window.length === period && window.every((v) => v !== null)) {
                result.push(windowSum / period);
            } else {
                result.push(null);
            }
        }
        return result;
    }

    // Computes the rolling minimum over a specified period.
    rollingMin(data, period) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                const window = data.slice(i - period + 1, i + 1);
                if (window.some((v) => v === null)) {
                    result.push(null);
                } else {
                    result.push(Math.min(...window));
                }
            }
        }
        return result;
    }

    // Computes the rolling maximum over a specified period.
    rollingMax(data, period) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                const window = data.slice(i - period + 1, i + 1);
                if (window.some((v) => v === null)) {
                    result.push(null);
                } else {
                    result.push(Math.max(...window));
                }
            }
        }
        return result;
    }

    // Computes an exponential weighted moving average.
    // Uses the formula: EMA[t] = alpha * data[t] + (1 - alpha) * EMA[t-1]
    ewmMean(data, span) {
        const result = [];
        const alpha = 2 / (span + 1);
        let prev = null;
        for (let i = 0; i < data.length; i++) {
            const value = data[i];
            if (value === null) {
                result.push(null);
                continue;
            }
            if (prev === null) {
                prev = value;
                result.push(prev);
            } else {
                prev = alpha * value + (1 - alpha) * prev;
                result.push(prev);
            }
        }
        return result;
    }

    // Stochastic oscillator: %K = 100 * ((data - rolling_min) / (rolling_max - rolling_min))
    Stochastic(data, period = 14) {
        const low = this.rollingMin(data, period);
        const high = this.rollingMax(data, period);
        const kPercent = [];
        for (let i = 0; i < data.length; i++) {
            if (
                low[i] === null ||
                high[i] === null ||
                high[i] === low[i]
            ) {
                kPercent.push(null);
            } else {
                kPercent.push(100 * ((data[i] - low[i]) / (high[i] - low[i])));
            }
        }
        return kPercent;
    }

    // RSI indicator calculation.
    RSI(data, period = 14) {
        const delta = [null];
        for (let i = 1; i < data.length; i++) {
            delta.push(data[i] - data[i - 1]);
        }
        const up = delta.slice();
        const down = delta.slice();
        for (let i = 0; i < delta.length; i++) {
            if (up[i] === null) {
                up[i] = 0;
                down[i] = 0;
            } else {
                if (up[i] < 0) {
                    up[i] = 0;
                }
                if (down[i] > 0) {
                    down[i] = 0;
                }
                down[i] = Math.abs(down[i]);
            }
        }
        const rollUp = this.ewmMean(up, period);
        const rollDown = this.ewmMean(down, period);
        const RS = [];
        const rsi = [];
        for (let i = 0; i < data.length; i++) {
            if (
                rollDown[i] === 0 ||
                rollDown[i] === null ||
                rollUp[i] === null
            ) {
                RS.push(null);
                rsi.push(null);
            } else {
                RS.push(rollUp[i] / rollDown[i]);
                rsi.push(100.0 - 100.0 / (1.0 + RS[i]));
            }
        }
        return rsi;
    }

    // Calculates the stock RSI indicator.
    stockRSI(data, K = 5, D = 5, rsiPeriod = 20, stochPeriod = 3) {
        const rsi = this.RSI(data, rsiPeriod);
        const stoch = this.Stochastic(rsi, stochPeriod);
        const k = this.rollingMean(stoch, K);
        const d = this.rollingMean(k, D);
        return { k, d };
    }

    // DCO (Donchian Channel Oscillator) calculation.
    DCO(data, donchianPeriod = 20, smaPeriod = 3) {
        const lower = this.rollingMin(data, donchianPeriod);
        const upper = this.rollingMax(data, donchianPeriod);
        const DCO = [];
        for (let i = 0; i < data.length; i++) {
            if (
                lower[i] === null ||
                upper[i] === null ||
                upper[i] === lower[i]
            ) {
                DCO.push(null);
            } else {
                DCO.push(((data[i] - lower[i]) / (upper[i] - lower[i])) * 100);
            }
        }
        const s = this.rollingMean(DCO, smaPeriod);
        return { DCO, s };
    }

    // Combines various indicators to compute an aggregated MarketCycle value.
    MarketCycle(
        donchianPrice,
        rsiPrice,
        srsiPrice,
        donchianPeriod,
        donchianSmoothing,
        rsiPeriod,
        rsiSmoothing,
        srsiPeriod,
        srsiSmoothing,
        srsiK,
        srsiD,
        rsiWeight,
        srsiWeight,
        dcoWeight
    ) {
        const { DCO, s: DCOs } = this.DCO(donchianPrice, donchianPeriod, donchianSmoothing);
        const rsiValue = this.RSI(rsiPrice, rsiPeriod);
        const rsiK = this.rollingMean(rsiValue, rsiSmoothing);
        const { k, d } = this.stockRSI(srsiPrice, srsiK, srsiD, srsiPeriod, srsiSmoothing);
        const aggr = [];
        for (let i = 0; i < donchianPrice.length; i++) {
            if (
                DCO[i] === null ||
                DCOs[i] === null ||
                rsiValue[i] === null ||
                rsiK[i] === null ||
                k[i] === null ||
                d[i] === null
            ) {
                aggr.push(null);
            } else {
                const numerator = ((DCO[i] + DCOs[i]) * dcoWeight +
                    (rsiValue[i] + rsiK[i]) * rsiWeight +
                    (k[i] + d[i]) * srsiWeight);
                const denominator = 2 * (dcoWeight + rsiWeight + srsiWeight);
                aggr.push(numerator / denominator);
            }
        }
        return aggr;
    }
}

class MarketCycle {
    constructor(data) {
        // Expecting data to be an object with a key "Close" containing an array of numbers.
        this.data = data;
        this.hta = new HelperTA();
    }

    mc(a, b) {
        return this.hta.MarketCycle(
            this.data,
            this.data,
            this.data,
            a,    // donchianPeriod
            3,    // donchianSmoothing
            a,    // rsiPeriod
            3,    // rsiSmoothing
            b,    // srsiPeriod
            3,    // srsiSmoothing
            5,    // srsiK
            5,    // srsiD
            0.5,  // rsiWeight
            1,    // srsiWeight
            1     // dcoWeight
        );
    }

    RSI(period = 14) {
        return this.hta.RSI(this.data, period);
    }

    build() {
        // Compute MarketCycle and add shifted values.
        const mcValues = this.mc(14, 20);
        this.data.MarketCycle = mcValues;
        // Create Prev_MarketCycle and Prev2_MarketCycle arrays (shifted by 1 and 2).
        const prev = [null].concat(mcValues.slice(0, mcValues.length - 1));
        const prev2 = [null].concat(prev.slice(0, prev.length - 1));
        this.data.Prev_MarketCycle = prev;
        this.data.Prev2_MarketCycle = prev2;
        return this.data;
    }
}

module.exports = MarketCycle;


/*
// Example usage:
// Suppose you have an object with a 'Close' property which is an array of closing prices.
const data = {
    Close: []
};

const marketCycleCalc = new MarketCycle(data);
const result = marketCycleCalc.build();
console.log(result);
*/