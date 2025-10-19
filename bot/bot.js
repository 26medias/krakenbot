#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { program } = require('commander');
const WebSocket = require('ws');

const KrakenMonitor = require('./KrakenMonitor');
const LimitOrders = require('./LimitOrders');
const DataTools = require('./DataTools');
const Data = require('./Data');

const DEFAULT_SETTINGS = Object.freeze({
    ordersPerSide: 10,
    minOrderValue: 5,
    spacingSpread: 0.53,
    spacingMarginLeftPercent: 0,
    spacingMarginRightPercent: 3,
    valueSpread: -0.14,
    valueMarginLeftPercent: 20,
    valueMarginRightPercent: 0,
    priceRangePeriod: 120,
    priceRangeMultiplier: 5
});

const DEFAULT_RISK = 50;
const SETTINGS_DIR = path.join(__dirname, 'config');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'bot-settings.json');

function loadSettingsStore() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`Failed to load bot settings from disk: ${error.message}`);
        }
    }
    return {};
}

async function persistSettingsStore(store) {
    await fs.promises.mkdir(SETTINGS_DIR, { recursive: true });
    await fs.promises.writeFile(
        SETTINGS_FILE,
        JSON.stringify(store, null, 2),
        'utf8'
    );
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1e6) {
                req.destroy();
                const error = new Error('Request body too large');
                error.statusCode = 413;
                reject(error);
            }
        });
        req.on('end', () => {
            if (!data) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                const parseError = new Error('Invalid JSON body');
                parseError.statusCode = 400;
                reject(parseError);
            }
        });
        req.on('error', reject);
    });
}

function normaliseNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatOpenOrders(orders = [], latestPrice = 0) {
    const currentPrice = Number(latestPrice) || 0;
    const buy = [];
    const sell = [];

    for (const order of orders) {
        const side = order?.descr?.type === 'sell' ? 'sell' : 'buy';
        const rawPrice = Number(order?.descr?.price);
        const price = Number.isFinite(rawPrice) ? rawPrice : 0;
        const rawVolume = Number(order?.vol);
        const volume = Number.isFinite(rawVolume) ? rawVolume : 0;
        const filledVolume = Number(order?.vol_exec) || 0;
        const value = price * volume;
        const distancePercent = currentPrice > 0 && price > 0
            ? ((price - currentPrice) / currentPrice) * 100
            : 0;
        const formatted = {
            id: order.id,
            price,
            quantity: volume,
            value,
            side,
            status: order.status,
            openedAt: order.opentm || null,
            filled: filledVolume,
            distancePercent
        };

        if (side === 'sell') {
            sell.push(formatted);
        } else {
            buy.push(formatted);
        }
    }

    buy.sort((a, b) => b.price - a.price);
    sell.sort((a, b) => b.price - a.price);

    const summary = {
        total: buy.length + sell.length,
        buy: buy.length,
        sell: sell.length
    };

    const totals = {
        buy: buy.reduce((acc, item) => ({
            quantity: acc.quantity + item.quantity,
            value: acc.value + item.value
        }), { quantity: 0, value: 0 }),
        sell: sell.reduce((acc, item) => ({
            quantity: acc.quantity + item.quantity,
            value: acc.value + item.value
        }), { quantity: 0, value: 0 })
    };

    totals.combinedValue = totals.buy.value + totals.sell.value;

    return { buy, sell, summary, totals };
}

class Bot {
    constructor(pair, risk = 70, options = {}) {
        this.pairName = pair;
        this.risk = risk;
        this.options = options;
        this.tools = new DataTools(pair);
        this.Data = new Data();
        this.monitor = new KrakenMonitor();
        this.subscriptions = {};
        this.busy = false;
        this.running = false;
        this.settings = { ...DEFAULT_SETTINGS };
        this.pairInfo = null;
    }

    setPair(pair) {
        if (typeof pair !== 'string' || !pair || pair === this.pairName) {
            return;
        }
        this.pairName = pair;
        this.tools = new DataTools(pair);
        this.pairInfo = null;
    }

    getSettings() {
        return { ...this.settings };
    }

    updateSettings(partial = {}) {
        if (!partial || typeof partial !== 'object') {
            return this.getSettings();
        }
        this.settings = { ...this.settings, ...partial };
        return this.getSettings();
    }

