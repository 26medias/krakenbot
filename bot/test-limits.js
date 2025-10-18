#!/usr/bin/env node

const LimitOrders = require('./LimitOrders');

const params = {
    currentPrice: 0.1824,
    positiveRange: 0.04,
    negativeRange: 0.02,
    ordersPerSide: 20,
    usdBalance: 760,
    assetBalance: 6230,
    minOrderValue: 5,
    spacingCurve: 1,
    spacingReverse: true,
    valueCurve: 1.3,
    valueReverse: false
};

const { buyOrders, sellOrders } = new LimitOrders(params).calculate();

console.log(JSON.stringify({ buyOrders, sellOrders }, null, 4))

function expect(condition, message) {
    if (!condition) {
        throw new Error(`Test failed: ${message}`);
    }
}

function isClose(a, b, tolerance = 1e-6) {
    return Math.abs(a - b) <= tolerance;
}

console.log(`Buy orders generated: ${buyOrders.length}`);
console.log(`Sell orders generated: ${sellOrders.length}`);

expect(buyOrders.length === params.ordersPerSide, 'Buy order count mismatch');
expect(sellOrders.length === params.ordersPerSide, 'Sell order count mismatch');

const totalBuyValue = buyOrders.reduce((sum, order) => sum + order.value, 0);
const totalSellQuantity = sellOrders.reduce((sum, order) => sum + order.quantity, 0);

expect(isClose(totalBuyValue, params.usdBalance, 1e-6), 'Total buy value does not equal USD balance');
expect(isClose(totalSellQuantity, params.assetBalance, 1e-6), 'Total sell quantity does not equal asset balance');

const expectedFirstBuyPrice = 0.1804;
const expectedLastBuyPrice = 0.1624;
const expectedFirstSellPrice = 0.2224;
const expectedLastSellPrice = 0.1864;

expect(isClose(buyOrders[0].price, expectedFirstBuyPrice, 1e-4), 'First buy price mismatch');
expect(isClose(buyOrders[buyOrders.length - 1].price, expectedLastBuyPrice, 1e-4), 'Last buy price mismatch');
expect(isClose(sellOrders[0].price, expectedFirstSellPrice, 1e-4), 'First sell price mismatch');
expect(isClose(sellOrders[sellOrders.length - 1].price, expectedLastSellPrice, 1e-4), 'Last sell price mismatch');

console.log('All checks passed.');
