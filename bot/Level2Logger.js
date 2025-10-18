const path = require('path');
const sqlite3 = require('sqlite3');
const KrakenMonitor = require('./KrakenMonitor');

class Level2Logger {
    constructor(options = {}) {
        const pairs = Array.isArray(options.pair) ? options.pair : [options.pair].filter(Boolean);
        if (!pairs.length) {
            throw new Error('Level2Logger requires at least one trading pair');
        }

        this.logger = options.logger || console;
        this.distance = Number.isFinite(options.distance) && options.distance > 0 ? Number(options.distance) : 20;
        this.depth = Number.isInteger(options.depth) && options.depth > 0 ? options.depth : 100;
        this.dbPath = options.dbPath || path.join(__dirname, 'level2.db');

        this.monitorOwned = !options.monitor;
        this.monitor = options.monitor || new KrakenMonitor({ logger: this.logger });
        this.pairs = pairs.map((pair) => this.monitor.normaliseSymbol(pair));
        this.bookStates = new Map();
        this.subscriptions = [];
        this.priceSubscriptions = [];

        this.db = null;
        this.insertStmt = null;
        this.initialised = false;
    }

    init() {
        return this._initialiseDatabase()
            .then(() => {
                this.initialised = true;
                this.pairs.forEach((symbol) => {
                    this.bookStates.set(symbol, {
                        bids: new Map(),
                        asks: new Map(),
                        price: null
                    });
                    const bookSub = this.monitor.onOrderBook(symbol, (event) => this._onBookEvent(symbol, event), {
                        depth: this.depth,
                        snapshot: true
                    });
                    const priceSub = this.monitor.onPriceChange(symbol, (candle) => this._onPriceEvent(symbol, candle), {
                        interval: 1,
                        snapshot: false
                    });
                    this.subscriptions.push(bookSub);
                    this.priceSubscriptions.push(priceSub);
                });
            })
            .catch((error) => {
                this.logger.error?.(`Failed to initialise Level2Logger: ${error.message}`);
                throw error;
            });
    }

    async shutdown() {
        this.subscriptions.forEach((sub) => sub?.unsubscribe?.());
        this.subscriptions = [];
        this.priceSubscriptions.forEach((sub) => sub?.unsubscribe?.());
        this.priceSubscriptions = [];
        this.bookStates.clear();
        if (this.monitorOwned) {
            await this.monitor.close();
        }
        await this._closeDatabase();
    }