    async ensurePairMetadata() {
        if (this.pairInfo && this.pairInfo.altname === this.pairName) {
            return this.pairInfo;
        }

        const pairs = await this.Data.getTradablePairs();
        const match = Object.values(pairs).find((item) => (
            item.altname === this.pairName ||
            item.wsname?.replace('/', '') === this.pairName ||
            item.wsname === this.pairName
        ));

        if (!match) {
            throw new Error(`Trading pair ${this.pairName} not found`);
        }

        this.pairInfo = match;
        this.pair = [match];
        return match;
    }

    async init() {
        if (this.running) {
            return;
        }

        await this.ensurePairMetadata();

        let subscriptionHandle = null;
        try {
            subscriptionHandle = this.monitor.onLimitOrderFill(async (orderDetails) => {
                console.log('Limit order fill update:', orderDetails);
                await this.onRebalance(orderDetails);
            });
            this.subscriptions.limitFill = subscriptionHandle;

            const orderCount = await this.countOpenLimitOrders();
            console.log(`${orderCount.total} open orders (Buy: ${orderCount.buy}, Sell: ${orderCount.sell})`);
            if (orderCount.buy === 0 || orderCount.sell === 0) {
                console.log('One side has no orders, recreating full set of limit orders');
                await this.resetLimitOrders();
                const { buyOrders, sellOrders } = await this.calculateLimitRanges();
                await this.createLimitOrders(buyOrders, sellOrders);
            }

            this.running = true;
        } catch (error) {
            subscriptionHandle?.unsubscribe?.();
            this.subscriptions.limitFill = null;
            throw error;
        }
    }

    async createInitialState() {
        const range = await this.calculateLimitRanges();
        console.log(JSON.stringify(range, null, 4));
        await this.createLimitOrders(range.buyOrders, range.sellOrders);
    }

    async shutdown() {
        this.running = false;
        this.subscriptions?.limitFill?.unsubscribe?.();
        this.subscriptions = {};
        await this.monitor.close();
    }

    async balance() {
        await this.ensurePairMetadata();
        const balances = await this.Data.getBalance();
        const baseAsset = this.pairInfo.base;
        const quoteAsset = this.pairInfo.quote;
        const balanceBase = normaliseNumber(balances[baseAsset], 0);
        const balanceQuote = normaliseNumber(balances[quoteAsset], 0);
        return {
            base: balanceBase,
            quote: balanceQuote
        };
    }

    async calculateLimitRanges(overrides = {}, options = {}) {
        await this.ensurePairMetadata();

        const settings = { ...this.settings, ...overrides };
        const rangePeriod = clamp(settings.priceRangePeriod, 1, 1440);
        const diffMultiplier = clamp(settings.priceRangeMultiplier, 0.01, 1000);

        const latest = options.price || await this.tools.getprice();
        const range = await this.tools.getPriceRange(rangePeriod);
        const rangeDif = parseFloat((range.high - range.low).toFixed(6));
        const rawPctRange = parseFloat((((rangeDif * diffMultiplier) / latest.c) * 100).toFixed(2));
        const DEFAULT_RANGE_PERCENT = 20;
        const pctRange = Number.isFinite(rawPctRange) && rawPctRange > 0 ? rawPctRange : DEFAULT_RANGE_PERCENT;

        const balance = options.balance || await this.balance();
        const riskPercent = options.risk !== undefined ? options.risk : this.risk;

        const usdBalance = parseFloat((balance.quote * riskPercent / 100).toFixed(6));
        const assetBalance = parseFloat((balance.base * riskPercent / 100).toFixed(6));

        const positiveRangeAmount = Number.isFinite(overrides.positiveRange)
            ? Math.max(0, overrides.positiveRange)
            : latest.c * pctRange / 100;
        const negativeRangeAmount = Number.isFinite(overrides.negativeRange)
            ? Math.max(0, overrides.negativeRange)
            : latest.c * pctRange / 100;

        const params = {
            currentPrice: latest.c,
            positiveRange: positiveRangeAmount,
            negativeRange: negativeRangeAmount,
            ordersPerSide: settings.ordersPerSide,
            usdBalance,
            assetBalance,
            minOrderValue: settings.minOrderValue,
            spacingSpread: settings.spacingSpread,
            spacingMarginLeftPercent: settings.spacingMarginLeftPercent,
            spacingMarginRightPercent: settings.spacingMarginRightPercent,
            valueSpread: settings.valueSpread,
            valueMarginLeftPercent: settings.valueMarginLeftPercent,
            valueMarginRightPercent: settings.valueMarginRightPercent
        };

        const { buyOrders, sellOrders } = new LimitOrders(params).calculate();

        let sumQuote = 0;
        let sumBase = 0;
        buyOrders.forEach((order) => {
            sumQuote += order.value;
        });
        sellOrders.forEach((order) => {
            sumBase += order.quantity;
        });
        sellOrders.reverse();

        const totals = {
            buy: {
                quantity: buyOrders.reduce((acc, order) => acc + order.quantity, 0),
                value: buyOrders.reduce((acc, order) => acc + order.value, 0)
            },
            sell: {
                quantity: sellOrders.reduce((acc, order) => acc + order.quantity, 0),
                value: sellOrders.reduce((acc, order) => acc + order.value, 0)
            }
        };
        totals.combinedValue = totals.buy.value + totals.sell.value;

        return {
            buyOrders,
            sellOrders,
            sum_base: sumBase,
            sum_quote: sumQuote,
            totals,
            meta: {
                currentPrice: latest.c,
                priceRange: {
                    high: range.high,
                    low: range.low,
                    percent: pctRange
                },
                riskPercent,
                settings
            }
        };
    }

