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
        this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 20000;
        this.dbPath = options.dbPath || path.join(__dirname, 'level2.db');

        this.monitorOwned = !options.monitor;
        this.monitor = options.monitor || new KrakenMonitor({ logger: this.logger });
        this.pairs = pairs.map((pair) => this.monitor.normaliseSymbol(pair));
        this.bookStates = new Map();
        this.subscriptions = [];
        this.priceSubscriptions = [];

        this.db = null;
        this.insertStmt = null;
        this.selectPairStmt = null;
        this.insertPairStmt = null;
        this.pairIdCache = new Map();
        this.initialised = false;
    }

    async init() {
        try {
            await this._initialiseDatabase();
            this.initialised = true;
            for (const symbol of this.pairs) {
                const pairId = await this._ensurePairId(symbol);
                this.bookStates.set(symbol, {
                    bids: new Map(),
                    asks: new Map(),
                    price: null,
                    pairId,
                    lastFlush: null,
                    pendingPromise: null
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
            }
        } catch (error) {
            this.logger.error?.(`Failed to initialise Level2Logger: ${error.message}`);
            throw error;
        }
    }

    async shutdown() {
        this.subscriptions.forEach((sub) => sub?.unsubscribe?.());
        this.subscriptions = [];
        this.priceSubscriptions.forEach((sub) => sub?.unsubscribe?.());
        this.priceSubscriptions = [];

        const flushes = [];
        this.bookStates.forEach((state, symbol) => {
            const promise = this._writeSnapshot(symbol, state, Date.now(), true);
            if (promise) {
                flushes.push(promise);
            }
        });
        await Promise.all(flushes);
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
                    CREATE TABLE IF NOT EXISTS pairs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        symbol TEXT UNIQUE NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS level2_logs (
                        pair_id INTEGER NOT NULL,
                        timestamp INTEGER NOT NULL,
                        price REAL,
                        buy_qty REAL NOT NULL,
                        sell_qty REAL NOT NULL,
                        FOREIGN KEY(pair_id) REFERENCES pairs(id)
                    )
                `, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        });

        await this._ensureSchema();
        await this._runSql('CREATE INDEX IF NOT EXISTS idx_level2_logs_pair_ts ON level2_logs (pair_id, timestamp)');

        const [insertStmt, selectPairStmt, insertPairStmt] = await Promise.all([
            this._prepareStatement('INSERT INTO level2_logs (pair_id, timestamp, price, buy_qty, sell_qty) VALUES (?, ?, ?, ?, ?)'),
            this._prepareStatement('SELECT id FROM pairs WHERE symbol = ?'),
            this._prepareStatement('INSERT OR IGNORE INTO pairs (symbol) VALUES (?)')
        ]);
        this.insertStmt = insertStmt;
        this.selectPairStmt = selectPairStmt;
        this.insertPairStmt = insertPairStmt;
    }

    async _closeDatabase() {
        if (!this.db) {
            return;
        }

        await new Promise((resolve, reject) => {
            const finalizeStatements = (callback) => {
                const tasks = [];
                if (this.insertStmt) {
                    tasks.push(new Promise((res, rej) => this.insertStmt.finalize((err) => err ? rej(err) : res())));
                    this.insertStmt = null;
                }
                if (this.selectPairStmt) {
                    tasks.push(new Promise((res, rej) => this.selectPairStmt.finalize((err) => err ? rej(err) : res())));
                    this.selectPairStmt = null;
                }
                if (this.insertPairStmt) {
                    tasks.push(new Promise((res, rej) => this.insertPairStmt.finalize((err) => err ? rej(err) : res())));
                    this.insertPairStmt = null;
                }
                if (tasks.length === 0) {
                    callback();
                    return;
                }
                Promise.all(tasks).then(() => callback()).catch((error) => callback(error));
            };

            finalizeStatements((finalizeError) => {
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
        this.pairIdCache.clear();
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
        if (state.lastFlush === null) {
            state.lastFlush = timestamp;
        }

        if ((timestamp - state.lastFlush) >= this.intervalMs && !state.pendingPromise) {
            const flushPromise = this._writeSnapshot(symbol, state, timestamp);
            if (flushPromise) {
                state.pendingPromise = flushPromise;
                flushPromise
                    .catch((error) => {
                        this.logger.error?.(`Failed to persist level2 snapshot: ${error.message}`);
                    })
                    .finally(() => {
                        state.pendingPromise = null;
                    });
            }
        }
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

    _totalWithinDistance(levels, referencePrice, threshold, side) {
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

    _writeSnapshot(symbol, state, timestamp, force = false) {
        if (!this.initialised || !this.insertStmt) {
            return null;
        }

        const pairId = state.pairId;
        if (!pairId) {
            return null;
        }

        const referencePrice = this._computeReferencePrice(state);
        const priceValue = Number.isFinite(state.price) ? state.price : referencePrice;
        if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(priceValue)) {
            return null;
        }

        const threshold = referencePrice * (this.distance / 100);
        let buyQty = this._totalWithinDistance(state.bids, referencePrice, threshold, 'buy');
        let sellQty = this._totalWithinDistance(state.asks, referencePrice, threshold, 'sell');

        if (!force && buyQty === 0 && sellQty === 0) {
            state.lastFlush = timestamp;
            return null;
        }

        buyQty = Math.round(buyQty * 1e6) / 1e6;
        sellQty = Math.round(sellQty * 1e6) / 1e6;
        const roundedPrice = Math.round(priceValue * 1e8) / 1e8;
        const recordTimestamp = timestamp;

        state.lastFlush = recordTimestamp;
        return new Promise((resolve) => {
            this.insertStmt.run(pairId, recordTimestamp, roundedPrice, buyQty, sellQty, (error) => {
                if (error) {
                    this.logger.error?.(`Failed to persist level2 snapshot: ${error.message}`);
                } else {
                    const priceLog = roundedPrice.toFixed(8);
                    const buyLog = buyQty.toFixed(6);
                    const sellLog = sellQty.toFixed(6);
                    this.logger.debug?.(`[Level2] ${symbol} ${recordTimestamp} price=${priceLog} buy=${buyLog} sell=${sellLog}`);
                }
                resolve();
            });
        });
    }

    async _ensurePairId(symbol) {
        if (this.pairIdCache.has(symbol)) {
            return this.pairIdCache.get(symbol);
        }

        await this._runStatement(this.insertPairStmt, [symbol]);
        const row = await this._get(this.selectPairStmt, [symbol]);
        if (!row || !Number.isInteger(row.id)) {
            throw new Error(`Failed to resolve pair id for ${symbol}`);
        }
        this.pairIdCache.set(symbol, row.id);
        return row.id;
    }

    _ensureSchema() {
        return new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(level2_logs)', async (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (!rows || rows.length === 0) {
                    resolve();
                    return;
                }
                const hasPairId = rows.some((row) => row.name === 'pair_id');
                const hasPairText = rows.some((row) => row.name === 'pair');
                const hasPrice = rows.some((row) => row.name === 'price');

                try {
                    if (!hasPrice) {
                        await this._runSql('ALTER TABLE level2_logs ADD COLUMN price REAL');
                    }
                    if (!hasPairId) {
                        await this._migratePairSchema(hasPairText);
                    }
                    resolve();
                } catch (schemaError) {
                    reject(schemaError);
                }
            });
        });
    }

    _migratePairSchema(hasPairText) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('ALTER TABLE level2_logs RENAME TO level2_logs_old', (renameErr) => {
                    if (renameErr) {
                        reject(renameErr);
                        return;
                    }
                    this.db.run(`
                        CREATE TABLE level2_logs (
                            pair_id INTEGER NOT NULL,
                            timestamp INTEGER NOT NULL,
                            price REAL,
                            buy_qty REAL NOT NULL,
                            sell_qty REAL NOT NULL,
                            FOREIGN KEY(pair_id) REFERENCES pairs(id)
                        )
                    `, (createErr) => {
                        if (createErr) {
                            reject(createErr);
                            return;
                        }
                        const finish = () => {
                            this.db.run('DROP TABLE level2_logs_old', (dropErr) => {
                                if (dropErr) {
                                    reject(dropErr);
                                } else {
                                    resolve();
                                }
                            });
                        };

                        const migrateData = () => {
                            if (hasPairText) {
                                this.db.run(`
                                    INSERT OR IGNORE INTO pairs (symbol)
                                    SELECT DISTINCT pair FROM level2_logs_old
                                `, (insertPairsErr) => {
                                    if (insertPairsErr) {
                                        reject(insertPairsErr);
                                        return;
                                    }
                                    this.db.run(`
                                        INSERT INTO level2_logs (pair_id, timestamp, price, buy_qty, sell_qty)
                                        SELECT p.id, old.timestamp, old.price, old.buy_qty, old.sell_qty
                                        FROM level2_logs_old old
                                        JOIN pairs p ON p.symbol = old.pair
                                    `, (copyErr) => {
                                        if (copyErr) {
                                            reject(copyErr);
                                        } else {
                                            finish();
                                        }
                                    });
                                });
                            } else {
                                finish();
                            }
                        };

                        migrateData();
                    });
                });
            });
        });
    }

    _runSql(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    _prepareStatement(sql) {
        return new Promise((resolve, reject) => {
            const statement = this.db.prepare(sql, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(statement);
                }
            });
        });
    }

    _runStatement(statement, params) {
        return new Promise((resolve, reject) => {
            statement.run(params, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    _get(statement, params) {
        return new Promise((resolve, reject) => {
            statement.get(params, (error, row) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(row);
                }
            });
        });
    }

    _all(statement, params) {
        return new Promise((resolve, reject) => {
            statement.all(params, (error, rows) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(rows);
                }
            });
        });
    }
}

module.exports = Level2Logger;
