class LimitOrders {
    constructor(options = {}) {
        this.options = {
            currentPrice: 0,
            positiveRange: 0,
            negativeRange: 0,
            ordersPerSide: 0,
            usdBalance: 0,
            assetBalance: 0,
            minOrderValue: 0,
            spacingCurve: 0,
            spacingReverse: false,
            valueCurve: 0,
            valueReverse: false,
            ...options
        };
    }

    update(options = {}) {
        this.options = { ...this.options, ...options };
        return this;
    }

    calculate() {
        const {
            currentPrice,
            positiveRange,
            negativeRange,
            ordersPerSide,
            usdBalance,
            assetBalance,
            minOrderValue,
            spacingCurve,
            spacingReverse,
            valueCurve,
            valueReverse
        } = this.options;

        if (!Number.isFinite(currentPrice) || ordersPerSide <= 0) {
            return { buyOrders: [], sellOrders: [] };
        }

        const spacingDistribution = this.#calculateDistribution(spacingCurve, spacingReverse, ordersPerSide);
        const valueDistribution = this.#calculateDistribution(valueCurve, valueReverse, ordersPerSide);

        let accumulatedSpacing = 0;
        const buyOrders = spacingDistribution.map((spacingFraction, index) => {
            accumulatedSpacing += spacingFraction;
            const price = currentPrice - negativeRange * accumulatedSpacing;
            const rawValue = usdBalance * valueDistribution[index];
            const quantity = price > 0 ? rawValue / price : 0;
            return {
                price,
                quantity,
                value: rawValue,
                distance: currentPrice - price,
                status: 'pending'
            };
        });

        accumulatedSpacing = 0;
        const sellOrders = spacingDistribution.map((spacingFraction, index) => {
            accumulatedSpacing += spacingFraction;
            const price = currentPrice + positiveRange * accumulatedSpacing;
            const quantity = assetBalance * valueDistribution[index];
            return {
                price,
                quantity,
                value: quantity * price,
                distance: price - currentPrice,
                status: 'pending'
            };
        });

        const adjustedBuys = this.#applyMinimumOrderValue(buyOrders, usdBalance, minOrderValue, true);
        const adjustedSells = this.#applyMinimumOrderValue(sellOrders, assetBalance, minOrderValue, false)
            .sort((a, b) => b.price - a.price);

        return {
            buyOrders: adjustedBuys,
            sellOrders: adjustedSells
        };
    }

    #calculateDistribution(sliderValue, reverse, count) {
        if (count <= 0) {
            return [];
        }

        if (count === 1) {
            return [1];
        }

        const normalizedSlider = Math.max(0, Math.min(100, sliderValue));
        const exponent = 1 + (normalizedSlider / 100) * 2;

        const distribution = [];
        const denominator = count - 1 || 1;

        for (let i = 0; i < count; i++) {
            const normalizedIndex = i / denominator;
            distribution.push(Math.pow(normalizedIndex, exponent));
        }

        if (reverse) {
            distribution.reverse();
        }

        const sum = distribution.reduce((acc, value) => acc + value, 0);
        if (sum === 0) {
            return Array(count).fill(1 / count);
        }

        return distribution.map(value => value / sum);
    }

    #applyMinimumOrderValue(orders, balance, minOrderValue, isBuy) {
        if (!Number.isFinite(balance) || balance <= 0) {
            return orders.map(order => ({
                ...order,
                value: 0,
                quantity: 0,
                status: order.status
            }));
        }

        if (!Array.isArray(orders) || orders.length === 0) {
            return [];
        }

        const needsAdjustment = orders.some(order => order.value < minOrderValue);
        if (!needsAdjustment || minOrderValue <= 0) {
            return orders;
        }

        const adjusted = orders.map(order => {
            if (order.value >= minOrderValue) {
                return { ...order };
            }

            const adjustedValue = minOrderValue;
            if (isBuy) {
                return {
                    ...order,
                    value: adjustedValue,
                    quantity: order.price > 0 ? adjustedValue / order.price : 0
                };
            }

            const quantity = order.price > 0 ? adjustedValue / order.price : 0;
            return {
                ...order,
                value: adjustedValue,
                quantity
            };
        });

        const aggregate = adjusted.reduce(
            (total, order) => total + (isBuy ? order.value : order.quantity),
            0
        );

        if (aggregate > balance && aggregate > 0) {
            const scale = balance / aggregate;
            return adjusted.map(order => {
                if (isBuy) {
                    const scaledValue = order.value * scale;
                    return {
                        ...order,
                        value: scaledValue,
                        quantity: order.price > 0 ? scaledValue / order.price : 0
                    };
                }

                const scaledQuantity = order.quantity * scale;
                return {
                    ...order,
                    quantity: scaledQuantity,
                    value: scaledQuantity * order.price
                };
            });
        }

        const remaining = balance - aggregate;
        if (remaining <= 0) {
            return adjusted;
        }

        const originalTotal = orders.reduce(
            (total, order) => total + (isBuy ? order.value : order.quantity),
            0
        );

        if (originalTotal <= 0) {
            return adjusted;
        }

        return adjusted.map((order, index) => {
            const original = orders[index];
            const proportion = (isBuy ? original.value : original.quantity) / originalTotal;
            const allocation = remaining * proportion;

            if (isBuy) {
                const updatedValue = order.value + allocation;
                return {
                    ...order,
                    value: updatedValue,
                    quantity: order.price > 0 ? updatedValue / order.price : 0
                };
            }

            const updatedQuantity = order.quantity + allocation;
            return {
                ...order,
                quantity: updatedQuantity,
                value: updatedQuantity * order.price
            };
        });
    }
}

module.exports = LimitOrders;
