const Level2Logger = require('./Level2Logger');

(async () => {
    const logger = new Level2Logger({ pair: ['DOGE/USD'], distance: 20 });
    await logger.init();

    const shutdown = async () => {
        await logger.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
})().catch((error) => {
    console.error(`Failed to start Level2Logger: ${error.message}`);
    process.exit(1);
});
