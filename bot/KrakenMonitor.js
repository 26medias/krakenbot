const WebSocket = require('ws');
const Data = require('./Data');

/**
 * KrakenMonitor provides helpers to watch public OHLC price data, L2 order book streams,
 * and private execution events (fills) via Kraken WebSocket API v2.
 *
 * Environment:
 * - KRAKEN_API_KEY
 * - KRAKEN_API_SECRET
 */
class KrakenMonitor {
    constructor(options = {}) {
        this.publicUrl = options.publicUrl || 'wss://ws.kraken.com/v2';
        this.privateUrl = options.privateUrl || 'wss://ws-auth.kraken.com/v2';
        this.autoReconnect = options.autoReconnect !== undefined ? options.autoReconnect : true;
        this.logger = options.logger || console;
        this.dataClient = options.dataClient || new Data();

        this.publicSocket = null;
        this.privateSocket = null;

        this._publicReady = null;
        this._privateReady = null;

        // key -> { pair, symbol, interval, handlers, subscribed, snapshot }
        this._priceHandlers = new Map();
        this._pendingPublic = new Set();

        // key -> { pair, symbol, depth, snapshot, handlers, subscribed }
        this._bookHandlers = new Map();
        this._pendingBook = new Set();

        this._limitOrderHandlers = new Map(); // id -> callback
        this._executionsSubscribed = false;

        this._privateToken = null;
        this._privateTokenExpiry = 0;

        this._subscriptionId = 0;
    }

    /**
     * Register a callback for fills reported through the executions channel.
     * Returns an unsubscribe handle.
     */
    onLimitOrderFill(callback) {
        if (typeof callback !== 'function') {
            throw new Error('A callback function is required for onLimitOrderFill');
        }

        const handlerId = this._nextId();
        this._limitOrderHandlers.set(handlerId, callback);

        if (!this._executionsSubscribed) {
            this._executionsSubscribed = true;
            this._subscribeExecutions().catch((error) => {
                this.logger.error('Failed to subscribe to executions feed:', error.message);
            });
        }

        return {
            unsubscribe: () => {
                if (!this._limitOrderHandlers.has(handlerId)) {
                    return;
                }
                this._limitOrderHandlers.delete(handlerId);

                if (this._limitOrderHandlers.size === 0 && this._executionsSubscribed) {
                    this._executionsSubscribed = false;
                    this._unsubscribeExecutions().catch((error) => {
                        this.logger.error('Failed to unsubscribe from executions feed:', error.message);
                    });
                }
            }
        };
    }

