#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const sqlite3 = require('sqlite3');

class Level2Inspector {
    constructor(dbPath) {
        this.dbPath = dbPath;
        const flags = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
        this.db = new sqlite3.Database(dbPath, flags);
        this.countStmt = null;
        this.firstStmt = null;
        this.lastStmt = null;
        this.recentStmt = null;
        this.pairsStmt = null;
        this.usesPairId = false;

        this.ready = new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('PRAGMA foreign_keys = ON;');
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
                    this._inspectSchema()
                        .then(() => {
                            this._prepareStatements();
                            resolve();
                        })
                        .catch(reject);
                });
            });
        });
    }

    async queryPair(pair, limit) {
        if (!this.countStmt) {
            throw new Error('Level2Inspector not initialised');
        }
        const totalRow = await this._get(this.countStmt, [pair]);
        const total = totalRow ? Number(totalRow.total) : 0;
        if (!total) {
            return {
                total: 0,
                recent: [],
                first: null,
                last: null
            };
        }

        const recentRows = await this._all(this.recentStmt, [pair, limit]);
        const recent = recentRows.map((row) => ({
            timestamp: row.timestamp,
            price: row.price,
            buy_qty: row.buy_qty,
            sell_qty: row.sell_qty
        }));
        const first = await this._get(this.firstStmt, [pair]);
        const last = await this._get(this.lastStmt, [pair]);

        return {
            total,
            recent,
            first,
            last
        };
    }

    listPairs() {
        return this._all(this.pairsStmt, []);
    }

    close() {
        this.countStmt?.finalize();
        this.firstStmt?.finalize();
        this.lastStmt?.finalize();
        this.recentStmt?.finalize();
        this.pairsStmt?.finalize();
        this.db.close();
    }

    static formatTimestamp(ms) {
        if (!Number.isFinite(ms)) {
            return 'N/A';
        }
        return new Date(ms).toISOString();
    }

    _prepareStatements() {
        if (this.usesPairId) {
            this.countStmt = this.db.prepare(`
                SELECT COUNT(*) AS total
                FROM level2_logs l
                JOIN pairs p ON p.id = l.pair_id
                WHERE p.symbol = ?
            `);
            this.firstStmt = this.db.prepare(`
                SELECT l.timestamp, l.price, l.buy_qty, l.sell_qty
                FROM level2_logs l
                JOIN pairs p ON p.id = l.pair_id
                WHERE p.symbol = ?
                ORDER BY l.timestamp ASC
                LIMIT 1
            `);
            this.lastStmt = this.db.prepare(`
                SELECT l.timestamp, l.price, l.buy_qty, l.sell_qty
                FROM level2_logs l
                JOIN pairs p ON p.id = l.pair_id
                WHERE p.symbol = ?
                ORDER BY l.timestamp DESC
                LIMIT 1
            `);
            this.recentStmt = this.db.prepare(`
                SELECT l.timestamp, l.price, l.buy_qty, l.sell_qty
                FROM level2_logs l
                JOIN pairs p ON p.id = l.pair_id
                WHERE p.symbol = ?
                ORDER BY l.timestamp DESC
                LIMIT ?
            `);
            this.pairsStmt = this.db.prepare(`
                SELECT p.symbol AS pair, COUNT(*) AS total
                FROM level2_logs l
                JOIN pairs p ON p.id = l.pair_id
                GROUP BY p.symbol
                ORDER BY total DESC
            `);
        } else {
            this.countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM level2_logs WHERE pair = ?');
            this.firstStmt = this.db.prepare('SELECT timestamp, price, buy_qty, sell_qty FROM level2_logs WHERE pair = ? ORDER BY timestamp ASC LIMIT 1');
            this.lastStmt = this.db.prepare('SELECT timestamp, price, buy_qty, sell_qty FROM level2_logs WHERE pair = ? ORDER BY timestamp DESC LIMIT 1');
            this.recentStmt = this.db.prepare('SELECT timestamp, price, buy_qty, sell_qty FROM level2_logs WHERE pair = ? ORDER BY timestamp DESC LIMIT ?');
            this.pairsStmt = this.db.prepare('SELECT pair, COUNT(*) AS total FROM level2_logs GROUP BY pair ORDER BY total DESC');
        }
    }

    _inspectSchema() {
        return new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(level2_logs)', (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (!rows || rows.length === 0) {
                    this.usesPairId = true;
                    resolve();
                    return;
                }
                this.usesPairId = rows.some((row) => row.name === 'pair_id');
                const hasPrice = rows.some((row) => row.name === 'price');
                if (!hasPrice) {
                    this.db.run('ALTER TABLE level2_logs ADD COLUMN price REAL', (alterErr) => {
                        if (alterErr && !alterErr.message.includes('duplicate column name')) {
                            reject(alterErr);
                        } else {
                            resolve();
                        }
                    });
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

module.exports = Level2Inspector;
module.exports.normalisePair = normalisePair;

function normalisePair(pair) {
    const trimmed = pair.trim();
    if (trimmed.includes('/')) {
        return trimmed.toUpperCase();
    }
    const upper = trimmed.toUpperCase();
    const quote = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'AUD', 'NZD', 'BTC', 'XBT'].find((ticker) => upper.endsWith(ticker));
    if (quote) {
        return `${upper.slice(0, upper.length - quote.length)}/${quote}`;
    }
    if (upper.length >= 6) {
        return `${upper.slice(0, upper.length - 3)}/${upper.slice(-3)}`;
    }
    return upper;
}

