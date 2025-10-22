const Bot = require('./Bot');
const FeatureBuilder = require('./libs/FeatureBuilder');
const EventEngine = require('./libs/EventEngine');
const LLMDecider = require('./libs/LLMDecider');
const ExecutionEngine = require('./libs/ExecutionEngine');
const DecisionLogger = require('./libs/DecisionLogger');

class StatusReporter {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
            ? options.intervalMs
            : 30_000;
        this.pair = options.pair || null;

        this.lastPrice = null;
        this.lastSymbol = options.pair || null;
        this.lastBalances = null;
        this.lastLogTime = 0;
    }

    updatePrice(priceData) {
        const price = this.#extractPrice(priceData);
        if (Number.isFinite(price)) {
            this.lastPrice = price;
        }
        const symbol = priceData?.symbol || priceData?.pair;
        if (symbol) {
            this.lastSymbol = symbol;
        }
        if (Date.now() - this.lastLogTime >= this.intervalMs) {
            this.#log('heartbeat');
        }
    }

    reportStatus({ price, balances, source } = {}) {
        if (Number.isFinite(price)) {
            this.lastPrice = price;
        }
        if (balances) {
            this.lastBalances = { ...balances };
        }

        const force = source === 'event' || source === 'balance';
        if (force || (Date.now() - this.lastLogTime >= this.intervalMs)) {
            this.#log(source || (force ? source : 'heartbeat'));
        }
    }

    #log(source = 'heartbeat') {
        const symbol = this.lastSymbol || this.pair || 'n/a';
        const price = Number.isFinite(this.lastPrice) ? this.lastPrice : 'n/a';
        const quote = this.#formatBalance(this.lastBalances?.quote);
        const base = this.#formatBalance(this.lastBalances?.base);
        this.logger.info(`[LLMBot] Status (${source}) ${symbol} price=${price} quote=${quote} base=${base}`);
        this.lastLogTime = Date.now();
    }

    #formatBalance(value) {
        if (value === null || value === undefined) {
            return 'n/a';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (Number.isFinite(value)) {
            return Number(value.toFixed(6));
        }
        return String(value);
    }

    #extractPrice(priceData = {}) {
        const candidates = [
            priceData.close,
            priceData.last,
            priceData.price,
            priceData.c
        ];
        for (const candidate of candidates) {
            const numeric = Number(candidate);
            if (Number.isFinite(numeric)) {
                return numeric;
            }
        }
        return null;
    }
}

class LLMBot extends Bot {
    constructor(options = {}) {
        const monitorOptions = {
            pingIntervalMs: options.pingIntervalMs || 15_000,
            ...(options.monitorOptions || {})
        };
        super({
            pair: 'XDGUSD',
            priceInterval: 1,
            autoSubscribeOrderFills: true,
            priceChangeThreshold: 0.35,
            monitorOptions,
            ...options
        });

        this.verbose = Boolean(options.verbose);

        this.featureBuilder = new FeatureBuilder({
            pair: this.restPair,
            dataClient: this.data,
            logger: this.logger,
            ...(options.featureBuilder || {})
        });

        this.statusReporter = new StatusReporter({
            logger: this.logger,
            intervalMs: options.statusIntervalMs || 30_000,
            pair: this.wsPair
        });

        this.manualEvaluationIntervalMs = Number.isFinite(options.evaluationIntervalMs) && options.evaluationIntervalMs > 0
            ? options.evaluationIntervalMs
            : 300_000; // default 5 minutes
        this._evaluationTimer = null;

        this.eventEngine = new EventEngine({
            logger: this.logger,
            verbose: this.verbose,
            ...(options.eventEngine || {})
        });

        this.llmDecider = new LLMDecider({
            logger: this.logger,
            ...(options.llm || {})
        });

        this.execution = new ExecutionEngine({
            bot: this,
            logger: this.logger,
            risk: options.risk || {},
            statusLogger: this.statusReporter
        });

        this.decisionLogger = new DecisionLogger({
            filePath: options.decisionLogPath,
            logger: this.logger
        });

        this.processing = false;
        this.orderBookSubscription = null;

        if (this.verbose) {
            this.logger.info('[LLMBot] Verbose logging enabled');
        }
    }

    logVerbose(message, meta) {
        if (!this.verbose) {
            return;
        }
        if (meta !== undefined) {
            this.logger.info(`[LLMBot] ${message}`, meta);
        } else {
            this.logger.info(`[LLMBot] ${message}`);
        }
    }

    async onInit() {
        this.logger.info('[LLMBot] Initialising bot with LLM decision loop');
        try {
            // Prime order book snapshots so FeatureBuilder can include micro-structure inputs.
            this.orderBookSubscription = this.watchOrderBook(
                (book) => {
                    this.featureBuilder.setOrderBookSnapshot(book);
                },
                { depth: 5 }
            );
            this.logVerbose('Order book subscription established');
        } catch (error) {
            this.logger.warn(`[LLMBot] Failed to subscribe to order book: ${error.message}`);
        }
        try {
            await this.execution.ensureBalanceSnapshot(true);
        } catch (error) {
            this.logger.warn(`[LLMBot] Unable to preload balances: ${error.message}`);
        }

        try {
            await this.triggerEvaluation(['Startup'], { source: 'startup' });
        } catch (error) {
            this.logger.warn(`[LLMBot] Startup evaluation failed: ${error.message}`);
        }

        if (this.manualEvaluationIntervalMs > 0) {
            this._evaluationTimer = setInterval(() => {
                this.triggerEvaluation(['Periodic'], { source: 'interval' }).catch((error) => {
                    this.logger.warn(`[LLMBot] Periodic evaluation failed: ${error.message}`);
                });
            }, this.manualEvaluationIntervalMs);
            if (typeof this._evaluationTimer.unref === 'function') {
                this._evaluationTimer.unref();
            }
        }
    }