    /**
     * Subscribe to OHLC updates for a pair.
     * @param {string} pair - Kraken pair (e.g. DOGEUSD, XDG/USD)
     * @param {Function} callback - Handler invoked with OHLC data objects.
     * @param {Object} opts - Optional settings { interval, snapshot }
     */
    onPriceChange(pair, callback, opts = {}) {
        if (typeof pair !== 'string' || !pair.trim()) {
            throw new Error('A valid trading pair string is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('A callback function is required for onPriceChange');
        }

        const interval = Number.isInteger(opts.interval) && opts.interval > 0 ? opts.interval : 1;
        const snapshot = opts.snapshot !== undefined ? Boolean(opts.snapshot) : false;

        const pairName = pair.trim();
        const symbol = this._toWsSymbol(pairName);
        const key = this._priceKey(symbol, interval);

        let entry = this._priceHandlers.get(key);
        if (!entry) {
            entry = {
                pair: pairName,
                symbol,
                interval,
                snapshot,
                handlers: new Map(),
                subscribed: false
            };
            this._priceHandlers.set(key, entry);
        }

        const handlerId = this._nextId();
        entry.handlers.set(handlerId, callback);

        if (!entry.subscribed) {
            entry.subscribed = true; // optimistic to avoid duplicate subscribe attempts
            this._pendingPublic.add(key);
            this._subscribePriceFeed(entry).catch((error) => {
                entry.subscribed = false;
                this.logger.error(`Failed to subscribe to OHLC for ${entry.symbol}: ${error.message}`);
            });
        }

        return {
            unsubscribe: () => {
                const stored = this._priceHandlers.get(key);
                if (!stored) {
                    return;
                }
                stored.handlers.delete(handlerId);
                if (stored.handlers.size === 0) {
                    this._priceHandlers.delete(key);
                    this._pendingPublic.delete(key);
                    this._unsubscribePriceFeed(stored).catch((error) => {
                        this.logger.error(`Failed to unsubscribe from OHLC for ${stored.symbol}: ${error.message}`);
                    });
                }
            }
        };
    }

    /**
     * Subscribe to order book updates for a pair.
     */
    onOrderBook(pair, callback, opts = {}) {
        if (typeof pair !== 'string' || !pair.trim()) {
            throw new Error('A valid trading pair string is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('A callback function is required for onOrderBook');
        }

        const depth = Number.isInteger(opts.depth) && opts.depth > 0 ? opts.depth : 10;
        const snapshot = opts.snapshot !== undefined ? Boolean(opts.snapshot) : true;

        const pairName = pair.trim();
        const symbol = this._toWsSymbol(pairName);
        const key = this._bookKey(symbol);

        let entry = this._bookHandlers.get(key);
        if (!entry) {
            entry = {
                pair: pairName,
                symbol,
                depth,
                snapshot,
                handlers: new Map(),
                subscribed: false
            };
            this._bookHandlers.set(key, entry);
        } else {
            entry.depth = depth;
            entry.snapshot = snapshot;
        }

        const handlerId = this._nextId();
        entry.handlers.set(handlerId, callback);

        if (!entry.subscribed) {
            entry.subscribed = true;
            this._pendingBook.add(key);
            this._subscribeBook(entry).catch((error) => {
                entry.subscribed = false;
                this.logger.error(`Failed to subscribe to order book for ${entry.symbol}: ${error.message}`);
            });
        }

        return {
            unsubscribe: () => {
                const stored = this._bookHandlers.get(key);
                if (!stored) {
                    return;
                }
                stored.handlers.delete(handlerId);
                if (stored.handlers.size === 0) {
                    this._bookHandlers.delete(key);
                    this._pendingBook.delete(key);
                    this._unsubscribeBook(stored).catch((error) => {
                        this.logger.error(`Failed to unsubscribe from order book for ${stored.symbol}: ${error.message}`);
                    });
                }
            }
        };
    }

    /**
     * Close sockets and clear listeners.
     */
    async close() {
        this._priceHandlers.clear();
        this._pendingPublic.clear();
        this._bookHandlers.clear();
        this._pendingBook.clear();
        this._limitOrderHandlers.clear();
        this._executionsSubscribed = false;

        await Promise.all([
            this._closeSocket(this.publicSocket),
            this._closeSocket(this.privateSocket)
        ]);

        this.publicSocket = null;
        this.privateSocket = null;
    }

    async _subscribePriceFeed(entry) {
        await this._ensurePublicSocket();
        const payload = {
            method: 'subscribe',
            params: {
                channel: 'ohlc',
                symbol: [entry.symbol],
                interval: entry.interval,
                snapshot: entry.snapshot
            }
        };
        await this._sendWhenOpen(this.publicSocket, payload);
    }

    async _unsubscribePriceFeed(entry) {
        if (!this.publicSocket) {
            return;
        }
        const payload = {
            method: 'unsubscribe',
            params: {
                channel: 'ohlc',
                symbol: [entry.symbol],
                interval: entry.interval
            }
        };
        await this._sendWhenOpen(this.publicSocket, payload);

        if (this._priceHandlers.size === 0) {
            await this._closeSocket(this.publicSocket);
            this.publicSocket = null;
        }
    }

    async _subscribeBook(entry) {
        await this._ensurePublicSocket();
        const params = {
            channel: 'book',
            symbol: [entry.symbol],
            depth: entry.depth,
            snapshot: entry.snapshot
        };
        if (!entry.snapshot) {
            delete params.snapshot;
        }
        await this._sendWhenOpen(this.publicSocket, {
            method: 'subscribe',
            params
        });
    }

    async _unsubscribeBook(entry) {
        if (!this.publicSocket) {
            return;
        }
        await this._sendWhenOpen(this.publicSocket, {
            method: 'unsubscribe',
            params: {
                channel: 'book',
                symbol: [entry.symbol]
            }
        });

        if (this._priceHandlers.size === 0 && this._bookHandlers.size === 0) {
            await this._closeSocket(this.publicSocket);
            this.publicSocket = null;
        }
    }

    async _subscribeExecutions() {
        try {
            const token = await this._getPrivateToken();
            await this._ensurePrivateSocket();
            const payload = {
                method: 'subscribe',
                params: {
                    channel: 'executions',
                    token,
                    snap_orders: false,
                    snap_trades: false
                }
            };
            await this._sendWhenOpen(this.privateSocket, payload);
        } catch (error) {
            this._executionsSubscribed = false;
            throw error;
        }
    }

    async _unsubscribeExecutions() {
        if (!this.privateSocket) {
            return;
        }
        const token = await this._getPrivateToken(true);
        const payload = {
            method: 'unsubscribe',
            params: {
                channel: 'executions',
                token
            }
        };
        await this._sendWhenOpen(this.privateSocket, payload);

        if (this._limitOrderHandlers.size === 0) {
            await this._closeSocket(this.privateSocket);
            this.privateSocket = null;
        }
    }

    async _ensurePublicSocket() {
        if (this.publicSocket && this.publicSocket.readyState !== WebSocket.CLOSED) {
            return this.publicSocket;
        }
        if (this._publicReady) {
            return this._publicReady;
        }

        this._publicReady = new Promise((resolve, reject) => {
            const socket = new WebSocket(this.publicUrl);
            this.publicSocket = socket;

            socket.on('open', () => {
                this._publicReady = null;
                resolve(socket);
            });

            socket.on('message', (data) => {
                this._handlePublicMessage(data);
            });

            socket.on('error', (error) => {
                this.logger.error('Public WebSocket error:', error.message);
            });

            socket.on('close', () => {
                this.logger.warn('Public WebSocket connection closed');
                this.publicSocket = null;
                if (this.autoReconnect && (this._priceHandlers.size > 0 || this._bookHandlers.size > 0)) {
                    this._priceHandlers.forEach((entry, key) => {
                        entry.subscribed = false;
                        this._pendingPublic.add(key);
                    });
                    this._bookHandlers.forEach((entry, key) => {
                        entry.subscribed = false;
                        this._pendingBook.add(key);
                    });
                    setTimeout(() => {
                        this._resubscribePriceFeeds(true);
                        this._resubscribeBookFeeds(true);
                    }, 1000);
                }
            });

            socket.on('unexpected-response', (_req, res) => {
                reject(new Error(`Unexpected public WebSocket response: ${res.statusCode}`));
            });

            socket.once('error', (error) => {
                if (this._publicReady) {
                    reject(error);
                    this._publicReady = null;
                }
            });
        });

        return this._publicReady;
    }

    async _ensurePrivateSocket() {
        if (this.privateSocket && this.privateSocket.readyState !== WebSocket.CLOSED) {
            return this.privateSocket;
        }
        if (this._privateReady) {
            return this._privateReady;
        }

        this._privateReady = new Promise((resolve, reject) => {
            const socket = new WebSocket(this.privateUrl);
            this.privateSocket = socket;

            socket.on('open', () => {
                this._privateReady = null;
                resolve(socket);
            });

            socket.on('message', (data) => {
                this._handlePrivateMessage(data);
            });

            socket.on('error', (error) => {
                this.logger.error('Private WebSocket error:', error.message);
            });

            socket.on('close', () => {
                this.logger.warn('Private WebSocket connection closed');
                this.privateSocket = null;
                if (this.autoReconnect && this._limitOrderHandlers.size > 0) {
                    setTimeout(() => {
                        this._subscribeExecutions().catch((error) => {
                            this.logger.error('Error resubscribing executions after close:', error.message);
                        });
                    }, 1000);
                }
            });

            socket.on('unexpected-response', (_req, res) => {
                reject(new Error(`Unexpected private WebSocket response: ${res.statusCode}`));
            });

            socket.once('error', (error) => {
                if (this._privateReady) {
                    reject(error);
                    this._privateReady = null;
                }
            });
        });

        return this._privateReady;
    }

    async _sendWhenOpen(socket, payload) {
        if (!socket) {
            throw new Error('Attempted to send over a closed socket');
        }
        if (socket.readyState === WebSocket.CONNECTING) {
            await new Promise((resolve, reject) => {
                const handleOpen = () => {
                    cleanup();
                    resolve();
                };
                const handleError = (error) => {
                    cleanup();
                    reject(error);
                };
                const cleanup = () => {
                    socket.removeListener('open', handleOpen);
                    socket.removeListener('error', handleError);
                };
                socket.once('open', handleOpen);
                socket.once('error', handleError);
            });
        } else if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
            throw new Error('Cannot send on a closing or closed socket');
        }
        socket.send(JSON.stringify(payload));
    }

    async _closeSocket(socket) {
        if (!socket) {
            return;
        }
        await new Promise((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
                resolve();
                return;
            }
            socket.once('close', () => resolve());
            socket.close();
        });
    }