if (require.main === module) {
    const program = new Command();
    program
        .description('Inspect recorded level 2 order book aggregates')
        .requiredOption('--pair <symbol>', 'Trading pair, e.g. "DOGE/USD"')
        .option('--limit <number>', 'Number of recent datapoints to display', '10');

    program.parse(process.argv);

    const options = program.opts();
    const limit = Math.max(1, parseInt(options.limit, 10) || 10);
    const pair = normalisePair(options.pair);

    const dbPath = path.join(__dirname, 'level2.db');
    const inspector = new Level2Inspector(dbPath);

    (async () => {
        try {
            await inspector.ready;
            const stats = await inspector.queryPair(pair, limit);
            if (!stats.total) {
                console.log(`No data for pair ${pair}`);
                const pairs = await inspector.listPairs();
                if (pairs.length > 0) {
                    console.log('Available pairs in database:');
                    pairs.slice(0, 10).forEach((row) => {
                        console.log(`  ${row.pair}: ${row.total} datapoints`);
                    });
                } else {
                    console.log('Database contains no level2 data.');
                }
            } else {
                console.log(`Pair: ${pair}`);
                console.log(`Total datapoints: ${stats.total}`);
                console.log(`First datapoint: ${Level2Inspector.formatTimestamp(stats.first.timestamp)} (price=${Number.isFinite(stats.first.price) ? stats.first.price : 'n/a'})`);
                console.log(`Last datapoint:  ${Level2Inspector.formatTimestamp(stats.last.timestamp)} (price=${Number.isFinite(stats.last.price) ? stats.last.price : 'n/a'})`);
                console.log(`\nLast ${Math.min(limit, stats.recent.length)} datapoints:`);
                stats.recent.reverse().forEach((row) => {
                    const buy = Number.isFinite(row.buy_qty) ? row.buy_qty.toFixed(6) : '0';
                    const sell = Number.isFinite(row.sell_qty) ? row.sell_qty.toFixed(6) : '0';
                    const priceVal = Number.isFinite(row.price) ? row.price.toFixed(6) : 'n/a';
                    console.log(`${Level2Inspector.formatTimestamp(row.timestamp)} | price=${priceVal} | buy=${buy} | sell=${sell}`);
                });
            }
        } catch (error) {
            console.error(`Failed to query level2 data: ${error.message}`);
        } finally {
            inspector.close();
        }
    })();
}
