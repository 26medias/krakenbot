class ExecutionEngine {
    constructor(options = {}) {
        const {
            bot,
            logger,
            risk = {}
        } = options || {};

        if (!bot) {
            throw new Error('ExecutionEngine requires a bot instance');
        }

        this.bot = bot;
        this.logger = logger || console;
        this.statusLogger = options.statusLogger || null;
        this.riskConfig = {
            maxTradeRiskPct: risk.maxTradeRiskPct ?? 0.75,
            maxTotalRiskPct: risk.maxTotalRiskPct ?? 1.5,
            defaultSizePct: risk.defaultSizePct ?? 25,
            minNotional: risk.minNotional ?? 20,
            pauseAfterLosses: risk.pauseAfterLosses ?? 2,
            pauseMinutes: risk.pauseMinutes ?? 30
        };

        this.position = {
            side: 'FLAT',
            size: 0,
            averagePrice: 0,
            openedAt: null,
            unrealizedR: 0,
            barsOpen5m: 0
        };
        this.realizedPnlQuote = 0;
        this.dailyStartingBalance = null;
        this.dailyPnlPct = 0;
        this.lossCountWindow = [];
        this.pauseUntil = 0;
        this.lastBalances = null;
        this.lastBalanceTs = 0;
        this.lastLoggedBalances = null;
        this.balanceLogEpsilon = risk.balanceLogEpsilon ?? 1e-8;
    }

    isPaused() {
        return Date.now() < this.pauseUntil;
    }

    getPosition() {
        return { ...this.position };
    }

    getRiskState() {
        return {
            dailyPnlPct: this.dailyPnlPct,
            riskMode: this.isPaused() ? 'paused' : 'normal',
            unrealizedR: this.position.unrealizedR,
            positionAgeBars5m: this.position.barsOpen5m
        };
    }

    updateMarketContext(features) {
        if (!features) {
            return;
        }
        const now = features.timestamp || Date.now();
        if (this.position.side === 'FLAT' || !this.position.openedAt) {
            this.position.unrealizedR = 0;
            this.position.barsOpen5m = 0;
            return;
        }
        const tf5 = features.timeframes?.['5m'];
        if (tf5) {
            const price = tf5.close;
            const atr = tf5.atr || 1;
            if (Number.isFinite(price) && Number.isFinite(atr) && atr > 0 && Number.isFinite(this.position.averagePrice)) {
                const move = price - this.position.averagePrice;
                this.position.unrealizedR = move / atr;
            }
        }
        if (this.position.openedAt) {
            const elapsedMs = Math.max(0, now - this.position.openedAt);
            this.position.barsOpen5m = Math.floor(elapsedMs / (5 * 60_000));
        }
    }

    async execute(decision, context = {}) {
        if (!decision || typeof decision !== 'object') {
            return { status: 'ignored', reason: 'Invalid decision payload' };
        }

        if (decision.action === 'HOLD' || !decision.action) {
            this.logger.debug && this.logger.debug('[Execution] HOLD / no-op');
            return { status: 'noop', action: 'HOLD' };
        }

        if (this.isPaused() && decision.action !== 'PAUSE') {
            this.logger.warn('[Execution] Bot paused, ignoring action');
            return { status: 'paused', until: new Date(this.pauseUntil).toISOString() };
        }

        switch (decision.action) {
            case 'OPEN_LONG':
                return this.#openLong(decision, context);
            case 'ADD':
                return this.#openLong(decision, context, { additive: true });
            case 'TRIM':
            case 'CLOSE_PARTIAL':
                return this.#trimPosition(decision, context);
            case 'CLOSE_ALL':
                return this.#closeAll(context);
            case 'MOVE_STOP':
                return this.#logInstruction('MOVE_STOP', decision);
            case 'SET_TP':
                return this.#logInstruction('SET_TP', decision);
            case 'PAUSE':
                return this.#pause(decision);
            default:
                this.logger.warn(`[Execution] Unsupported action ${decision.action}`);
                return { status: 'ignored', reason: `Unsupported action ${decision.action}` };
        }
    }

    handleFill(fill) {
        if (!fill) {
            return;
        }
        const side = typeof fill.side === 'string' ? fill.side.toLowerCase() : null;
        const quantity = Number(fill.exec_qty ?? fill.quantity ?? fill.vol_exec ?? fill.volume ?? 0);
        const price = Number(fill.exec_price ?? fill.price ?? fill.cost ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
            return;
        }
        if (side === 'buy') {
            this.#applyFill('buy', quantity, price);
        } else if (side === 'sell') {
            this.#applyFill('sell', quantity, price);
        }
    }

    async ensureBalanceSnapshot(force = false) {
        if (force) {
            this.lastBalanceTs = 0;
        }
        return this.#loadBalances(force);
    }

    getLastBalances() {
        if (!this.lastBalances) {
            return null;
        }
        return { ...this.lastBalances };
    }

    getLastBalances() {
        if (!this.lastBalances) {
            return null;
        }
        return { ...this.lastBalances };
    }

    async #openLong(decision, context, options = {}) {
        const ticker = await this.#ensureTicker(context.features);
        if (!ticker) {
            return { status: 'error', reason: 'Ticker unavailable' };
        }

        const sizePct = Number.isFinite(Number(decision.size_pct))
            ? Number(decision.size_pct)
            : this.riskConfig.defaultSizePct;

        if (sizePct <= 0) {
            return { status: 'ignored', reason: 'size_pct <= 0' };
        }

        const entryPrice = this.#deriveEntryPrice(ticker.lastTrade, decision.entry);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            return { status: 'error', reason: 'Invalid entry price' };
        }

        const notional = await this.#computeNotional(sizePct);
        if (!Number.isFinite(notional) || notional < this.riskConfig.minNotional) {
            return { status: 'error', reason: 'Notional below minimum' };
        }

        const quantity = notional / entryPrice;
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return { status: 'error', reason: 'Invalid quantity' };
        }

        let response;
        if (decision.entry?.type === 'limit') {
            response = await this.bot.limitBuy(
                entryPrice,
                quantity,
                { timeinforce: 'GTC' }
            );
        } else {
            response = await this.bot.marketBuy(quantity);
        }

        if (response && response.dryRun) {
            this.logger.info('[Execution] Dry-run open long', { entryPrice, quantity, notional });
            this.#applyFill('buy', quantity, entryPrice, { assumeFill: true });
            return { status: 'dry-run', action: 'OPEN_LONG', details: response.payload };
        }

        this.logger.info('[Execution] Submitted OPEN_LONG', {
            entryPrice,
            quantity,
            notional,
            response
        });
        if (!options.additive) {
            this.#applyFill('buy', quantity, entryPrice, { assumeFill: true });
        }
        return { status: 'submitted', action: 'OPEN_LONG', response };
    }

    async #trimPosition(decision, context) {
        if (this.position.side !== 'LONG' || this.position.size <= 0) {
            return { status: 'ignored', reason: 'No long position to trim' };
        }
        const sizePct = Number.isFinite(Number(decision.size_pct)) ? Number(decision.size_pct) : 50;
        if (sizePct <= 0) {
            return { status: 'ignored', reason: 'size_pct <= 0' };
        }
        const quantity = this.position.size * (sizePct / 100);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return { status: 'ignored', reason: 'Computed quantity <= 0' };
        }
        const ticker = await this.#ensureTicker(context.features);
        if (!ticker) {
            return { status: 'error', reason: 'Ticker unavailable' };
        }
        const response = await this.bot.marketSell(quantity);
        if (response && response.dryRun) {
            this.logger.info('[Execution] Dry-run trim', { quantity });
            this.#applyFill('sell', quantity, ticker.lastTrade, { assumeFill: true });
            return { status: 'dry-run', action: 'TRIM', details: response.payload };
        }
        this.logger.info('[Execution] Submitted TRIM', { quantity, response });
        this.#applyFill('sell', quantity, ticker.lastTrade, { assumeFill: true });
        return { status: 'submitted', action: 'TRIM', response };
    }

    async #closeAll(context) {
        if (this.position.side !== 'LONG' || this.position.size <= 0) {
            return { status: 'ignored', reason: 'No position to close' };
        }
        const ticker = await this.#ensureTicker(context.features);
        if (!ticker) {
            return { status: 'error', reason: 'Ticker unavailable' };
        }
        const quantity = this.position.size;
        const response = await this.bot.marketSell(quantity);
        if (response && response.dryRun) {
            this.logger.info('[Execution] Dry-run close all', { quantity });
            this.#applyFill('sell', quantity, ticker.lastTrade, { assumeFill: true });
            return { status: 'dry-run', action: 'CLOSE_ALL', details: response.payload };
        }
        this.logger.info('[Execution] Submitted CLOSE_ALL', { quantity, response });
        this.#applyFill('sell', quantity, ticker.lastTrade, { assumeFill: true });
        return { status: 'submitted', action: 'CLOSE_ALL', response };
    }

    #logInstruction(action, decision) {
        this.logger.info(`[Execution] Instruction ${action}`, decision);
        return { status: 'instruction', action, decision };
    }

    #pause(decision) {
        const minutes = Number.isFinite(Number(decision.minutes))
            ? Number(decision.minutes)
            : this.riskConfig.pauseMinutes;
        const durationMs = Math.max(minutes, 1) * 60_000;
        this.pauseUntil = Date.now() + durationMs;
        this.logger.warn(`[Execution] Pausing bot for ${minutes} minutes`);
        return { status: 'paused', until: new Date(this.pauseUntil).toISOString() };
    }

    #deriveEntryPrice(lastPrice, entry) {
        if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
            return null;
        }
        if (!entry || entry.type !== 'limit') {
            return lastPrice;
        }
        const offset = Number(entry.offset_bps);
        if (!Number.isFinite(offset)) {
            return lastPrice;
        }
        const adjusted = lastPrice * (1 + (offset / 10_000));
        if (adjusted <= 0) {
            return lastPrice;
        }
        return this.bot.applyPricePrecision(adjusted);
    }

    async #computeNotional(sizePct) {
        const balances = await this.#loadBalances();
        const quoteBalance = balances.quote;
        if (!Number.isFinite(quoteBalance) || quoteBalance <= 0) {
            return null;
        }
        const tradeCap = quoteBalance * (this.riskConfig.maxTradeRiskPct / 100);
        const desired = quoteBalance * (sizePct / 100);
        return Math.min(tradeCap, desired);
    }

    async #ensureTicker(features) {
        if (features?.timeframes?.['5m']?.close) {
            const close = features.timeframes['5m'].close;
            return {
                lastTrade: close
            };
        }
        try {
            const ticker = await this.bot.fetchTicker();
            return ticker;
        } catch (error) {
            this.logger.warn(`[Execution] Failed to fetch ticker: ${error.message}`);
            return null;
        }
    }

    async #loadBalances(force = false) {
        const now = Date.now();
        const cacheDuration = 30_000;
        if (!force && this.lastBalances && (now - this.lastBalanceTs) < cacheDuration) {
            return this.lastBalances;
        }
        try {
            const balances = await this.bot.fetchBalances();
            const quoteKey = Object.keys(balances).find((key) => key.toUpperCase().includes(this.bot.quoteAsset));
            const baseKey = Object.keys(balances).find((key) => key.toUpperCase().includes(this.bot.baseAsset));
            const quote = quoteKey ? Number(balances[quoteKey]) : 0;
            const base = baseKey ? Number(balances[baseKey]) : 0;
            const parsed = {
                raw: balances,
                quote: Number.isFinite(quote) ? quote : 0,
                base: Number.isFinite(base) ? base : 0
            };
            const previous = this.lastBalances;
            if (!this.dailyStartingBalance) {
                this.dailyStartingBalance = parsed.quote;
            }
            this.lastBalances = parsed;
            this.lastBalanceTs = now;
            this.#maybeLogBalanceChange(previous, parsed);
            return parsed;
        } catch (error) {
            this.logger.warn(`[Execution] Failed to load balances: ${error.message}`);
            return this.lastBalances || { quote: 0, base: 0, raw: {} };
        }
    }

    #applyFill(side, quantity, price, options = {}) {
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
            return;
        }
        const value = quantity * price;

        if (side === 'buy') {
            const newSize = this.position.size + quantity;
            const newAverage = (this.position.averagePrice * this.position.size + value) / newSize;
            this.position.size = newSize;
            this.position.averagePrice = newAverage;
            this.position.side = 'LONG';
            if (!options.assumeFill) {
                this.lastBalanceTs = 0;
            }
            if (!this.position.openedAt) {
                this.position.openedAt = Date.now();
            }
        } else if (side === 'sell') {
            const remaining = Math.max(0, this.position.size - quantity);
            const realized = (price - this.position.averagePrice) * Math.min(quantity, this.position.size);
            this.realizedPnlQuote += realized;
            this.position.size = remaining;
            if (remaining === 0) {
                this.position.side = 'FLAT';
                this.position.averagePrice = 0;
                this.position.openedAt = null;
                this.position.unrealizedR = 0;
                this.position.barsOpen5m = 0;
            }
            this.lossCountWindow.push(realized < 0);
            this.lossCountWindow = this.lossCountWindow.slice(-5);
            this.#maybeApplyPause();
        }
        this.#recalculateDailyPnL();
    }

    #maybeApplyPause() {
        const losses = this.lossCountWindow.filter(Boolean).length;
        if (losses >= this.riskConfig.pauseAfterLosses) {
            this.pauseUntil = Date.now() + this.riskConfig.pauseMinutes * 60_000;
            this.logger.warn('[Execution] Loss streak detected, entering cooldown');
            this.lossCountWindow = [];
        }
    }

    #maybeLogBalanceChange(previous, current) {
        if (!current) {
            return;
        }
        if (!previous) {
            this.logger.info('[Execution] Balances initialised', {
                quote: current.quote,
                base: current.base
            });
            this.lastLoggedBalances = { ...current };
            this.statusLogger?.reportStatus({
                source: 'balance',
                balances: current
            });
            return;
        }
        const quoteDelta = Math.abs((current.quote ?? 0) - (previous.quote ?? 0));
        const baseDelta = Math.abs((current.base ?? 0) - (previous.base ?? 0));
        if (
            quoteDelta > this.balanceLogEpsilon ||
            baseDelta > this.balanceLogEpsilon
        ) {
            this.logger.info('[Execution] Balances updated', {
                quote: current.quote,
                base: current.base
            });
            this.lastLoggedBalances = { ...current };
            this.statusLogger?.reportStatus({
                source: 'balance',
                balances: current
            });
        }
    }

    #recalculateDailyPnL() {
        if (!this.dailyStartingBalance) {
            return;
        }
        const current = this.dailyStartingBalance + this.realizedPnlQuote;
        if (this.dailyStartingBalance > 0) {
            this.dailyPnlPct = ((current - this.dailyStartingBalance) / this.dailyStartingBalance) * 100;
        }
    }
}

module.exports = ExecutionEngine;