    async _initialiseDatabase() {
        this.db = await new Promise((resolve, reject) => {
            const instance = new sqlite3.Database(this.dbPath, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(instance);
                }
            });
        });

        await new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('PRAGMA journal_mode = WAL;');
                this.db.run('PRAGMA synchronous = NORMAL;');
                this.db.run('PRAGMA temp_store = MEMORY;');
                this.db.run('PRAGMA mmap_size = 134217728;');
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS level2_logs (
                        pair TEXT NOT NULL,
                        timestamp INTEGER NOT NULL,
                        price REAL,
                        buy_qty REAL NOT NULL,
                        sell_qty REAL NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE INDEX IF NOT EXISTS idx_level2_logs_pair_ts
                    ON level2_logs (pair, timestamp)
                `, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    this._ensurePriceColumn()
                        .then(() => {
                            this.insertStmt = this.db.prepare(`
                                INSERT INTO level2_logs (pair, timestamp, price, buy_qty, sell_qty)
                                VALUES (?, ?, ?, ?, ?)
                            `, (prepareError) => {
                                if (prepareError) {
                                    reject(prepareError);
                                } else {
                                    resolve();
                                }
                            });
                        })
                        .catch(reject);
                });
            });
        });
    }

    async _closeDatabase() {
        if (!this.db) {
            return;
        }

        await new Promise((resolve, reject) => {
            const finalize = (callback) => {
                if (this.insertStmt) {
                    this.insertStmt.finalize((err) => {
                        this.insertStmt = null;
                        callback(err);
                    });
                } else {
                    callback();
                }
            };

            finalize((finalizeError) => {
                if (finalizeError) {
                    reject(finalizeError);
                    return;
                }
                this.db.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        }).catch((error) => {
            this.logger.error?.(`Failed to close level2 database: ${error.message}`);
        });

        this.db = null;
        this.initialised = false;
    }

    _onBookEvent(symbol, event) {
        const state = this.bookStates.get(symbol);
        if (!state) {
            return;
        }

        if (event.type === 'snapshot') {
            state.bids.clear();
            state.asks.clear();
        }

        this._applyLevels(state.bids, event.bids);
        this._applyLevels(state.asks, event.asks);

        if (state.bids.size === 0 && state.asks.size === 0) {
            return;
        }

        const timestamp = Number.isFinite(event.timestampUnix) ? event.timestampUnix : Date.now();
        this._recordSnapshot(symbol, state, timestamp);
    }

    _onPriceEvent(symbol, candle) {
        const state = this.bookStates.get(symbol);
        if (!state) {
            return;
        }
        const price = Number(candle?.close);
        if (Number.isFinite(price)) {
            state.price = price;
        }
    }

    _applyLevels(map, levels) {
        if (!Array.isArray(levels)) {
            return;
        }
        levels.forEach((level) => {
            if (!level) {
                return;
            }
            const price = Number(level.price);
            const qty = Number(level.qty);
            if (!Number.isFinite(price)) {
                return;
            }
            const key = price.toFixed(12);
            if (!Number.isFinite(qty) || qty <= 0) {
                map.delete(key);
            } else {
                map.set(key, { price, qty });
            }
        });
    }

    _recordSnapshot(symbol, state, timestamp) {
        const referencePrice = this._computeReferencePrice(state);
        if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
            return;
        }

        const threshold = referencePrice * (this.distance / 100);
        const buyQty = this._sumWithinDistance(state.bids, referencePrice, threshold, 'buy');
        const sellQty = this._sumWithinDistance(state.asks, referencePrice, threshold, 'sell');

        const priceValue = Number.isFinite(state.price) ? state.price : referencePrice;

        if (!this.initialised || !this.insertStmt) {
            return;
        }

        this.insertStmt.run(symbol, timestamp, priceValue, buyQty, sellQty, (error) => {
            if (error) {
                this.logger.error?.(`Failed to persist level2 snapshot: ${error.message}`);
            }
        });

        const priceLog = Number.isFinite(priceValue) ? priceValue.toFixed(8) : 'n/a';
        const buyLog = Number.isFinite(buyQty) ? buyQty.toFixed(6) : '0';
        const sellLog = Number.isFinite(sellQty) ? sellQty.toFixed(6) : '0';
        this.logger.debug?.(`[Level2] ${symbol} ${timestamp} price=${priceLog} buy=${buyLog} sell=${sellLog}`);
    }

    _computeReferencePrice(state) {
        const bestBid = this._bestBid(state.bids);
        const bestAsk = this._bestAsk(state.asks);

        if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
            return (bestBid + bestAsk) / 2;
        }
        if (Number.isFinite(bestBid)) {
            return bestBid;
        }
        if (Number.isFinite(bestAsk)) {
            return bestAsk;
        }
        return null;
    }

    _bestBid(bids) {
        let best = null;
        bids.forEach((level) => {
            if (!Number.isFinite(level.price)) {
                return;
            }
            if (best === null || level.price > best) {
                best = level.price;
            }
        });
        return best;
    }

    _bestAsk(asks) {
        let best = null;
        asks.forEach((level) => {
            if (!Number.isFinite(level.price)) {
                return;
            }
            if (best === null || level.price < best) {
                best = level.price;
            }
        });
        return best;
    }

    _sumWithinDistance(levels, referencePrice, threshold, side) {
        let total = 0;
        levels.forEach((level) => {
            if (!Number.isFinite(level.price) || !Number.isFinite(level.qty)) {
                return;
            }
            if (side === 'buy') {
                if (level.price <= referencePrice && (referencePrice - level.price) <= threshold) {
                    total += level.qty;
                }
            } else if (level.price >= referencePrice && (level.price - referencePrice) <= threshold) {
                total += level.qty;
            }
        });
        return total;
    }

    _ensurePriceColumn() {
        return new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(level2_logs)', (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                const hasPrice = Array.isArray(rows) && rows.some((row) => row.name === 'price');
                if (hasPrice) {
                    resolve();
                    return;
                }
                this.db.run('ALTER TABLE level2_logs ADD COLUMN price REAL', (alterError) => {
                    if (alterError && !alterError.message.includes('duplicate column name')) {
                        reject(alterError);
                    } else {
                        resolve();
                    }
                });
            });
        });
    }
}

module.exports = Level2Logger;