    async wait(ms) {
        const delay = Math.max(0, Number(ms) || 0);
        if (delay === 0) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    async onRebalance(event) {
        if (this.busy) {
            console.log('Rebalance already in progress, skipping this event');
            return;
        }
        this.busy = true;

        try {
            const orderCount = await this.countOpenLimitOrders();
            console.log(`Rebalance check: ${orderCount.total} open orders (Buy: ${orderCount.buy}, Sell: ${orderCount.sell})`);

            if (orderCount.buy === 0 || orderCount.sell === 0) {
                console.log('One side has no orders, recreating full set of limit orders');
                await this.resetLimitOrders();
                const limitOrders = await this.calculateLimitRanges();
                await this.createLimitOrders(limitOrders.buyOrders, limitOrders.sellOrders);
            } else {
                const openOrders = await this.getOpenOrders();
                const sellOrders = openOrders.filter((order) => order.descr.type === 'sell');
                const buyOrders = openOrders.filter((order) => order.descr.type === 'buy');
                const lowestBuyOrder = buyOrders.reduce((minOrder, order) => {
                    const price = parseFloat(order.descr.price);
                    return (minOrder === null || price < parseFloat(minOrder.descr.price)) ? order : minOrder;
                }, null);
                const highestSellOrder = sellOrders.reduce((maxOrder, order) => {
                    const price = parseFloat(order.descr.price);
                    return (maxOrder === null || price > parseFloat(maxOrder.descr.price)) ? order : maxOrder;
                }, null);

                const latest = await this.tools.getprice();

                const rangeUp = highestSellOrder ? parseFloat(highestSellOrder.descr.price) - latest.c : undefined;
                const rangeDown = lowestBuyOrder ? latest.c - parseFloat(lowestBuyOrder.descr.price) : undefined;

                const limitOrders = await this.calculateLimitRanges({
                    positiveRange: rangeUp,
                    negativeRange: rangeDown
                });

                if (event.side === 'buy') {
                    console.log('-- Delete all SELL order above close --');
                    await this.cancelLimitOrdersByPrice(latest.c, 'gt');
                    await this.createLimitOrders([], limitOrders.sellOrders);
                } else if (event.side === 'sell') {
                    console.log('-- Delete all BUY order below close --');
                    await this.cancelLimitOrdersByPrice(latest.c, 'lt');
                    await this.createLimitOrders(limitOrders.buyOrders, []);
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async getOpenOrders() {
        await this.ensurePairMetadata();
        const openOrders = await this.Data.getOpenOrders();
        const orderIds = Object.keys(openOrders.open);
        return orderIds.map((key) => ({
            id: key,
            ...openOrders.open[key]
        })).filter((item) => item.descr.pair === this.pairName);
    }

    async countOpenLimitOrders() {
        const orders = await this.getOpenOrders();
        const result = { buy: 0, sell: 0, total: 0 };

        for (const order of orders) {
            const side = order?.descr?.type;
            if (side === 'buy') {
                result.buy += 1;
            } else if (side === 'sell') {
                result.sell += 1;
            }
        }

        result.total = result.buy + result.sell;
        return result;
    }

    async resetLimitOrders() {
        const orders = await this.getOpenOrders();
        for (const order of orders) {
            console.log(`Cancelling order ${order.id} at price ${order.descr.price}`);
            await this.Data.cancelOrder(order.id);
        }
        console.log('Waiting for orders to settle and balance to update...');
        await this.wait(1000);
    }

    async cancelLimitOrdersByPrice(limitPrice, op = 'gt') {
        const threshold = Number(limitPrice);
        if (!Number.isFinite(threshold)) {
            throw new Error('limitPrice must be a finite number');
        }

        const operation = op === 'lt' ? 'lt' : 'gt';
        const logger = this.options.logger || console;
        const dryRun = Boolean(this.options?.dryRun);

        const orders = await this.getOpenOrders();
        const summary = {
            matched: [],
            cancelled: [],
            failed: [],
            skipped: []
        };

        for (const order of orders) {
            const price = Number(order.descr?.price);
            if (!Number.isFinite(price)) {
                summary.skipped.push({
                    id: order.id,
                    reason: 'non-numeric price',
                    rawPrice: order.descr?.price
                });
                continue;
            }

            const matches = operation === 'gt' ? price > threshold : price < threshold;
            if (!matches) {
                continue;
            }

            summary.matched.push({ id: order.id, price, side: order.descr?.type });

            if (dryRun) {
                summary.cancelled.push({
                    id: order.id,
                    price,
                    side: order.descr?.type,
                    dryRun: true
                });
                continue;
            }

            try {
                const response = await this.Data.cancelOrder(order.id);
                logger.info?.(`Cancelled order ${order.id} @ ${price}`);
                summary.cancelled.push({
                    id: order.id,
                    price,
                    side: order.descr?.type,
                    response
                });
            } catch (error) {
                logger.error?.(`Failed to cancel order ${order.id} @ ${price}: ${error.message}`);
                summary.failed.push({
                    id: order.id,
                    price,
                    side: order.descr?.type,
                    error: error.message
                });
            }
        }

        if (!dryRun && summary.cancelled.length > 0) {
            await this._persistOrderSnapshots().catch((error) => {
                logger.error?.(`Failed to persist order snapshot: ${error.message}`);
            });
        }

        return summary;
    }

    async createLimitOrders(buyOrders = [], sellOrders = []) {
        await this.ensurePairMetadata();
        console.log(`Creating ${buyOrders.length} buy orders and ${sellOrders.length} sell orders`);
        buyOrders.forEach((order, index) => {
            console.log(`    BUY    ${index + 1}: Price=${order.price.toFixed(6)} Qty=${order.quantity.toFixed(6)} Value=${order.value.toFixed(6)}`);
        });
        sellOrders.forEach((order, index) => {
            console.log(`    SELL ${index + 1}: Price=${order.price.toFixed(6)} Qty=${order.quantity.toFixed(6)} Value=${order.value.toFixed(6)}`);
        });
        let sellStats = { base: 0, quote: 0 };
        sellOrders.forEach((order) => {
            sellStats.base += order.quantity;
            sellStats.quote += order.value;
        });
        let buyStats = { base: 0, quote: 0 };
        buyOrders.forEach((order) => {
            buyStats.base += order.quantity;
            buyStats.quote += order.value;
        });
        console.log(`Total BUY orders: Qty=${buyStats.base.toFixed(6)} Value=${buyStats.quote.toFixed(6)}`);
        console.log(`Total SELL orders: Qty=${sellStats.base.toFixed(6)} Value=${sellStats.quote.toFixed(6)}`);

        const pairInfo = this.pairInfo;
        if (!pairInfo) {
            throw new Error('Pair metadata unavailable. Call init() before creating orders.');
        }

        const logger = this.options.logger || console;
        const dryRun = Boolean(this.options?.dryRun);
        const pricePrecision = Number.isInteger(pairInfo.pair_decimals) ? pairInfo.pair_decimals : 8;
        const volumePrecision = Number.isInteger(pairInfo.lot_decimals) ? pairInfo.lot_decimals : 8;

        const roundNumber = (value, decimals) => {
            if (!Number.isFinite(value)) {
                return Number.NaN;
            }
            const factor = 10 ** Math.max(0, decimals);
            return Math.round(value * factor) / factor;
        };

        const orders = [];
        const skipped = [];

        const enqueueOrders = (entries, side) => {
            if (!Array.isArray(entries)) {
                return;
            }
            entries.forEach((entry, index) => {
                const rawPrice = Number(entry.price);
                const rawQty = Number(entry.quantity);
                if (!Number.isFinite(rawPrice) || !Number.isFinite(rawQty) || rawQty <= 0) {
                    skipped.push({
                        side,
                        index,
                        reason: 'invalid price or quantity',
                        entry
                    });
                    return;
                }

                const price = roundNumber(rawPrice, pricePrecision);
                const volume = roundNumber(rawQty, volumePrecision);
                if (!Number.isFinite(price) || !Number.isFinite(volume) || volume <= 0) {
                    skipped.push({
                        side,
                        index,
                        reason: 'rounded quantity or price invalid',
                        entry
                    });
                    return;
                }

                orders.push({
                    side,
                    price,
                    volume,
                    value: Number.isFinite(entry.value) ? entry.value : null
                });
            });
        };

        enqueueOrders(buyOrders, 'buy');
        enqueueOrders(sellOrders, 'sell');

        const summary = {
            submitted: [],
            failed: [],
            skipped
        };

        for (const order of orders) {
            if (dryRun) {
                summary.submitted.push({
                    ...order,
                    txid: null,
                    dryRun: true
                });
                continue;
            }

            try {
                const response = await this.Data.addOrder(
                    order.side,
                    this.pairName,
                    'limit',
                    order.price,
                    order.volume
                );
                const txid = Array.isArray(response?.txid) ? response.txid[0] : null;
                summary.submitted.push({
                    ...order,
                    txid,
                    response
                });
                logger.info?.(`Submitted ${order.side} order @ ${order.price} for ${order.volume} (${txid || 'pending txid'})`);
            } catch (error) {
                logger.error?.(`Failed to submit ${order.side} order @ ${order.price}: ${error.message}`);
                summary.failed.push({
                    ...order,
                    error: error.message
                });
            }
        }

        if (!dryRun && orders.length > 0) {
            await this._persistOrderSnapshots().catch((error) => {
                logger.error?.(`Failed to persist order snapshot: ${error.message}`);
            });
        }

        return summary;
    }

    async _persistOrderSnapshots() {
        const openOrders = await this.Data.getOpenOrders();
        const ordersArray = Object.entries(openOrders.open || {}).map(([id, order]) => ({
            id,
            ...order
        }));

        await fs.promises.writeFile(
            path.join(__dirname, 'openOrders.json'),
            JSON.stringify(openOrders, null, 2),
            'utf8'
        );

        await fs.promises.writeFile(
            path.join(__dirname, 'orders.json'),
            JSON.stringify(ordersArray, null, 2),
            'utf8'
        );
    }
}

class TradingBotManager {
    constructor({ pair, risk, settings, logger = console } = {}) {
        this.logger = logger;
        this.pair = typeof pair === 'string' && pair ? pair : 'XDGUSD';
        this.running = false;

        this.priceCache = new Map();
        this.priceInflight = new Map();
        this.settingsStore = loadSettingsStore();

        const persisted = this.getPersistedEntry(this.pair);
        const baseSettings = {
            ...DEFAULT_SETTINGS,
            ...(persisted?.settings || {})
        };
        this.settings = {
            ...baseSettings,
            ...(settings || {})
        };
        const persistedRisk = persisted?.risk ?? DEFAULT_RISK;
        this.risk = Number.isFinite(risk) ? clamp(risk, 1, 100) : persistedRisk;

        this.bot = new Bot(this.pair, this.risk, { logger: this.logger });
        this.bot.updateSettings(this.settings);
    }

    get status() {
        return {
            pair: this.pair,
            risk: this.risk,
            running: this.running,
            settings: { ...this.settings }
        };
    }

    getPersistedEntry(pair) {
        if (!pair || !this.settingsStore || typeof this.settingsStore !== 'object') {
            return null;
        }
        const entry = this.settingsStore[pair];
        if (!entry || typeof entry !== 'object') {
            return null;
        }
        const safeSettings = entry.settings && typeof entry.settings === 'object'
            ? { ...entry.settings }
            : {};
        const safeRisk = Number.isFinite(entry.risk) ? clamp(entry.risk, 1, 100) : null;
        return {
            settings: safeSettings,
            risk: safeRisk
        };
    }

    resolvePairState(pair) {
        const persisted = this.getPersistedEntry(pair);
        return {
            settings: {
                ...DEFAULT_SETTINGS,
                ...(persisted?.settings || {})
            },
            risk: persisted?.risk ?? DEFAULT_RISK
        };
    }

    async persistCurrentSettings() {
        if (!this.settingsStore || typeof this.settingsStore !== 'object') {
            this.settingsStore = {};
        }
        this.settingsStore[this.pair] = {
            risk: this.risk,
            settings: { ...this.settings }
        };
        await persistSettingsStore(this.settingsStore);
    }

    async ensureBot(pair = this.pair) {
        if (pair !== this.pair) {
            await this.updatePair(pair);
        }
        if (!this.bot) {
            this.bot = new Bot(this.pair, this.risk, { logger: this.logger });
            this.bot.updateSettings(this.settings);
        }
        return this.bot;
    }

    async updatePair(pair) {
        if (typeof pair !== 'string' || !pair || pair === this.pair) {
            return;
        }
        if (this.running) {
            await this.stop();
        }
        this.pair = pair;
        const { settings, risk } = this.resolvePairState(pair);
        this.settings = { ...settings };
        this.risk = Number.isFinite(risk) ? risk : DEFAULT_RISK;
        this.bot = new Bot(this.pair, this.risk, { logger: this.logger });
        this.bot.updateSettings(this.settings);
    }

    normaliseSettings(input = {}) {
        const result = {};
        if (input.ordersPerSide !== undefined) {
            const value = Math.max(0, Math.round(normaliseNumber(input.ordersPerSide)));
            result.ordersPerSide = value;
        }
        if (input.minOrderValue !== undefined) {
            result.minOrderValue = Math.max(0, normaliseNumber(input.minOrderValue));
        }
        if (input.spacingSpread !== undefined) {
            result.spacingSpread = clamp(normaliseNumber(input.spacingSpread), -1, 1);
        }
        if (input.spacingMarginLeftPercent !== undefined) {
            result.spacingMarginLeftPercent = clamp(normaliseNumber(input.spacingMarginLeftPercent), 0, 100);
        }
        if (input.spacingMarginRightPercent !== undefined) {
            result.spacingMarginRightPercent = clamp(normaliseNumber(input.spacingMarginRightPercent), 0, 100);
        } else if (input.spacingMarginPercent !== undefined) {
            result.spacingMarginRightPercent = clamp(normaliseNumber(input.spacingMarginPercent), 0, 100);
        }
        if (input.valueSpread !== undefined) {
            result.valueSpread = clamp(normaliseNumber(input.valueSpread), -1, 1);
        }
        if (input.valueMarginLeftPercent !== undefined) {
            result.valueMarginLeftPercent = clamp(normaliseNumber(input.valueMarginLeftPercent), 0, 100);
        }
        if (input.valueMarginRightPercent !== undefined) {
            result.valueMarginRightPercent = clamp(normaliseNumber(input.valueMarginRightPercent), 0, 100);
        } else if (input.valueMarginPercent !== undefined) {
            result.valueMarginRightPercent = clamp(normaliseNumber(input.valueMarginPercent), 0, 100);
        }
        if (input.priceRangePeriod !== undefined) {
            result.priceRangePeriod = clamp(normaliseNumber(input.priceRangePeriod), 1, 1440);
        }
        if (input.priceRangeMultiplier !== undefined) {
            const multiplier = normaliseNumber(input.priceRangeMultiplier);
            result.priceRangeMultiplier = multiplier > 0 ? multiplier : this.settings.priceRangeMultiplier;
        }
        return result;
    }

    async updateSettings({ pair, risk, settings } = {}) {
        if (pair !== undefined) {
            await this.updatePair(pair);
        }
        if (risk !== undefined) {
            const parsedRisk = clamp(normaliseNumber(risk), 1, 100);
            this.risk = parsedRisk;
        }
        if (settings !== undefined && settings !== null) {
            const normalised = this.normaliseSettings(settings);
            this.settings = { ...this.settings, ...normalised };
        }
        if (this.bot) {
            this.bot.risk = this.risk;
            this.bot.updateSettings({ ...this.settings });
        }
        await this.persistCurrentSettings();
        return this.status;
    }

    async getLatestPrice(pair = this.pair, { ttl = 15000, force = false } = {}) {
        const key = pair;
        const now = Date.now();

        if (!force) {
            const cached = this.priceCache.get(key);
            if (cached && cached.expiresAt > now) {
                return cached.value;
            }
        }

        if (this.priceInflight.has(key)) {
            return this.priceInflight.get(key);
        }

        const fetchPrice = (async () => {
            let tools;
            if (pair === this.pair && this.bot) {
                tools = this.bot.tools;
            } else {
                tools = new DataTools(pair);
            }
            const latest = await tools.getprice();
            const payload = {
                ...latest,
                retrievedAt: new Date().toISOString()
            };
            this.priceCache.set(key, { value: payload, expiresAt: now + ttl });
            return payload;
        })();

        this.priceInflight.set(key, fetchPrice);
        try {
            return await fetchPrice;
        } finally {
            this.priceInflight.delete(key);
        }
    }

    async start(options = {}) {
        await this.updateSettings(options);
        const bot = await this.ensureBot();
        bot.risk = this.risk;
        await bot.init();
        this.running = true;
        return this.status;
    }

    async stop() {
        if (!this.bot) {
            this.running = false;
            return this.status;
        }
        await this.bot.shutdown();
        this.running = false;
        return this.status;
    }

    async cancelAllOrders(pair = this.pair) {
        const bot = await this.ensureBot(pair);
        return bot.resetLimitOrders();
    }

    async rebuildOrders(pair = this.pair) {
        const bot = await this.ensureBot(pair);
        await bot.resetLimitOrders();
        const ranges = await bot.calculateLimitRanges();
        await bot.createLimitOrders(ranges.buyOrders, ranges.sellOrders);
        return ranges;
    }

    async buildSnapshot({ pair, settingsOverrides, riskOverride } = {}) {
        const pairToUse = pair || this.pair;
        const overrides = settingsOverrides ? this.normaliseSettings(settingsOverrides) : {};
        const isActivePair = pairToUse === this.pair;

        const baseState = isActivePair
            ? { settings: { ...this.settings }, risk: this.risk }
            : this.resolvePairState(pairToUse);

        const baseSettings = { ...baseState.settings };
        const baseRisk = baseState.risk;
        const risk = riskOverride !== undefined ? clamp(normaliseNumber(riskOverride), 1, 100) : baseRisk;
        const effectiveSettings = { ...baseSettings, ...overrides };

        let bot;
        if (isActivePair) {
            bot = await this.ensureBot(pairToUse);
            bot.updateSettings({ ...baseSettings });
        } else {
            bot = new Bot(pairToUse, risk, { logger: this.logger });
            bot.updateSettings(baseSettings);
        }
        bot.risk = risk;

        const [latestPrice, balance, openOrdersRaw] = await Promise.all([
            this.getLatestPrice(pairToUse, { ttl: 15000 }),
            bot.balance(),
            bot.getOpenOrders()
        ]);

        const distribution = await bot.calculateLimitRanges(overrides, {
            risk,
            balance,
            price: latestPrice
        });

        const openOrders = formatOpenOrders(openOrdersRaw, latestPrice.c);

        const riskAdjustedBalances = {
            quote: balance.quote * risk / 100,
            base: balance.base * risk / 100
        };

        return {
            pair: pairToUse,
            risk,
            running: isActivePair ? this.running : false,
            settings: effectiveSettings,
            price: latestPrice,
            balances: {
                total: balance,
                riskAdjusted: riskAdjustedBalances
            },
            openOrders,
            distribution
        };
    }
}

function createRequestHandler(manager) {
    return async function handler(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const { pathname, searchParams } = parsedUrl;

        try {
            if (req.method === 'GET' && pathname === '/') {
                const filePath = path.join(__dirname, 'static', 'page.html');
                const stream = fs.createReadStream(filePath);
                stream.on('open', () => {
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8'
                    });
                    stream.pipe(res);
                });
                stream.on('error', (error) => {
                    console.error(error);
                    if (!res.headersSent) {
                        sendJson(res, 500, { error: 'Failed to load page' });
                    } else {
                        res.destroy(error);
                    }
                });
                return;
            }

            if (req.method === 'GET' && pathname === '/api/status') {
                sendJson(res, 200, manager.status);
                return;
            }

            if (req.method === 'GET' && pathname === '/api/dashboard') {
                const pair = searchParams.get('pair') || manager.pair;
                const snapshot = await manager.buildSnapshot({ pair });
                sendJson(res, 200, snapshot);
                return;
            }

            if (req.method === 'GET' && pathname === '/api/pairs') {
                const data = await manager.bot.Data.getTradablePairs(null, 'info');
                const pairs = Object.entries(data).map(([pair, details]) => ({
                    pair,
                    altname: details.altname,
                    wsname: details.wsname || null,
                    base: details.base,
                    quote: details.quote,
                    lot: details.lot,
                    pair_decimals: details.pair_decimals,
                    lot_decimals: details.lot_decimals,
                    lot_multiplier: details.lot_multiplier,
                    status: details.status || null
                })).filter((item) => item.altname?.includes('USD'));
                sendJson(res, 200, pairs);
                return;
            }

            if (req.method === 'PATCH' && pathname === '/api/settings') {
                const body = await parseBody(req);
                const { pair, risk, settings } = body;
                await manager.updateSettings({ pair, risk, settings });
                const snapshot = await manager.buildSnapshot({ pair: manager.pair });
                sendJson(res, 200, snapshot);
                return;
            }

            if (req.method === 'POST' && pathname === '/api/bot/start') {
                const body = await parseBody(req);
                await manager.start(body);
                const snapshot = await manager.buildSnapshot({ pair: manager.pair });
                sendJson(res, 200, snapshot);
                return;
            }

            if (req.method === 'POST' && pathname === '/api/bot/stop') {
                await manager.stop();
                sendJson(res, 200, manager.status);
                return;
            }

            if (req.method === 'POST' && pathname === '/api/orders/cancel') {
                const body = await parseBody(req);
                const pair = body?.pair || manager.pair;
                const result = await manager.cancelAllOrders(pair);
                sendJson(res, 200, { success: true, result });
                return;
            }

            if (req.method === 'POST' && pathname === '/api/orders/reset') {
                const body = await parseBody(req);
                const pair = body?.pair || manager.pair;
                const result = await manager.rebuildOrders(pair);
                sendJson(res, 200, { success: true, result });
                return;
            }

            if (req.method === 'POST' && pathname === '/api/preview') {
                const body = await parseBody(req);
                const { pair, risk, settings } = body;
                const snapshot = await manager.buildSnapshot({
                    pair: pair || manager.pair,
                    settingsOverrides: settings,
                    riskOverride: risk
                });
                sendJson(res, 200, snapshot);
                return;
            }

            sendJson(res, 404, { error: 'Not Found' });
        } catch (error) {
            console.error(error);
            const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
            sendJson(res, statusCode, { error: error.message });
        }
    };
}

function setupWebSocket(server, manager) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        let parsed;
        try {
            parsed = new URL(req.url, `http://${req.headers.host}`);
        } catch (error) {
            socket.destroy();
            return;
        }

        if (parsed.pathname !== '/ws/price') {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (socket, req) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        let pair = parsedUrl.searchParams.get('pair') || manager.pair;
        let intervalId = null;
        let closed = false;

        const sendPrice = async () => {
            if (closed) {
                return;
            }
            try {
                const latest = await manager.getLatestPrice(pair, { ttl: 10000, force: true });
                socket.send(JSON.stringify({
                    type: 'price',
                    pair,
                    price: latest,
                    timestamp: new Date().toISOString()
                }));
            } catch (error) {
                socket.send(JSON.stringify({
                    type: 'error',
                    message: error.message
                }));
            }
        };

        socket.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                if (payload.pair && typeof payload.pair === 'string' && payload.pair !== pair) {
                    pair = payload.pair;
                    sendPrice();
                }
            } catch (error) {
                socket.send(JSON.stringify({
                    type: 'error',
                    message: 'Invalid message format'
                }));
            }
        });

