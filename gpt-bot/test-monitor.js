const KrakenMonitor = require('./libs/KrakenMonitor');

const monitor = new KrakenMonitor({
    priceMonitoringPeriod: 10
});

/*const subscriptionLimits = monitor.onLimitOrderFill((orderDetails) => {
    console.log('Limit order fill update:', orderDetails);
});*/

const subscriptionPrice = monitor.onPriceChange(
    'DOGE/USD',
    (priceData, thresholdTriggered) => {
        console.log('Ticker update:', priceData);
        if (thresholdTriggered) {
            console.log('Price change exceeded threshold within monitoring period');
        }
    },
    { changeThreshold:  0.1}
);

const shutdown = async () => {
    subscriptionLimits.unsubscribe();
    subscriptionPrice.unsubscribe();
    await monitor.close();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Automatically stop after 60 seconds to avoid indefinite runs when testing.
/*setTimeout(() => {
    console.log('Stopping monitor after 60 seconds');
    shutdown();
}, 60_000);*/
