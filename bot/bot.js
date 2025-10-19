const KrakenMonitor = require('./KrakenMonitor');
const LimitOrders = require('./LimitOrders');
const DataTools = require('./DataTools');
const Data = require('./Data');
const fs = require('fs');
const path = require('path');


class Bot {
    constructor(pair, risk=70, options = {}) {
        this.pairName = pair;
        this.risk = risk;
        this.options = options;
        this.tools = new DataTools(pair);
        this.Data = new Data();
        this.monitor = new KrakenMonitor();
        this.subscriptions = {};
        this.busy = false;
    }

    async init() {
        let scope = this;
        const pairs = await this.Data.getTradablePairs();
        const data = Object.values(pairs).map(item => {
            return {
                ...item,
                fees: item.fees[0][1],
                fees_maker: item.fees_maker[0][1],
            };
        })
        this.pair = data.filter(item => item.altname == this.pairName)
        if (!this.pair) {
            throw new Error(`Trading pair ${this.pairName} not found`);
        }

        this.subscriptions.limitFill = this.monitor.onLimitOrderFill(async (orderDetails) => {
            console.log('Limit order fill update:', orderDetails);
            await scope.onRebalance(orderDetails);
        });

        // Check for intial state
        const orderCount = await this.countOpenLimitOrders();
        console.log(`${orderCount.total} open orders (Buy: ${orderCount.buy}, Sell: ${orderCount.sell})`);
        if (orderCount.buy == 0 || orderCount.sell == 0) {
            console.log('One side has no orders, recreating full set of limit orders');
            await this.resetLimitOrders();
            const limitOrders = await this.calculateLimitRanges();
            await this.createLimitOrders(limitOrders.buyOrders, limitOrders.sellOrders);
            return;
        }
    }

    async createInitialState() {
        const range = await this.calculateLimitRanges();
        console.log(JSON.stringify(range, null, 4));
        await this.createLimitOrders(range.buyOrders, range.sellOrders);
    }

    async shutdown() {
        this.subscriptions?.limitFill?.unsubscribe();
        await this.monitor.close();
    }

    async balance() {
        const balances = await this.Data.getBalance();
        const balanceBase = balances[this.pair[0].base] || 0;
        const balanceQuote = balances[this.pair[0].quote] || 0;
        return {
            base: balanceBase,
            quote: balanceQuote
        };
    }

    async calculateLimitRanges(positiveRange, negativeRange) {
        //console.log("calculateLimitRanges()", {positiveRange, negativeRange});
        const latest = await this.tools.getprice();
        console.log('Current price:', `$${latest.c.toFixed(5)}`);

        const diffMul = 3;

        const range = await this.tools.getPriceRange(120);
        const rangeDif = parseFloat((range.high - range.low).toFixed(6));
        const rawPctRange = parseFloat((((rangeDif * diffMul) / latest.c) * 100).toFixed(2));
        const DEFAULT_RANGE_PERCENT = 20;
        const pctRange = Number.isFinite(rawPctRange) && rawPctRange > 0 ? rawPctRange : DEFAULT_RANGE_PERCENT;
        console.log('pctRange:', pctRange);

        const balance = await this.balance();
        //console.log('Balance:', balance);

        const toPercentOfPrice = (value, fallbackPercent) => {
            if (!Number.isFinite(value) || value <= 0) {
                return fallbackPercent;
            }
            return parseFloat(((value / latest.c) * 100).toFixed(2));
        };

        // Temp for testing. Do not change.
        const positiveRangePercent = toPercentOfPrice(positiveRange, pctRange);
        const negativeRangePercent = toPercentOfPrice(negativeRange, pctRange);

        const params = {
            currentPrice: latest.c,
            positiveRange: latest.c * positiveRangePercent / 100,
            negativeRange: latest.c * negativeRangePercent / 100,
            ordersPerSide: 10,
            usdBalance: parseFloat((parseFloat(balance.quote) * this.risk / 100).toFixed(6)),
            assetBalance: parseFloat((parseFloat(balance.base) * this.risk / 100).toFixed(6)),
            minOrderValue: 5,
            spacingSpread: 0.53,
            spacingReverse: false,
            spacingMarginLeftPercent: 0,
            spacingMarginRightPercent: 3,
            valueSpread: -0.14,
            valueMarginLeftPercent: 20,
            valueMarginRightPercent: 0,
        };
        //console.log(JSON.stringify(params, null, 4));

        const { buyOrders, sellOrders } = new LimitOrders(params).calculate();

        let sum_quote = 0;
        let sum_base = 0;
        buyOrders.forEach(order => {
            sum_quote += order.value;
        });
        sellOrders.forEach(order => {
            sum_base += order.quantity;
        });
        sellOrders.reverse();

        return { buyOrders, sellOrders, sum_base, sum_quote }
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

        const orderCount = await this.countOpenLimitOrders();
        console.log(`Rebalance check: ${orderCount.total} open orders (Buy: ${orderCount.buy}, Sell: ${orderCount.sell})`);

        if (orderCount.buy == 0 || orderCount.sell == 0) {
            console.log('One side has no orders, recreating full set of limit orders');
            await this.resetLimitOrders();
            const limitOrders = await this.calculateLimitRanges();
            await this.createLimitOrders(limitOrders.buyOrders, limitOrders.sellOrders);
        } else {

            const openOrders = await this.getOpenOrders();
            const sellOrders = openOrders.filter(order => order.descr.type === 'sell');
            const buyOrders = openOrders.filter(order => order.descr.type === 'buy');
            const lowestBuyOrder = buyOrders.reduce((minOrder, order) => {
                const price = parseFloat(order.descr.price);
                return (minOrder === null || price < parseFloat(minOrder.descr.price)) ? order : minOrder;
            }, null);
            const highestSellOrder = sellOrders.reduce((maxOrder, order) => {
                const price = parseFloat(order.descr.price);
                return (maxOrder === null || price > parseFloat(maxOrder.descr.price)) ? order : maxOrder;
            }, null);

            const latest = await this.tools.getprice();

            //console.log('Latest price:', latest.c);
            //console.log('Lowest buy price:', lowestBuyOrder);
            //console.log('Highest sell price:', highestSellOrder);

            const rangeUp = parseFloat(highestSellOrder.descr.price)-latest.c; // wrong?
            const rangeDown = latest.c-parseFloat(lowestBuyOrder.descr.price); // wrong?

            const limitOrders = await this.calculateLimitRanges(rangeUp, rangeDown);
            
            if (event.side == 'buy') {
                // Delete all order above close
                console.log("-- Delete all SELL order above close --")
                //console.log(JSON.stringify(limitOrders.sellOrders, null, 4));
                await this.cancelLimitOrdersByPrice(latest.c, 'gt');
                await this.createLimitOrders([], limitOrders.sellOrders);
            } else if (event.side == 'sell') {
                console.log("-- Delete all BUY order below close --")
                //console.log(JSON.stringify(limitOrders.buyOrders, null, 4));
                // Delete all order below close
                await this.cancelLimitOrdersByPrice(latest.c, 'lt');
                await this.createLimitOrders(limitOrders.buyOrders, []);
            }
        }
        this.busy = false;
    }