        socket.on('close', () => {
            closed = true;
            if (intervalId) {
                clearInterval(intervalId);
            }
        });

        sendPrice();
        intervalId = setInterval(sendPrice, 30000);
    });
}

function startServer(manager, port) {
    const server = http.createServer(createRequestHandler(manager));
    setupWebSocket(server, manager);

    server.listen(port, () => {
        console.log(`Kraken bot control server listening on port ${port}`);
    });

    return server;
}

if (require.main === module) {
    program
        .option('--port <number>', 'Port to listen on', (value) => parseInt(value, 10), 3007)
        .option('--pair <pair>', 'Trading pair to monitor', 'XDGUSD')
    .option('--risk <number>', 'Risk percentage', (value) => parseFloat(value), DEFAULT_RISK);

    program.parse(process.argv);
    const options = program.opts();

    const port = Number.isFinite(options.port) ? options.port : 3007;
  const risk = Number.isFinite(options.risk) ? clamp(options.risk, 1, 100) : DEFAULT_RISK;
    const pair = typeof options.pair === 'string' && options.pair ? options.pair : 'XDGUSD';

    const manager = new TradingBotManager({ pair, risk });
    const server = startServer(manager, port);

    const shutdown = async () => {
        console.log('Shutting down server...');
        try {
            await manager.stop();
        } catch (error) {
            console.error('Failed to stop bot cleanly:', error.message);
        }
        server.close(() => {
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = {
    Bot,
    TradingBotManager,
    startServer
};
