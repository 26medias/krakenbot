const Bot = require('./Bot');

class DemoBot extends Bot {
    constructor(options = {}) {
        super({
            dryRun: true,
            autoSubscribeOrderFills: true,
            ...options
        });
        this.shutdownTimer = null;
    }

    async onInit() {
        this.logger.info(`[DemoBot] Initialising for ${this.wsPair}`);
    }

    async onStart() {
        this.logger.info('[DemoBot] Bot started');

        const [ticker, balances] = await Promise.all([
            this.fetchTicker().catch((error) => {
                this.logger.warn(`[DemoBot] Unable to fetch ticker: ${error.message}`);
                return null;
            }),
            this.fetchBalances().catch((error) => {
                this.logger.warn(`[DemoBot] Unable to fetch balances: ${error.message}`);
                return {};
            })
        ]);

        if (ticker) {
            this.logger.info('[DemoBot] Last trade price', ticker.lastTrade || ticker.open || 0);
            this._previewLimitOrder(ticker).catch((error) => {
                this.logger.warn(`[DemoBot] Dry-run order preview failed: ${error.message}`);
            });
        }

        const baseBalance = balances?.[this.baseAsset] || 0;
        const quoteBalance = balances?.[this.quoteAsset] || 0;
        this.logger.info('[DemoBot] Balance snapshot', {
            [this.baseAsset]: baseBalance,
            [this.quoteAsset]: quoteBalance
        });

        const duration = this.options.demoDurationMs || 20_000;
        this.shutdownTimer = setTimeout(() => {
            this.logger.info('[DemoBot] Demo duration reached, stopping');
            this.stop().catch((error) => {
                this.logger.error(`Failed to stop demo bot: ${error.message}`);
            });
        }, duration);
    }

    async onPriceUpdate(priceData, meta) {
        const last = priceData?.close ?? priceData?.last ?? 'n/a';
        const flag = meta.thresholdTriggered ? 'warn threshold' : 'tick';
        this.logger.info(`[DemoBot] ${flag} ${priceData.symbol} close=${last}`);
    }

    async onOrderFill(details) {
        this.logger.info('[DemoBot] Limit fill event received', details);
    }

    async onStop() {
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
        }
        this.logger.info('[DemoBot] Bot stopped');
    }

    async _previewLimitOrder(ticker) {
        if (!ticker?.lastTrade) {
            return;
        }

        const basePrice = ticker.lastTrade;
        const previewPrice = this.applyPricePrecision(basePrice * 0.99);
        const volume = this.minimumVolume > 0 ? this.minimumVolume : 1;

        const response = await this.limitBuy(previewPrice, volume, {
            timeinforce: 'GTC'
        });
        this.logger.info('[DemoBot] Dry-run limit buy response', response);
    }
}

(async () => {
    const bot = new DemoBot({
        pair: 'XDGUSD',
        priceInterval: 1,
        priceChangeThreshold: 0.1,
        demoDurationMs: 20_000
    });

    const shutdown = async (signal) => {
        bot.logger.info(`[DemoBot] Caught ${signal}, shutting down`);
        try {
            await bot.stop();
        } finally {
            process.exit(0);
        }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await bot.start();
    } catch (error) {
        bot.logger.error(`[DemoBot] Failed to start: ${error.message}`);
        process.exitCode = 1;
    }
})();
