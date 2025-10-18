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
            spacingSpread: undefined,
            spacingMarginLeftPercent: 0,
            spacingMarginRightPercent: 0,
            valueCurve: 0,
            valueReverse: false,
            valueSpread: undefined,
            valueMarginLeftPercent: 0,
            valueMarginRightPercent: 0,
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
            spacingSpread,
            spacingMarginLeftPercent,
            spacingMarginRightPercent,
            valueCurve,
            valueReverse,
            valueSpread,
            valueMarginLeftPercent,
            valueMarginRightPercent
        } = this.options;

        if (!Number.isFinite(currentPrice) || ordersPerSide <= 0) {
            return { buyOrders: [], sellOrders: [] };
        }

        const spacingSpreadNormalized = this.#normalizeSpread(spacingSpread ?? spacingCurve, spacingReverse) ?? 0;
        const marginLeft = this.#sanitizeMargin(spacingMarginLeftPercent);
        const marginRight = this.#sanitizeMargin(spacingMarginRightPercent, 100 - marginLeft);
        const spacingPositions = this.calculatePointPositions(
            ordersPerSide,
            spacingSpreadNormalized,
            marginLeft,
            marginRight
        );

        const negativeRangeClamped = Number.isFinite(negativeRange) ? Math.max(0, negativeRange) : 0;
        const positiveRangeClamped = Number.isFinite(positiveRange) ? Math.max(0, positiveRange) : 0;

        const {
            buyWeights,
            sellWeights
        } = this.#calculateValueWeights({
            count: ordersPerSide,
            spreadInput: valueSpread ?? valueCurve,
            reverse: valueReverse,
            marginLeftPercent: valueMarginLeftPercent,
            marginRightPercent: valueMarginRightPercent
        });

        const totalBuyWeight = buyWeights.reduce((sum, weight) => sum + weight, 0) || 0;
        const totalSellWeight = sellWeights.reduce((sum, weight) => sum + weight, 0) || 0;
        const totalSellValueUsd = assetBalance * currentPrice;

        const buyOrders = spacingPositions.map((position, index) => {
            const normalizedPosition = this.#clamp(position, 0, 1);
            const price = currentPrice - negativeRangeClamped + (negativeRangeClamped * normalizedPosition);
            const weight = buyWeights[index] ?? 0;
            const rawValue = totalBuyWeight > 0 ? (weight / totalBuyWeight) * usdBalance : 0;
            const quantity = price > 0 ? rawValue / price : 0;
            return {
                price,
                quantity,
                value: rawValue,
                distance: currentPrice - price,
                status: 'pending'
            };
        });

        const sellOrders = spacingPositions.map((position, index) => {
            const normalizedPosition = this.#clamp(1 - this.#clamp(position, 0, 1), 0, 1);
            const price = currentPrice + positiveRangeClamped * normalizedPosition;
            const weight = sellWeights[index] ?? 0;
            const rawValue = totalSellWeight > 0 ? (weight / totalSellWeight) * totalSellValueUsd : 0;
            const quantity = price > 0 ? rawValue / price : 0;
            return {
                price,
                quantity,
                value: rawValue,
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

    calculatePointPositions(count, spread /*-1 to 1*/, marginLeftPercent, marginRightPercent) {
        const positions = [];

        // Convert percentage margins to normalized values (0-1)
        const marginLeftNorm = marginLeftPercent / 100;
        const marginRightNorm = marginRightPercent / 100;

        // Calculate the effective width where points can be placed
        const effectiveWidth = 1 - marginLeftNorm - marginRightNorm;

        // Handle edge cases for count
        if (count <= 0) {
            return [];
        }
        if (count === 1) {
            // The single point is in the center of the effective area
            positions.push(marginLeftNorm + effectiveWidth / 2);
            return positions;
        }

        // Loop to calculate positions for each point
        for (let i = 0; i < count; i++) {
            let position;

            // The base index for the current point, from 0 to 1
            const baseIndex = i / (count - 1);

            if (spread === 0) {
                // Even spacing across the effective width
                position = baseIndex * effectiveWidth;
            } else if (spread < 0) {
                // Exponential from left
                // The exponent amplifies the effect. A more negative spread means a stronger exponent.
                const exponent = 1 + Math.abs(spread) * 2;
                const normalizedPos = Math.pow(baseIndex, exponent);
                position = normalizedPos * effectiveWidth;
            } else { // spread > 0
                // Exponential from right
                const exponent = 1 + spread * 2;
                // We invert the logic (1 - ...) to make it exponential from the right
                const normalizedPos = 1 - Math.pow(1 - baseIndex, exponent);
                position = normalizedPos * effectiveWidth;
            }

            // Add the left margin offset to get the final position
            position += marginLeftNorm;

            // Clamp the value to be strictly within the 0-1 range
            position = Math.max(0, Math.min(1, position));

            positions.push(position);
        }

        return positions;
    }

    #calculateValueWeights({
        count,
        spreadInput,
        reverse,
        marginLeftPercent,
        marginRightPercent
    }) {
        if (count <= 0) {
            return { buyWeights: [], sellWeights: [] };
        }

        const normalizedSpread = this.#normalizeSpread(spreadInput, reverse);

        if (Number.isFinite(normalizedSpread)) {
            const marginLeft = this.#sanitizeMargin(marginLeftPercent);
            const marginRight = this.#sanitizeMargin(marginRightPercent, 100 - marginLeft);
            const positions = this.calculatePointPositions(count, normalizedSpread, marginLeft, marginRight);
            const weights = [...positions].reverse();
            return {
                buyWeights: weights,
                sellWeights: [...weights]
            };
        }

        const fallback = this.#calculateDistribution(spreadInput ?? 0, reverse, count);
        return {
            buyWeights: fallback,
            sellWeights: [...fallback]
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

    #clamp(value, min, max) {
        if (!Number.isFinite(value)) {
            return min;
        }
        return Math.min(max, Math.max(min, value));
    }

    #normalizeSpread(spreadInput, reverseFlag) {
        let spread = Number(spreadInput);
        if (!Number.isFinite(spread)) {
            return null;
        }

        if (Math.abs(spread) > 1) {
            if (Math.abs(spread) <= 100) {
                spread = spread / 100;
            } else {
                spread = spread > 0 ? 1 : -1;
            }
        }

        spread = this.#clamp(spread, -1, 1);

        if (reverseFlag) {
            spread = -spread;
        }

        return spread;
    }

    #sanitizeMargin(input, max = 100) {
        let margin = Number(input);
        if (!Number.isFinite(margin)) {
            margin = 0;
        }
        margin = this.#clamp(margin, 0, max);
        return margin;
    }
}

module.exports = LimitOrders;
