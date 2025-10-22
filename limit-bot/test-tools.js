const DataTools = require('./DataTools');

(async () => {
    const tools = new DataTools('DOGEUSD');

    try {
        const latest = await tools.getprice();
        console.log('Latest candle:', latest);

        const range = await tools.getPriceRange(60);
        console.log('60 minute range:', {
            ...range,
            diff: range.high - range.low
        });

        const volatility = await tools.getVolatilityRange(60, 5);
        console.log('Volatility (avg range / variance):', volatility);

        const regression = await tools.getLinearRegression(60);
        console.log('Linear regression slope/intercept:', { slope: regression.slope, intercept: regression.intercept });
        console.log('Regression fit (first & last):', {
            first: { x: regression.x[0], y: regression.y[0] },
            last: { x: regression.x[regression.x.length - 1], y: regression.y[regression.y.length - 1] }
        });

        const marketCycle = await tools.getMarketCycle(60);
        const marketCycleSeries = Array.isArray(marketCycle.MarketCycle) ? marketCycle.MarketCycle.slice(-5) : [];
        console.log('Market cycle last 5 values:', marketCycleSeries);
    } catch (error) {
        console.error('Error running DataTools checks:', error.message);
    }
})();
