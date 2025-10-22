const { EventEmitter } = require('events');
const Data = require('./libs/Data');
const DataTools = require('./libs/DataTools');
const KrakenMonitor = require('./libs/KrakenMonitor');

const KNOWN_QUOTES = Object.freeze([
    'USDT',
    'USDC',
    'DAI',
    'EUR',
    'USD',
    'GBP',
    'CAD',
    'CHF',
    'JPY',
    'AUD',
    'NZD',
    'BTC',
    'XBT',
    'ETH',
    'SOL',
    'DOT',
    'ADA',
    'TRY',
    'MXN',
    'ZUSD',
    'ZEUR',
    'ZGBP',
    'ZJPY',
    'ZCAD'
]);

const DEFAULT_OPTIONS = Object.freeze({
    pair: 'XBT/USD',
    candleInterval: 1,
    priceInterval: null,
    autoLoadPairInfo: true,
    autoStartPriceFeed: true,
    autoSubscribeOrderFills: false,
    priceChangeThreshold: null,
    priceMonitoringPeriod: 5,
    enforcePrecision: true,
    dryRun: false,
    monitorOptions: {},
    dataClient: null,
    monitor: null,
    logger: null
});

function createLogger(logger) {
    const fallback = {
        info: (...args) => console.log(...args),
        warn: (...args) => console.warn(...args),
        error: (...args) => console.error(...args),
        debug: (...args) => {
            if (process.env.DEBUG) {
                console.debug(...args);
            }
        }
    };

    if (!logger || typeof logger !== 'object') {
        return fallback;
    }

    return {
        info: typeof logger.info === 'function' ? logger.info.bind(logger) : fallback.info,
        warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : fallback.warn,
        error: typeof logger.error === 'function' ? logger.error.bind(logger) : fallback.error,
        debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : fallback.debug
    };
}

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatWithPrecision(value, precision) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid numeric value: ${value}`);
    }
    if (!Number.isInteger(precision) || precision < 0) {
        return numeric.toString();
    }
    const factor = 10 ** precision;
    const rounded = Math.round(numeric * factor) / factor;
    return rounded.toFixed(precision).replace(/\.?0+$/, '');
}

function normalisePair(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('A trading pair string is required, e.g. DOGE/USD');
    }

    let sanitized = input.trim().toUpperCase();
    sanitized = sanitized.replace(/[:\s-]+/g, '/');
    sanitized = sanitized.replace(/\/+/g, '/');

    if (!sanitized.includes('/')) {
        const match = KNOWN_QUOTES.find((quote) => sanitized.endsWith(quote));
        if (match) {
            sanitized = `${sanitized.slice(0, sanitized.length - match.length)}/${match}`;
        } else if (sanitized.length >= 6) {
            sanitized = `${sanitized.slice(0, sanitized.length - 3)}/${sanitized.slice(-3)}`;
        }
    }

    const [base, quote] = sanitized.split('/');
    if (!base || !quote) {
        throw new Error(`Unable to parse trading pair from "${input}"`);
    }

    return {
        wsPair: `${base}/${quote}`,
        restPair: `${base}${quote}`,
        base,
        quote
    };
}

function extractTicker(result, pairInfo, fallbacks = []) {
    if (!result || typeof result !== 'object') {
        return null;
    }

    const entries = Object.entries(result);
    if (entries.length === 0) {
        return null;
    }

    const preferredKeys = [];
    if (pairInfo?.altname) {
        preferredKeys.push(pairInfo.altname.toUpperCase());
    }
    if (pairInfo?.wsname) {
        preferredKeys.push(pairInfo.wsname.toUpperCase());
        preferredKeys.push(pairInfo.wsname.replace('/', '').toUpperCase());
    }

    fallbacks.forEach((key) => {
        if (key) {
            preferredKeys.push(String(key).toUpperCase());
        }
    });

    let match = entries.find(([key]) => preferredKeys.includes(String(key).toUpperCase()));
    if (!match) {
        match = entries[0];
    }

    if (!match) {
        return null;
    }

    const [key, value] = match;
    const parseTuple = (tuple, index = 0) => {
        if (!Array.isArray(tuple) || tuple.length === 0) {
            return 0;
        }
        return safeNumber(tuple[index]);
    };

    return {
        key,
        ask: parseTuple(value.a),
        askWholeLotVolume: parseTuple(value.a, 1),
        askLotVolume: parseTuple(value.a, 2),
        bid: parseTuple(value.b),
        bidWholeLotVolume: parseTuple(value.b, 1),
        bidLotVolume: parseTuple(value.b, 2),
        lastTrade: parseTuple(value.c),
        lastTradeVolume: parseTuple(value.c, 1),
        volumeToday: parseTuple(value.v),
        volume24h: parseTuple(value.v, 1),
        vwapToday: parseTuple(value.p),
        vwap24h: parseTuple(value.p, 1),
        lowToday: parseTuple(value.l),
        low24h: parseTuple(value.l, 1),
        highToday: parseTuple(value.h),
        high24h: parseTuple(value.h, 1),
        open: safeNumber(value.o),
        raw: value
    };
}

function normaliseOpenOrders(response = {}, currentPrice = 0) {
    const open = response.open || {};
    const orders = Object.entries(open).map(([id, order]) => {
        const descr = order?.descr || {};
        const price = safeNumber(descr.price ?? order.price);
        const quantity = safeNumber(order.vol);
        const filled = safeNumber(order.vol_exec);
        const side = descr.type === 'sell' ? 'sell' : 'buy';
        const distancePercent = currentPrice > 0 && price > 0
            ? ((price - currentPrice) / currentPrice) * 100
            : 0;

        return {
            id,
            price,
            quantity,
            filled,
            remaining: Math.max(0, quantity - filled),
            value: price * quantity,
            side,
            type: descr.ordertype || order.ordertype || 'limit',
            status: order.status || 'open',
            openedAt: order.opentm || null,
            raw: order,
            distancePercent
        };
    });

    const buy = orders.filter((item) => item.side === 'buy').sort((a, b) => b.price - a.price);
    const sell = orders.filter((item) => item.side === 'sell').sort((a, b) => a.price - b.price);

    const buyTotals = buy.reduce((acc, item) => ({
        quantity: acc.quantity + item.quantity,
        value: acc.value + item.value
    }), { quantity: 0, value: 0 });

    const sellTotals = sell.reduce((acc, item) => ({
        quantity: acc.quantity + item.quantity,
        value: acc.value + item.value
    }), { quantity: 0, value: 0 });

    return {
        buy,
        sell,
        orders,
        currentPrice,
        totals: {
            buy: buyTotals,
            sell: sellTotals,
            combinedValue: buyTotals.value + sellTotals.value
        },
        summary: {
            total: orders.length,
            buy: buy.length,
            sell: sell.length
        },
        raw: response
    };
}

class Bot extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = { ...DEFAULT_OPTIONS, ...options };
        const monitorOptions = typeof this.options.monitorOptions === 'object' && this.options.monitorOptions !== null
            ? this.options.monitorOptions
            : {};

        this.logger = createLogger(this.options.logger);

        const { wsPair, restPair, base, quote } = normalisePair(this.options.pair || DEFAULT_OPTIONS.pair);
        this.wsPair = wsPair;
        this.restPair = restPair;
        this.baseAsset = base;
        this.quoteAsset = quote;
        this._pairToken = restPair;

        this.apiKey = this.options.apiKey || process.env.KRAKEN_API_KEY || null;
        this.apiSecret = this.options.apiSecret || process.env.KRAKEN_API_SECRET || null;

        this.data = this.options.dataClient || new Data();
        this.tools = new DataTools(this.restPair, {
            interval: this.options.candleInterval,
            dataClient: this.data
        });

        this.monitor = this.options.monitor || new KrakenMonitor({
            ...monitorOptions,
            logger: this.logger,
            priceMonitoringPeriod: this.options.priceMonitoringPeriod,
            dataClient: this.data
        });
        this._createdMonitor = !this.options.monitor;

        this.running = false;
        this.busy = false;
        this._subscriptions = new Set();
        this._pairInfo = null;
        this._tickerCache = null;
        this._priceChangeHistory = [];
    }

    get pricePrecision() {
        const decimals = this._pairInfo?.pair_decimals;
        return Number.isInteger(decimals) ? decimals : 8;
    }

    get volumePrecision() {
        const decimals = this._pairInfo?.lot_decimals;
        return Number.isInteger(decimals) ? decimals : 8;
    }

    get minimumVolume() {
        return safeNumber(this._pairInfo?.ordermin, 0);
    }

    isRunning() {
        return this.running;
    }

    async start() {
        if (this.running) {
            return;
        }

        await this._invokeHook('onInit');

        if (this.options.autoLoadPairInfo) {
            await this.ensurePairMetadata();
        }

        this.running = true;
        this.emit('start', { pair: this.wsPair });

        if (this.options.autoStartPriceFeed) {
            this._subscribePriceFeed();
        }

        if (this.options.autoSubscribeOrderFills) {
            this._subscribeOrderFills();
        }

        await this._invokeHook('onStart');
    }

    async stop() {
        if (!this.running) {
            return;
        }

        this.running = false;
        this._clearSubscriptions();
        await this._invokeHook('onStop');

        if (this._createdMonitor && typeof this.monitor.close === 'function') {
            try {
                await this.monitor.close();
            } catch (error) {
                this.logger.warn(`Failed to close KrakenMonitor: ${error.message}`);
            }
        }

        this.emit('stop', { pair: this.wsPair });
    }

    async close() {
        await this.stop();
    }

    setPair(pair, options = {}) {
        const { wsPair, restPair, base, quote } = normalisePair(pair);
        if (!options.force && wsPair === this.wsPair) {
            return;
        }

        this.wsPair = wsPair;
        this.restPair = restPair;
        this.baseAsset = base;
        this.quoteAsset = quote;
        this._pairToken = restPair;
        this._pairInfo = null;
        this._tickerCache = null;
        this._priceChangeHistory = [];
        if (this.statusReporter) {
            this.statusReporter.pair = this.wsPair;
            this.statusReporter.lastSymbol = this.wsPair;
            this.statusReporter.lastPrice = null;
        }

        this.tools = new DataTools(this.restPair, {
            interval: options.candleInterval || this.options.candleInterval,
            dataClient: this.data
        });

        if (this.running && options.restartSubscriptions !== false) {
            const shouldResubscribePrice = this.options.autoStartPriceFeed;
            const shouldResubscribeFills = this.options.autoSubscribeOrderFills;

            this._clearSubscriptions();

            if (shouldResubscribePrice) {
                this._subscribePriceFeed();
            }
            if (shouldResubscribeFills) {
                this._subscribeOrderFills();
            }
        }
    }

    async ensurePairMetadata(force = false) {
        if (!force && this._pairInfo && this._matchesStoredPairInfo(this._pairInfo)) {
            return this._pairInfo;
        }

        const pairs = await this.data.getTradablePairs();
        const entries = Object.entries(pairs || {});
        const targetRest = this.restPair;
        const targetWs = this.wsPair;

        const match = entries.find(([, info]) => {
            const alt = info.altname?.toUpperCase();
            const wsname = info.wsname?.toUpperCase();
            const wsFlat = info.wsname ? info.wsname.replace('/', '').toUpperCase() : null;
            const combined = `${info.base || ''}${info.quote || ''}`.toUpperCase();
            return alt === targetRest
                || wsname === targetWs
                || wsFlat === targetRest
                || combined === targetRest;
        });

        if (!match) {
            throw new Error(`Trading pair ${this.wsPair} not found on Kraken`);
        }

        const [pairKey, info] = match;
        this._pairInfo = { ...info, pairKey };
        return this._pairInfo;
    }

    async fetchTicker() {
        await this.ensurePairMetadata(false);
        const requestPair = this._pairInfo?.altname || this.restPair;
        const result = await this.data.getTicker(requestPair);
        const ticker = extractTicker(result, this._pairInfo, [requestPair, this.restPair, this.wsPair]);
        if (!ticker) {
            throw new Error(`Ticker data for ${this.wsPair} not available`);
        }
        this._tickerCache = ticker;
        return ticker;
    }

    async fetchLatestPrice() {
        return this.tools.getprice();
    }

    async fetchBalances() {
        return this.data.getBalances();
    }

    async fetchOpenOrders(options = {}) {
        const { currentPrice } = options;
        let referencePrice = Number(currentPrice);

        if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
            try {
                const ticker = await this.fetchTicker();
                referencePrice = ticker.lastTrade || ticker.vwapToday || ticker.open || 0;
            } catch (error) {
                referencePrice = 0;
                this.logger.warn(`Unable to determine reference price for open orders: ${error.message}`);
            }
        }

        const response = await this.data.getOpenOrders();
        const formatted = normaliseOpenOrders(response, referencePrice);
        return formatted;
    }

    async fetchClosedOrders(params = {}) {
        return this.data.getClosedOrders(params);
    }

    async getLimitOrder(id, options = {}) {
        if (!id) {
            throw new Error('An order id is required to fetch limit order details');
        }
        const snapshot = await this.fetchOpenOrders(options);
        return snapshot.orders.find((order) => order.id === id) || null;
    }

    async cancelLimitOrder(idOrIds) {
        if (!idOrIds || (Array.isArray(idOrIds) && idOrIds.length === 0)) {
            throw new Error('At least one order id is required to cancel');
        }
        return this.data.cancelOrder(idOrIds);
    }

    async cancelAllOrders() {
        const snapshot = await this.fetchOpenOrders({ currentPrice: this._tickerCache?.lastTrade });
        const ids = snapshot.orders.map((order) => order.id);
        if (ids.length === 0) {
            return { count: 0 };
        }
        const response = await this.data.cancelOrder(ids);
        return { ...response, count: ids.length };
    }

    applyPricePrecision(value) {
        if (!this.options.enforcePrecision) {
            return value;
        }
        return formatWithPrecision(value, this.pricePrecision);
    }

    applyVolumePrecision(value) {
        if (!this.options.enforcePrecision) {
            return value;
        }
        return formatWithPrecision(value, this.volumePrecision);
    }

    async marketBuy(volume, params = {}) {
        return this._submitOrder({
            type: 'buy',
            ordertype: 'market',
            volume,
            params
        });
    }

    async marketSell(volume, params = {}) {
        return this._submitOrder({
            type: 'sell',
            ordertype: 'market',
            volume,
            params
        });
    }

    async limitBuy(price, volume, params = {}) {
        return this._submitOrder({
            type: 'buy',
            ordertype: 'limit',
            price,
            volume,
            params
        });
    }

    async limitSell(price, volume, params = {}) {
        return this._submitOrder({
            type: 'sell',
            ordertype: 'limit',
            price,
            volume,
            params
        });
    }

    watchOrderBook(callback, opts = {}) {
        if (typeof callback !== 'function') {
            throw new Error('A callback function is required to watch the order book');
        }

        const handle = this.monitor.onOrderBook(this.wsPair, callback, opts);
        const entry = { type: 'orderbook', handle };
        this._subscriptions.add(entry);

        return {
            unsubscribe: () => {
                try {
                    handle?.unsubscribe?.();
                } finally {
                    this._subscriptions.delete(entry);
                }
            }
        };
    }

    async onInit() {}

    async onStart() {}

    async onStop() {}

    async onPriceUpdate() {}

    async onOrderFill() {}

    _matchesStoredPairInfo(info) {
        if (!info) {
            return false;
        }
        const alt = info.altname?.toUpperCase();
        const ws = info.wsname?.toUpperCase();
        const combined = `${info.base || ''}${info.quote || ''}`.toUpperCase();
        return alt === this.restPair || ws === this.wsPair || combined === this.restPair;
    }

    _matchesPairSymbol(symbol) {
        if (!symbol) {
            return false;
        }
        return String(symbol).toUpperCase().replace(/\W/g, '') === this._pairToken;
    }

    async _submitOrder({ type, ordertype, price, volume, params = {} }) {
        if (!type || !ordertype) {
            throw new Error('Order type and order side are required');
        }

        await this.ensurePairMetadata(false);

        const payload = {
            pair: this._pairInfo?.altname || this.restPair,
            type,
            ordertype,
            ...params
        };

        if (volume !== undefined) {
            payload.volume = this._normaliseVolume(volume);
        }

        if (price !== undefined) {
            payload.price = this._normalisePrice(price);
        }

        if (this.options.dryRun) {
            this.logger.info('[DryRun] Kraken AddOrder payload:', payload);
            this.emit('order:submitted', { payload, dryRun: true });
            return { dryRun: true, payload };
        }

        const response = await this.data.addOrder(payload);
        this.emit('order:submitted', { payload, response });
        return response;
    }

    _normaliseVolume(volume) {
        const numeric = Number(volume);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            throw new Error('A positive volume is required for orders');
        }

        if (!this.options.enforcePrecision) {
            return numeric;
        }

        const min = this.minimumVolume;
        if (min > 0 && numeric < min) {
            throw new Error(`Volume ${numeric} is below minimum order size ${min}`);
        }

        return this.applyVolumePrecision(numeric);
    }

    _normalisePrice(price) {
        const numeric = Number(price);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            throw new Error('A positive price is required for limit orders');
        }

        return this.applyPricePrecision(numeric);
    }

    _subscribePriceFeed() {
        const interval = Number.isInteger(this.options.priceInterval) && this.options.priceInterval > 0
            ? this.options.priceInterval
            : this.options.candleInterval;

        const handle = this.monitor.onPriceChange(
            this.wsPair,
            (priceData) => {
                const thresholdTriggered = this._evaluatePriceChangeThreshold(priceData);
                const meta = {
                    pair: this.wsPair,
                    thresholdTriggered
                };
                this.emit('price', priceData, meta);
                Promise.resolve(this.onPriceUpdate(priceData, meta)).catch((error) => {
                    this._handleHookError('onPriceUpdate', error);
                });
            },
            {
                interval
            }
        );

        const entry = { type: 'price', handle };
        this._subscriptions.add(entry);
        return () => {
            try {
                handle?.unsubscribe?.();
            } finally {
                this._subscriptions.delete(entry);
            }
        };
    }

    _subscribeOrderFills() {
        const handle = this.monitor.onLimitOrderFill((details) => {
            if (details?.symbol && !this._matchesPairSymbol(details.symbol)) {
                return;
            }
            this.emit('fill', details);
            Promise.resolve(this.onOrderFill(details)).catch((error) => {
                this._handleHookError('onOrderFill', error);
            });
        });

        const entry = { type: 'fills', handle };
        this._subscriptions.add(entry);
        return () => {
            try {
                handle?.unsubscribe?.();
            } finally {
                this._subscriptions.delete(entry);
            }
        };
    }

    _clearSubscriptions() {
        for (const entry of this._subscriptions) {
            try {
                entry?.handle?.unsubscribe?.();
            } catch (error) {
                const typeLabel = entry?.type || 'subscription';
                this.logger.warn(`Failed to unsubscribe from ${typeLabel}: ${error.message}`);
            }
        }
        this._subscriptions.clear();
    }

    async _invokeHook(name, ...args) {
        const handler = this[name];
        if (typeof handler !== 'function') {
            return;
        }

        try {
            await handler.apply(this, args);
        } catch (error) {
            this._handleHookError(name, error);
        }
    }

    _handleHookError(name, error) {
        const message = error?.message || error;
        this.logger.error(`[Bot] ${name} hook failed: ${message}`);
        this.emit('error', { hook: name, error });
    }

    _evaluatePriceChangeThreshold(priceData = {}) {
        const threshold = Number(this.options.priceChangeThreshold);
        if (!Number.isFinite(threshold) || threshold <= 0) {
            return false;
        }

        const price = this._extractPrice(priceData);
        if (!Number.isFinite(price) || price <= 0) {
            return false;
        }

        const timestamp = this._extractTimestamp(priceData);
        const history = this._priceChangeHistory;
        const periodSeconds = Number(this.options.priceMonitoringPeriod);
        const windowMs = Number.isFinite(periodSeconds) && periodSeconds > 0 ? periodSeconds * 1000 : 5000;

        while (history.length > 0 && timestamp - history[0].timestamp > windowMs) {
            history.shift();
        }

        let triggered = false;
        for (const snapshot of history) {
            if (!Number.isFinite(snapshot.price) || snapshot.price <= 0) {
                continue;
            }
            const pctChange = Math.abs((price - snapshot.price) / snapshot.price) * 100;
            if (pctChange >= threshold) {
                triggered = true;
                break;
            }
        }

        history.push({ timestamp, price });
        if (history.length > 500) {
            history.splice(0, history.length - 500);
        }

        return triggered;
    }

    _extractPrice(priceData = {}) {
        const candidates = [
            priceData.close,
            priceData.last,
            priceData.price,
            priceData.c
        ];
        for (const candidate of candidates) {
            const numeric = Number(candidate);
            if (Number.isFinite(numeric)) {
                return numeric;
            }
        }
        return null;
    }

    _extractTimestamp(priceData = {}) {
        return priceData.channelTimestampUnix
            || priceData.timestampUnix
            || priceData.intervalBeginUnix
            || Date.now();
    }
}

module.exports = Bot;