    async onPriceUpdate(priceData, meta) {
        this.logVerbose('Received price update', {
            interval: priceData?.interval,
            symbol: priceData?.symbol,
            thresholdTriggered: Boolean(meta?.thresholdTriggered)
        });

        // Feed the latest candle to the feature builder for rolling metrics (z-scores, ATR, etc.).
        this.featureBuilder.setLatestPrice(priceData);
        this.statusReporter?.updatePrice(priceData);

        // Skip unless a bar close, threshold spike, or pending debounced trigger requires evaluation.
        if (!this.eventEngine.shouldEvaluate(priceData, meta)) {
            this.logVerbose('Debounced price update - awaiting trigger');
            return;
        }

        await this._runEvaluationCycle({ meta });
    }

    async onOrderFill(details) {
        // Reconcile fills so local position state and guardrails stay in sync with the exchange.
        this.logVerbose('Order fill received', details);
        this.execution.handleFill(details);
    }

    async onStop() {
        if (this.orderBookSubscription && typeof this.orderBookSubscription.unsubscribe === 'function') {
            try {
                this.orderBookSubscription.unsubscribe();
            } catch (error) {
                this.logger.warn(`[LLMBot] Failed to unsubscribe order book: ${error.message}`);
            }
            this.orderBookSubscription = null;
        }
        // Allow the event engine to forget any coalesced triggers between bot runs.
        this.eventEngine.reset();
        this.logVerbose('Bot stopped and internal state reset');
        if (this._evaluationTimer) {
            clearInterval(this._evaluationTimer);
            this._evaluationTimer = null;
        }
    }

    async triggerEvaluation(reasons = ['Manual'], meta = {}) {
        await this._runEvaluationCycle({ meta, reasonsOverride: reasons });
    }

    async _runEvaluationCycle({ meta = {}, reasonsOverride = null } = {}) {
        if (this.processing) {
            this.logVerbose('Skipping evaluation because previous cycle is still running');
            return;
        }

        this.processing = true;
        try {
            const featureSnapshot = await this.featureBuilder.build({
                position: this.execution.getPosition(),
                risk: this.execution.getRiskState()
            });
            this.logVerbose('Feature snapshot built', {
                confluence: featureSnapshot?.confluence,
                regime: featureSnapshot?.regime
            });

            await this.execution.ensureBalanceSnapshot();

            this.execution.updateMarketContext(featureSnapshot);

            const engineReasons = this.eventEngine.detect(featureSnapshot, meta);
            const reasons = Array.isArray(reasonsOverride) && reasonsOverride.length > 0
                ? Array.from(new Set([...(engineReasons || []), ...reasonsOverride]))
                : engineReasons;

            if (!Array.isArray(reasons) || reasons.length === 0) {
                this.logVerbose('No actionable event reasons detected');
                return;
            }

            this.logger.info('[LLMBot] Trigger reasons', reasons);

            const decision = await this.llmDecider.decide({
                features: featureSnapshot,
                reasons,
                meta
            });

            this.logger.info('[LLMBot] Decision', decision);
            this.logVerbose('LLM decision payload', decision);

            if (this.decisionLogger) {
                try {
                    await this.decisionLogger.logDecision({
                        timestamp: new Date(),
                        pair: this.wsPair,
                        decision,
                        price: this._resolveSnapshotPrice(featureSnapshot),
                        confluence: featureSnapshot?.confluence,
                        regime: featureSnapshot?.regime,
                        reasons,
                        dryRun: Boolean(this.options?.dryRun)
                    });
                } catch (error) {
                    this.logger.warn(`[LLMBot] Failed to record decision: ${error.message}`);
                }
            }

            const balancesSnapshot = this.execution.getLastBalances
                ? this.execution.getLastBalances()
                : null;
            this.statusReporter?.reportStatus({
                source: 'event',
                price: this._resolveSnapshotPrice(featureSnapshot),
                balances: balancesSnapshot
            });

            await this.execution.execute(decision, {
                features: featureSnapshot,
                reasons,
                meta
            });
        } catch (error) {
            this.logger.error(`[LLMBot] Evaluation failed: ${error.message}`);
        } finally {
            this.processing = false;
        }
    }

    _resolveSnapshotPrice(snapshot) {
        if (!snapshot?.timeframes) {
            return null;
        }
        const preferred = ['1m', '5m', '15m', '1h'];
        for (const key of preferred) {
            const close = snapshot.timeframes[key]?.close;
            if (Number.isFinite(close)) {
                return close;
            }
        }
        for (const frame of Object.values(snapshot.timeframes)) {
            const close = frame?.close;
            if (Number.isFinite(close)) {
                return close;
            }
        }
        return null;
    }
}

module.exports = LLMBot;
