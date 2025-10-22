const path = require('path');
const GPT5 = require('./GPT5');

class LLMDecider {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.model = options.model || 'gpt-5-mini';
        this.reasoningEffort = options.reasoning || 'minimal';
        this.verbosity = options.verbosity || 'medium';
        this.maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 300;
        this.mockDecision = typeof options.mockDecision === 'function' ? options.mockDecision : null;
        this.disabled = options.disabled || false;

        this.promptPath = options.promptPath
            ? path.resolve(options.promptPath)
            : path.join(__dirname, '..', 'prompts', 'llm-bot-decide.md');

        this.gpt = new GPT5(this.model);
    }

    async decide(input) {
        const reasons = Array.isArray(input?.reasons) ? input.reasons : [];
        if (reasons.length === 0) {
            return this.#defaultDecision('No triggers');
        }

        const features = input?.features || {};
        const payload = this.#buildPayload(features, reasons, input?.meta, input?.constraints);

        if (this.mockDecision) {
            try {
                const mock = await this.mockDecision(payload);
                return this.#normaliseDecision(mock, 'Mock decision');
            } catch (error) {
                this.logger.error(`[LLMDecider] Mock decision failed: ${error.message}`);
                return this.#defaultDecision('Mock failed');
            }
        }

        if (this.disabled) {
            return this.#defaultDecision('LLM disabled');
        }

        try {
            const prompt = this.#buildPrompt(payload);
            const result = await this.gpt.ask(
                prompt,
                this.maxTokens,
                this.reasoningEffort,
                this.verbosity
            );
            const decision = this.#coerceDecision(result?.response);
            return this.#normaliseDecision(decision, 'LLM decision');
        } catch (error) {
            this.logger.error(`[LLMDecider] LLM call failed: ${error.message}`);
            return this.#defaultDecision('LLM error');
        }
    }

    #buildPayload(features, reasons, meta, constraints) {
        return {
            pair: features?.pair || meta?.pair || null,
            reason_for_call: reasons,
            timeframes: features?.timeframes || {},
            htf_anchors: features?.htfAnchors || {},
            orderbook: features?.orderbook || {},
            confluence: features?.confluence || {},
            liquidity: features?.liquidity || {},
            regime: features?.regime || {},
            position: features?.position || {},
            risk: features?.risk || {},
            constraints: constraints || {},
            meta: meta || {}
        };
    }

    #buildPrompt(payload) {
        const reasons = Array.isArray(payload.reason_for_call) && payload.reason_for_call.length > 0
            ? payload.reason_for_call.join(', ')
            : 'None';
        const context = JSON.stringify(payload, null, 2);
        return this.gpt.getPrompt(this.promptPath, {
            pair: payload.pair || 'UNKNOWN',
            reasons,
            context
        });
    }

    #coerceDecision(raw) {
        if (!raw) {
            return null;
        }
        if (typeof raw === 'object') {
            return raw;
        }
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (!trimmed) {
                return null;
            }
            try {
                return JSON.parse(trimmed);
            } catch (error) {
                this.logger.warn(`[LLMDecider] Unable to parse LLM response as JSON: ${error.message}`);
                return null;
            }
        }
        return null;
    }

    #normaliseDecision(decision, source) {
        if (!decision || typeof decision !== 'object') {
            return this.#defaultDecision(`Invalid ${source}`);
        }
        const action = String(decision.action || '').toUpperCase();
        const allowed = new Set(['HOLD', 'OPEN_LONG', 'ADD', 'TRIM', 'CLOSE_PARTIAL', 'CLOSE_ALL', 'MOVE_STOP', 'SET_TP', 'PAUSE']);
        if (!allowed.has(action)) {
            return this.#defaultDecision(`Unsupported action "${decision.action}"`);
        }
        return {
            action,
            size_pct: Number.isFinite(Number(decision.size_pct)) ? Number(decision.size_pct) : null,
            entry: decision.entry || null,
            stop_atr: Number.isFinite(Number(decision.stop_atr)) ? Number(decision.stop_atr) : null,
            tp_atr: Number.isFinite(Number(decision.tp_atr)) ? Number(decision.tp_atr) : null,
            followups: Array.isArray(decision.followups) ? decision.followups : [],
            comment: typeof decision.comment === 'string' ? decision.comment.trim() : `${source}`
        };
    }

    #defaultDecision(comment) {
        return {
            action: 'HOLD',
            comment
        };
    }
}

module.exports = LLMDecider;
