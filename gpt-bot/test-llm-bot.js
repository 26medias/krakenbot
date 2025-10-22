const LLMBot = require('./llm-bot');

function mockDecisionEngine(payload) {
    const { confluence = {}, regime = {} } = payload;
    const score = Number(confluence.score ?? 0);
    const trend = regime.trend || 'neutral';

    if (trend === 'bull' && score >= 3) {
        return {
            action: 'OPEN_LONG',
            size_pct: 25,
            entry: { type: 'limit', offset_bps: -5 },
            stop_atr: 1.2,
            tp_atr: 2.5,
            followups: ['MOVE_STOP: breakeven on +1.0R'],
            comment: 'Bull trend with strong confluence.'
        };
    }

    if (score <= -3) {
        return {
            action: 'CLOSE_ALL',
            comment: 'Bearish confluence, flatten exposure.'
        };
    }

    return {
        action: 'HOLD',
        comment: 'No high conviction setup.'
    };
}

(async () => {
    const useMockDecision = process.env.USE_MOCK_DECISION === '1';

    const bot = new LLMBot({
        pair: 'XDGUSD',
        dryRun: true,
        verbose: true,
        ...(useMockDecision ? { llm: { mockDecision: mockDecisionEngine } } : {}),
        risk: {
            maxTradeRiskPct: 0.75,
            maxTotalRiskPct: 1.5,
            minNotional: 20,
            defaultSizePct: 25
        },
        eventEngine: {
            thresholds: {
                confluenceDelta: 2
            }
        }
    });

    if (useMockDecision) {
        bot.logger.info('[LLMBot] Using mock decision engine (USE_MOCK_DECISION=1)');
    } else {
        bot.logger.info('[LLMBot] Using live LLM decisions');
    }

    const shutdown = async (signal) => {
        bot.logger.info(`[LLMBot] Received ${signal}, shutting down`);
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
        bot.logger.error(`[LLMBot] Failed to start: ${error.message}`);
        process.exitCode = 1;
    }
})();
