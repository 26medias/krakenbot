class EventEngine {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.verbose = Boolean(options.verbose);
        this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 60_000;
        this.thresholds = {
            volHigh: 70,
            volLow: 30,
            confluenceDelta: 2,
            drawdownGuard: 2,
            positionAgeBars: 36,
            ...options.thresholds
        };

        this.lastBuckets = {
            '5m': null,
            '15m': null,
            '60m': null
        };

        this.lastTrendState = null;
        this.lastVolState = null;
        this.lastConfluence = null;
        this.lastLiquidity = {
            sweepLow: false,
            sweepHigh: false,
            breakAndHoldHigh: false,
            breakAndHoldLow: false
        };
        this.lastDrawdownAlert = null;
        this.pendingReasonSet = new Set();
        this.lastEmitTs = 0;
    }

    shouldEvaluate(priceData = {}, meta = {}) {
        const timestamp = this.#extractTimestamp(priceData);
        const triggers = [];
        let evaluate = false;

        if (this.#updateBucket('5m', timestamp, 5)) {
            evaluate = true;
            triggers.push('5m close');
        }
        if (this.#updateBucket('15m', timestamp, 15)) {
            evaluate = true;
            triggers.push('15m close');
        }
        if (this.#updateBucket('60m', timestamp, 60)) {
            evaluate = true;
            triggers.push('60m close');
        }
        if (meta?.thresholdTriggered) {
            evaluate = true;
            triggers.push('price-change threshold');
        }
        if (this.pendingReasonSet.size > 0 && (timestamp - this.lastEmitTs) >= this.debounceMs) {
            evaluate = true;
            triggers.push('debounce release');
        }

        if (this.verbose) {
            if (evaluate) {
                this.logger.info(`[EventEngine] Evaluation triggered (${triggers.join(', ') || 'unknown'})`);
            } else {
                this.logger.info('[EventEngine] Skipping evaluation (waiting for bar close or triggers)');
            }
        }
        return evaluate;
    }

    detect(snapshot, meta = {}) {
        if (!snapshot || typeof snapshot !== 'object') {
            return [];
        }

        const timestamp = snapshot.timestamp || Date.now();
        const reasons = [];

        this.#evaluateTrend(snapshot, reasons);
        this.#evaluateVolatility(snapshot, reasons);
        this.#evaluateConfluence(snapshot, reasons);
        this.#evaluateLiquidity(snapshot, reasons);
        this.#evaluateRisk(snapshot, reasons);

        if (meta?.thresholdTriggered) {
            reasons.push('MomentumSpike(PriceFeed)');
        }

        if (reasons.length > 0) {
            reasons.forEach((reason) => this.pendingReasonSet.add(reason));
        }

        const emitted = this.#maybeEmit(timestamp);

        if (this.verbose) {
            this.logger.info(
                `[EventEngine] Reasons detected=${reasons.join(', ') || 'none'} | emitted=${emitted.join(', ') || 'none'}`
            );
        }

        return emitted;
    }

    reset() {
        this.lastTrendState = null;
        this.lastVolState = null;
        this.lastConfluence = null;
        this.lastLiquidity = {
            sweepLow: false,
            sweepHigh: false,
            breakAndHoldHigh: false,
            breakAndHoldLow: false
        };
        this.pendingReasonSet.clear();
        this.lastEmitTs = 0;
    }

    #extractTimestamp(priceData = {}) {
        return priceData.channelTimestampUnix
            || priceData.timestampUnix
            || priceData.intervalBeginUnix
            || Date.now();
    }

    #updateBucket(key, timestamp, minutes) {
        if (!Number.isFinite(timestamp)) {
            return false;
        }
        const bucket = Math.floor(timestamp / (minutes * 60_000));
        if (this.lastBuckets[key] === null) {
            this.lastBuckets[key] = bucket;
            return true;
        }
        if (this.lastBuckets[key] !== bucket) {
            this.lastBuckets[key] = bucket;
            return true;
        }
        return false;
    }

    #maybeEmit(timestamp) {
        if (this.pendingReasonSet.size === 0) {
            return [];
        }
        if (!this.lastEmitTs || (timestamp - this.lastEmitTs) >= this.debounceMs) {
            const reasons = Array.from(this.pendingReasonSet);
            this.pendingReasonSet.clear();
            this.lastEmitTs = timestamp;
            return reasons;
        }
        return [];
    }

    #evaluateTrend(snapshot, reasons) {
        const trendState = snapshot?.regime?.trend || null;
        if (!trendState) {
            return;
        }
        if (this.lastTrendState && this.lastTrendState !== trendState) {
            const label = trendState === 'bull' ? 'TrendFlip-Up(15m)' : trendState === 'bear' ? 'TrendFlip-Down(15m)' : 'TrendFlip-Neutral(15m)';
            reasons.push(label);
        }
        this.lastTrendState = trendState;
    }

    #evaluateVolatility(snapshot, reasons) {
        const volState = snapshot?.regime?.volatility || null;
        if (!volState) {
            return;
        }
        if (this.lastVolState && this.lastVolState !== volState) {
            if (volState === 'high') {
                reasons.push('VolatilityRegimeHigh(15m)');
            } else if (volState === 'low') {
                reasons.push('VolatilityRegimeLow(15m)');
            } else {
                reasons.push('VolatilityRegimeNormal(15m)');
            }
        } else if (!this.lastVolState && (volState === 'high' || volState === 'low')) {
            reasons.push(volState === 'high' ? 'VolatilityRegimeHigh(15m)' : 'VolatilityRegimeLow(15m)');
        }
        this.lastVolState = volState;
    }

    #evaluateConfluence(snapshot, reasons) {
        const score = snapshot?.confluence?.score;
        if (!Number.isFinite(score)) {
            return;
        }
        if (Number.isFinite(this.lastConfluence)) {
            const delta = score - this.lastConfluence;
            if (Math.abs(delta) >= this.thresholds.confluenceDelta) {
                reasons.push(`ConfluenceDelta(${this.lastConfluence}→${score})`);
            }
        }
        this.lastConfluence = score;
    }

    #evaluateLiquidity(snapshot, reasons) {
        const liquidity = snapshot?.liquidity || {};
        if (!liquidity) {
            return;
        }

        if (liquidity.sweepLow && !this.lastLiquidity.sweepLow) {
            reasons.push('LiquiditySweep(Low)');
        }
        if (liquidity.sweepHigh && !this.lastLiquidity.sweepHigh) {
            reasons.push('LiquiditySweep(High)');
        }
        if (liquidity.breakAndHoldHigh && !this.lastLiquidity.breakAndHoldHigh) {
            reasons.push('BreakAndHold(High)');
        }
        if (liquidity.breakAndHoldLow && !this.lastLiquidity.breakAndHoldLow) {
            reasons.push('BreakAndHold(Low)');
        }

        this.lastLiquidity = {
            sweepLow: Boolean(liquidity.sweepLow),
            sweepHigh: Boolean(liquidity.sweepHigh),
            breakAndHoldHigh: Boolean(liquidity.breakAndHoldHigh),
            breakAndHoldLow: Boolean(liquidity.breakAndHoldLow)
        };
    }

    #evaluateRisk(snapshot, reasons) {
        const risk = snapshot?.risk;
        if (!risk) {
            return;
        }

        const drawdown = Number.isFinite(risk.dailyPnlPct) ? risk.dailyPnlPct : null;
        if (Number.isFinite(drawdown) && drawdown <= -Math.abs(this.thresholds.drawdownGuard)) {
            const key = `DrawdownGuardrail(${drawdown.toFixed(2)}%)`;
            if (this.lastDrawdownAlert !== key) {
                reasons.push(key);
                this.lastDrawdownAlert = key;
            }
        } else if (Number.isFinite(drawdown) && drawdown > -Math.abs(this.thresholds.drawdownGuard)) {
            this.lastDrawdownAlert = null;
        }

        const positionAge = Number.isFinite(risk.positionAgeBars5m) ? risk.positionAgeBars5m : null;
        const unrealized = Number.isFinite(risk.unrealizedR) ? risk.unrealizedR : null;
        if (Number.isFinite(positionAge) && positionAge >= this.thresholds.positionAgeBars && Math.abs(unrealized ?? 0) < 0.5) {
            reasons.push(`TimeStop(${positionAge}bars)`);
        }
    }
}

module.exports = EventEngine;
