const fs = require('fs');
const path = require('path');

function toCsvValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return value.map((item) => toCsvValue(item)).join(';');
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    const stringValue = String(value);
    if (/[",\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

class DecisionLogger {
    constructor(options = {}) {
        this.logger = options.logger || console;
        const basePath = options.filePath || path.join(__dirname, '..', 'logs', 'llm-decisions.csv');
        this.filePath = path.resolve(basePath);
        this.initialised = false;
        this.header = [
            'timestamp',
            'pair',
            'action',
            'size_pct',
            'entry_type',
            'entry_offset_bps',
            'stop_atr',
            'tp_atr',
            'followups',
            'comment',
            'price',
            'confluence_score',
            'volatility_regime',
            'trend_regime',
            'momentum_regime',
            'reasons',
            'dry_run'
        ];
        this.writeQueue = Promise.resolve();
    }

    async logDecision(entry) {
        this.writeQueue = this.writeQueue
            .then(() => this.#writeEntry(entry))
            .catch((error) => {
                this.logger.error(`[DecisionLogger] Failed to write entry: ${error.message}`);
            });
        return this.writeQueue;
    }

    async #writeEntry(entry) {
        if (!entry) {
            return;
        }

        await this.#ensureHeader();

        const row = this.#buildRow(entry);
        await fs.promises.appendFile(this.filePath, `${row}\n`, 'utf8');
    }

    async #ensureHeader() {
        if (this.initialised) {
            return;
        }
        const dir = path.dirname(this.filePath);
        await fs.promises.mkdir(dir, { recursive: true });

        let exists = true;
        try {
            await fs.promises.access(this.filePath, fs.constants.F_OK);
        } catch (error) {
            exists = false;
        }

        if (!exists) {
            await fs.promises.writeFile(this.filePath, `${this.header.join(',')}\n`, 'utf8');
        }

        this.initialised = true;
    }

    #buildRow(entry) {
        const {
            timestamp,
            pair,
            decision = {},
            price,
            confluence,
            regime,
            reasons = [],
            dryRun
        } = entry;

        const orderedValues = [
            toCsvValue(timestamp || new Date()),
            toCsvValue(pair || ''),
            toCsvValue(decision.action || ''),
            toCsvValue(decision.size_pct ?? ''),
            toCsvValue(decision.entry?.type ?? ''),
            toCsvValue(decision.entry?.offset_bps ?? ''),
            toCsvValue(decision.stop_atr ?? ''),
            toCsvValue(decision.tp_atr ?? ''),
            toCsvValue(decision.followups || []),
            toCsvValue(decision.comment || ''),
            toCsvValue(price ?? ''),
            toCsvValue(confluence?.score ?? ''),
            toCsvValue(regime?.volatility ?? ''),
            toCsvValue(regime?.trend ?? ''),
            toCsvValue(regime?.momentum ?? ''),
            toCsvValue(Array.isArray(reasons) ? reasons.join(';') : reasons),
            toCsvValue(dryRun ? 1 : 0)
        ];

        return orderedValues.join(',');
    }
}

module.exports = DecisionLogger;