    async getOpenOrders() {
        // List the open orders
        let openOrders = await this.Data.getOpenOrders();

        // Filter & reformat the orders as an array
        const orderIds = Object.keys(openOrders.open);
        let orders = orderIds.map(key => {
            return {
                id: key,
                ...openOrders.open[key]
            };
        }).filter(item => {
            return item.descr.pair == this.pairName;
        })

        return orders;
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
        // List the open orders
        let orders = await this.getOpenOrders();

        // Cancel all the orders
        for (const order of orders) {
            console.log(`Cancelling order ${order.id} at price ${order.descr.price}`);
            await this.Data.cancelOrder(order.id);
        }

        console.log("Waiting for orders to settle and balance to update...")
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
        console.log(`Creating ${buyOrders.length} buy orders and ${sellOrders.length} sell orders`);
        // Display the orders:
        buyOrders.forEach((order, index) => {
            console.log(`  BUY  ${index + 1}: Price=${order.price.toFixed(6)} Qty=${order.quantity.toFixed(6)} Value=${order.value.toFixed(6)}`);
        });
        sellOrders.forEach((order, index) => {
            console.log(`  SELL ${index + 1}: Price=${order.price.toFixed(6)} Qty=${order.quantity.toFixed(6)} Value=${order.value.toFixed(6)}`);
        });
        // Display dum of quote & base
        let sellStats = {base: 0, quote: 0};
        sellOrders.forEach(order => {
            sellStats.base += order.quantity;
            sellStats.quote += order.value;
        });
        let buyStats = {base: 0, quote: 0};
        buyOrders.forEach(order => {
            buyStats.base += order.quantity;
            buyStats.quote += order.value;
        });
        console.log(`Total BUY orders: Qty=${buyStats.base.toFixed(6)} Value=${buyStats.quote.toFixed(6)}`);
        console.log(`Total SELL orders: Qty=${sellStats.base.toFixed(6)} Value=${sellStats.quote.toFixed(6)}`);
        //
        //return
        const pairInfo = Array.isArray(this.pair) ? this.pair[0] : null;
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

/*
Example limit order fill message via subscription:
{
    order_id: 'OARW6S-EMZQH-BMZLKV',
    exec_id: 'TNFP4V-SMXUD-CVHYUF',
    exec_type: 'trade',
    trade_id: 21529853,
    symbol: 'DOGE/USD',
    side: 'buy',
    last_qty: 126.163729,
    last_price: 0.183925,
    liquidity_ind: 'm',
    cost: 23.204663856,
    order_userref: 0,
    order_status: 'filled',
    order_type: 'limit',
    fee_usd_equiv: 0.05801166,
    fees: [ { asset: 'USD', qty: 0.05801166 } ],
    timestamp: '2025-10-17T06:36:43.801807Z',
    channel_type: 'snapshot'
}
*/

/*
Example open limit order format (from getOpenOrders):
{
    "id": "OU73PP-MTH5Y-2FP6GN",
    "refid": null,
    "userref": 0,
    "status": "open",
    "opentm": 1760738484.924435,
    "starttm": 0,
    "expiretm": 0,
    "descr": {
        "pair": "XDGUSD",
        "aclass": "forex",
        "type": "buy",
        "ordertype": "limit",
        "price": "0.1856119",
        "price2": "0",
        "leverage": "none",
        "order": "buy 966.21284415 XDGUSD @ limit 0.1856119",
        "close": ""
    },
    "vol": "966.21284415",
    "vol_exec": "0.00000000",
    "cost": "0.000000000",
    "fee": "0.000000000",
    "price": "0.000000000",
    "stopprice": "0.000000000",
    "limitprice": "0.000000000",
    "misc": "",
    "oflags": "fciq"
}
*/

(async () => {
    const bot = new Bot('MLNUSD', 10);
    await bot.init();
    //await bot.resetLimitOrders();

    process.on('SIGINT', () => {
        bot.shutdown();
    });
    process.on('SIGTERM', () => {
        bot.shutdown();
    });
})();