    async _getPrivateToken(allowExpired = false) {
        const now = Date.now();
        if (!allowExpired && this._privateToken && now < this._privateTokenExpiry - 5000) {
            return this._privateToken;
        }

        const result = await this.dataClient.makeRequest('/0/private/GetWebSocketsToken', {}, false);
        if (!result || !result.token) {
            throw new Error('Failed to retrieve private WebSocket token');
        }

        this._privateToken = result.token;
        const expiresIn = result.expires ? result.expires * 1000 : 900000; // default 15 min
        this._privateTokenExpiry = now + expiresIn;
        return this._privateToken;
    }

    _handlePublicMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            this.logger.error('Failed to parse public message:', error.message);
            return;
        }

        if (message.channel === 'heartbeat') {
            return;
        }

        if (message.channel === 'status') {
            return;
        }

        if (typeof message.method === 'string') {
            this._handlePublicAck(message);
            return;
        }

        if (message.channel === 'ohlc') {
            this._processOhlc(message);
            return;
        }

        if (message.channel === 'book') {
            this._processBook(message);
            return;
        }

        this.logger.debug && this.logger.debug('Unhandled public message:', message);
    }

    _handlePublicAck(message) {
        const result = message.result || {};
        const channel = result.channel || message.params?.channel;
        const paramsSymbol = Array.isArray(message.params?.symbol) ? message.params.symbol[0] : message.params?.symbol;

        if (message.method === 'subscribe') {
            if (channel === 'ohlc') {
                const key = this._priceKey(result.symbol || paramsSymbol, result.interval);
                const entry = this._priceHandlers.get(key);
                if (message.success) {
                    if (entry) {
                        entry.subscribed = true;
                        this._pendingPublic.delete(key);
                    }
                } else {
                    if (entry) {
                        entry.subscribed = false;
                    }
                    this.logger.error('Public subscription error:', message.error || message);
                }
            } else if (channel === 'book') {
                const key = this._bookKey(result.symbol || paramsSymbol);
                const entry = this._bookHandlers.get(key);
                if (message.success) {
                    if (entry) {
                        entry.subscribed = true;
                        this._pendingBook.delete(key);
                    }
                } else {
                    if (entry) {
                        entry.subscribed = false;
                    }
                    this.logger.error('Order book subscription error:', message.error || message);
                }
            }
            return;
        }

        if (message.method === 'unsubscribe') {
            if (channel === 'ohlc') {
                const key = this._priceKey(result.symbol || paramsSymbol, result.interval);
                const entry = this._priceHandlers.get(key);
                if (entry) {
                    entry.subscribed = message.success ? false : entry.subscribed;
                }
            } else if (channel === 'book') {
                const key = this._bookKey(result.symbol || paramsSymbol);
                const entry = this._bookHandlers.get(key);
                if (entry) {
                    entry.subscribed = message.success ? false : entry.subscribed;
                }
            }

            if (!message.success) {
                this.logger.error('Public unsubscription error:', message.error || message);
            }
        }
    }

    _processOhlc(message) {
        const { data = [], type, timestamp } = message;
        if (!Array.isArray(data) || data.length === 0) {
            return;
        }

        data.forEach((candle) => {
            const key = this._priceKey(candle.symbol, candle.interval);
            const entry = this._priceHandlers.get(key);
            if (!entry) {
                return;
            }

            const mapped = this._mapOhlcData(candle, type, timestamp);
            entry.handlers.forEach((handler) => {
                try {
                    handler(mapped);
                } catch (error) {
                    this.logger.error('Error in price handler:', error.message);
                }
            });
        });
    }

    _processBook(message) {
        const { data = [], type, timestamp } = message;
        if (!Array.isArray(data) || data.length === 0) {
            return;
        }

        const firstEntry = data[0] || {};
        const rawBook = firstEntry.book || firstEntry;
        const symbol = rawBook.symbol || message.symbol;
        const key = this._bookKey(symbol);
        const entry = this._bookHandlers.get(key);
        if (!entry) {
            return;
        }

        const parseLevels = (levels) => {
            if (!Array.isArray(levels)) {
                return [];
            }
            return levels
                .map((level) => {
                    if (!level) {
                        return null;
                    }
                    const price = typeof level.price === 'string' ? parseFloat(level.price) : level.price;
                    const qty = typeof level.qty === 'string' ? parseFloat(level.qty) : level.qty;
                    if (!Number.isFinite(price) || !Number.isFinite(qty)) {
                        return null;
                    }
                    return { price, qty };
                })
                .filter((level) => level !== null);
        };

        const parseTimestamp = (value) => {
            if (!value) {
                return null;
            }
            const ts = Date.parse(value);
            return Number.isNaN(ts) ? null : ts;
        };

        const tsValue = rawBook.timestamp || firstEntry.timestamp || timestamp || null;

        const payload = {
            type,
            symbol: rawBook.symbol || entry.symbol,
            bids: parseLevels(rawBook.bids),
            asks: parseLevels(rawBook.asks),
            checksum: rawBook.checksum,
            timestamp: tsValue,
            timestampUnix: parseTimestamp(tsValue)
        };

        entry.handlers.forEach((handler) => {
            try {
                handler(payload);
            } catch (error) {
                this.logger.error('Error in order book handler:', error.message);
            }
        });
    }

    _handlePrivateMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch (error) {
            this.logger.error('Failed to parse private message:', error.message);
            return;
        }

        if (message.channel === 'heartbeat') {
            return;
        }

        if (typeof message.method === 'string') {
            this._handlePrivateAck(message);
            return;
        }

        if (message.channel === 'executions') {
            this._processExecutions(message);
            return;
        }

        //this.logger.debug && this.logger.debug('Unhandled private message:', message);
    }

    _handlePrivateAck(message) {
        if (message.method === 'subscribe') {
            if (message.success) {
                this._executionsSubscribed = true;
            } else {
                this._executionsSubscribed = false;
                this.logger.error('Executions subscription error:', message.error || message);
            }
            return;
        }

        if (message.method === 'unsubscribe') {
            if (message.success) {
                this._executionsSubscribed = false;
            } else {
                this.logger.error('Executions unsubscription error:', message.error || message);
            }
        }
    }

    _processExecutions(message) {
        const { data = [], type } = message;
        if (!Array.isArray(data) || data.length === 0) {
            return;
        }

        data.forEach((report) => {
            const execType = typeof report.exec_type === 'string' ? report.exec_type.toLowerCase() : '';
            if (execType !== 'trade') {
                return;
            }

            const details = this._normaliseExecutionReport(report, type);
            this._limitOrderHandlers.forEach((handler) => {
                try {
                    handler(details);
                } catch (error) {
                    this.logger.error('Error in limit order handler:', error.message);
                }
            });
        });
    }

    _normaliseExecutionReport(report, type) {
        const normalised = { ...report, channel_type: type };

        const numericFields = [
            'avg_price',
            'cash_order_qty',
            'exec_price',
            'exec_qty',
            'fee',
            'limit_price',
            'order_price',
            'stop_price',
            'trigger_price',
            'vol',
            'vol_exec'
        ];

        numericFields.forEach((field) => {
            if (normalised[field] !== undefined && normalised[field] !== null) {
                const parsed = Number(normalised[field]);
                if (!Number.isNaN(parsed)) {
                    normalised[field] = parsed;
                }
            }
        });

        if (typeof normalised.exec_time === 'string') {
            const execTs = Date.parse(normalised.exec_time);
            if (!Number.isNaN(execTs)) {
                normalised.exec_time_unix = execTs;
            }
        }

        return normalised;
    }

    _mapOhlcData(candle, type, channelTimestamp) {
        const parseTs = (value) => {
            if (!value) {
                return null;
            }
            const ts = Date.parse(value);
            return Number.isNaN(ts) ? null : ts;
        };

        const base = {
            type,
            symbol: candle.symbol,
            interval: candle.interval,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            vwap: candle.vwap,
            volume: candle.volume,
            trades: candle.trades,
            intervalBegin: candle.interval_begin,
            intervalBeginUnix: parseTs(candle.interval_begin),
            timestamp: candle.timestamp,
            timestampUnix: parseTs(candle.timestamp),
            channelTimestamp,
            channelTimestampUnix: parseTs(channelTimestamp)
        };

        return base;
    }

    _resubscribePriceFeeds(force = false) {
        this._priceHandlers.forEach((entry, key) => {
            if (force) {
                entry.subscribed = false;
            }
            if (!entry.subscribed && !this._pendingPublic.has(key)) {
                entry.subscribed = true;
                this._pendingPublic.add(key);
                this._subscribePriceFeed(entry).catch((error) => {
                    entry.subscribed = false;
                    this.logger.error(`Failed to resubscribe OHLC for ${entry.symbol}: ${error.message}`);
                });
            }
        });
    }

    _resubscribeBookFeeds(force = false) {
        this._bookHandlers.forEach((entry, key) => {
            if (force) {
                entry.subscribed = false;
            }
            if (!entry.subscribed && !this._pendingBook.has(key)) {
                entry.subscribed = true;
                this._pendingBook.add(key);
                this._subscribeBook(entry).catch((error) => {
                    entry.subscribed = false;
                    this.logger.error(`Failed to resubscribe order book for ${entry.symbol}: ${error.message}`);
                });
            }
        });
    }

    _priceKey(symbol, interval) {
        const normalizedSymbol = this._canonicalPair(symbol);
        return `${normalizedSymbol}:${interval || 1}`;
    }

    _bookKey(symbol) {
        return this._canonicalPair(symbol);
    }

    _canonicalPair(symbol) {
        if (typeof symbol !== 'string') {
            return '';
        }
        return symbol.replace(/\//g, '').toUpperCase();
    }

    _toWsSymbol(pair) {
        const upper = pair.toUpperCase();
        if (upper.includes('/')) {
            return upper;
        }

        const knownQuotes = [
            'USDT',
            'USDC',
            'DAI',
            'EUR',
            'USD',
            'GBP',
            'CAD',
            'CHF',
            'JPY',
            'AUD',
            'NZD',
            'BTC',
            'XBT',
            'ETH',
            'SOL',
            'DOT',
            'ADA',
            'TRY',
            'MXN',
            'ZUSD',
            'ZEUR',
            'ZGBP',
            'ZJPY',
            'ZCAD'
        ];

        const match = knownQuotes.find((quote) => upper.endsWith(quote));
        if (match) {
            const base = upper.slice(0, upper.length - match.length);
            return `${base}/${match}`;
        }

        if (upper.length >= 6) {
            return `${upper.slice(0, upper.length - 3)}/${upper.slice(-3)}`;
        }

        return upper;
    }

    normaliseSymbol(pair) {
        if (typeof pair !== 'string' || !pair.trim()) {
            throw new Error('Pair must be a non-empty string');
        }
        return this._toWsSymbol(pair.trim());
    }

    _nextId() {
        this._subscriptionId += 1;
        return this._subscriptionId;
    }
}

module.exports = KrakenMonitor;
