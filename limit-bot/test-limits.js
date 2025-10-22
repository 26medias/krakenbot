#!/usr/bin/env node

const LimitOrders = require('./LimitOrders');

const uiSettings = {
    pair: 'XDGUSD',
    currentPrice: 0.189405,
    positiveRangePercent: 15,
    negativeRangePercent: 15,
    ordersPerSide: 10,
    usdBalance: 1000,
    assetBalance: 4920,
    minOrderValue: 5,
    spacingSpread: 0.53,
    spacingReverse: false,
    spacingMarginLeftPercent: 0,
    spacingMarginRightPercent: 2,
    valueSpread: -0.14,
    valueMarginLeftPercent: 20,
    valueMarginRightPercent: 0
};

const params = {
    currentPrice: uiSettings.currentPrice,
    positiveRange: uiSettings.currentPrice * uiSettings.positiveRangePercent / 100,
    negativeRange: uiSettings.currentPrice * uiSettings.negativeRangePercent / 100,
    ordersPerSide: uiSettings.ordersPerSide,
    usdBalance: uiSettings.usdBalance,
    assetBalance: uiSettings.assetBalance,
    minOrderValue: uiSettings.minOrderValue,
    spacingSpread: uiSettings.spacingSpread,
    spacingReverse: uiSettings.spacingReverse,
    spacingMarginLeftPercent: uiSettings.spacingMarginLeftPercent,
    spacingMarginRightPercent: uiSettings.spacingMarginRightPercent,
    valueSpread: uiSettings.valueSpread,
    valueMarginLeftPercent: uiSettings.valueMarginLeftPercent,
    valueMarginRightPercent: uiSettings.valueMarginRightPercent
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

function calculatePointPositions(count, spread, marginLeftPercent, marginRightPercent) {
    const positions = [];
    const marginLeftNorm = marginLeftPercent / 100;
    const marginRightNorm = marginRightPercent / 100;
    const effectiveWidth = 1 - marginLeftNorm - marginRightNorm;

    if (count <= 0) return [];
    if (count === 1) {
        positions.push(marginLeftNorm + effectiveWidth / 2);
        return positions;
    }

    for (let i = 0; i < count; i++) {
        let position;
        const baseIndex = i / (count - 1);

        if (spread === 0) {
            position = baseIndex * effectiveWidth;
        } else if (spread < 0) {
            const exponent = 1 + Math.abs(spread) * 2;
            const normalizedPos = Math.pow(baseIndex, exponent);
            position = normalizedPos * effectiveWidth;
        } else {
            const exponent = 1 + spread * 2;
            const normalizedPos = 1 - Math.pow(1 - baseIndex, exponent);
            position = normalizedPos * effectiveWidth;
        }

        position += marginLeftNorm;
        position = Math.max(0, Math.min(1, position));
        positions.push(position);
    }

    return positions;
}

function calculateExpectedOrders(settings) {
    const {
        currentPrice,
        positiveRange,
        negativeRange,
        ordersPerSide,
        usdBalance,
        assetBalance,
        spacingSpread,
        spacingMarginLeftPercent,
        spacingMarginRightPercent,
        valueSpread,
        valueMarginLeftPercent,
        valueMarginRightPercent
    } = settings;

    const spacingPositions = calculatePointPositions(
        ordersPerSide,
        spacingSpread,
        spacingMarginLeftPercent,
        spacingMarginRightPercent
    );

    const valuePositions = calculatePointPositions(
        ordersPerSide,
        valueSpread,
        valueMarginLeftPercent,
        valueMarginRightPercent
    );

    const buyWeights = [...valuePositions].reverse();
    const sellWeights = [...valuePositions].reverse();
    const totalBuyWeight = buyWeights.reduce((sum, weight) => sum + weight, 0) || 1;
    const totalSellWeight = sellWeights.reduce((sum, weight) => sum + weight, 0) || 1;
    const totalSellValueUsd = assetBalance * currentPrice;

    const buyOrdersExpected = spacingPositions.map((position, index) => {
        const price = currentPrice - negativeRange + (negativeRange * position);
        const weight = buyWeights[index] ?? 0;
        const value = (weight / totalBuyWeight) * usdBalance;
        const quantity = price > 0 ? value / price : 0;
        return { price, quantity, value };
    });

    const sellOrdersExpected = spacingPositions.map((position, index) => {
        const mirrored = Math.max(0, Math.min(1, 1 - position));
        const price = currentPrice + positiveRange * mirrored;
        const weight = sellWeights[index] ?? 0;
        const value = (weight / totalSellWeight) * totalSellValueUsd;
        const quantity = price > 0 ? value / price : 0;
        return { price, quantity, value };
    });

    return { buyOrdersExpected, sellOrdersExpected };
}

console.log(`Buy orders generated: ${buyOrders.length}`);
console.log(`Sell orders generated: ${sellOrders.length}`);

expect(buyOrders.length === params.ordersPerSide, 'Buy order count mismatch');
expect(sellOrders.length === params.ordersPerSide, 'Sell order count mismatch');

const totalBuyValue = buyOrders.reduce((sum, order) => sum + order.value, 0);
const totalSellValue = sellOrders.reduce((sum, order) => sum + order.value, 0);

expect(isClose(totalBuyValue, params.usdBalance, 1e-6), 'Total buy value does not equal USD balance');
expect(isClose(totalSellValue, params.assetBalance * params.currentPrice, 1e-6), 'Total sell value does not equal expected USD value');

const { buyOrdersExpected, sellOrdersExpected } = calculateExpectedOrders(params);

buyOrders.forEach((order, index) => {
    const expected = buyOrdersExpected[index];
    expect(isClose(order.price, expected.price, 1e-6), `Buy price mismatch at index ${index}`);
    expect(isClose(order.quantity, expected.quantity, 1e-6), `Buy quantity mismatch at index ${index}`);
    expect(isClose(order.value, expected.value, 1e-6), `Buy value mismatch at index ${index}`);
});

sellOrders.forEach((order, index) => {
    const expected = sellOrdersExpected[index];
    expect(isClose(order.price, expected.price, 1e-6), `Sell price mismatch at index ${index}`);
    expect(isClose(order.quantity, expected.quantity, 1e-6), `Sell quantity mismatch at index ${index}`);
    expect(isClose(order.value, expected.value, 1e-6), `Sell value mismatch at index ${index}`);
});

console.log('All checks passed.');
