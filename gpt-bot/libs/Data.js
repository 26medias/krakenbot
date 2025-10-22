const https = require('https');
const { createHash, createHmac } = require('crypto');

/**
 * Data utility class for working with Kraken API
 * Provides easy access to latest and historical crypto data
 * 
 * Environment variables:
 * - KRAKEN_API_KEY: Your Kraken API key (required for private endpoints)
 * - KRAKEN_API_SECRET: Your Kraken API secret (required for private endpoints)
 */
class Data {
    constructor() {
        this.apiKey = process.env.KRAKEN_API_KEY;
        this.apiSecret = process.env.KRAKEN_API_SECRET;
        this.baseUrl = 'https://api.kraken.com';
    }

    /**
     * Make a request to the Kraken API
     * @param {string} path - API endpoint path
     * @param {Object} params - Request parameters
     * @param {boolean} isPublic - Whether the endpoint is public (true) or private (false)
     * @returns {Promise<Object>} - API response
     */
    async makeRequest(path, params = {}, isPublic = true) {
        const maxRetries = 3;
        const backoffMs = 250;

        const executeRequest = () => new Promise((resolve, reject) => {
            let fullPath = path;
            let postData = '';
            let method = 'GET';
            let headers = {};
            
            if (isPublic) {
                // For public endpoints, use GET with query parameters
                const queryString = new URLSearchParams(params).toString();
                if (queryString) {
                    fullPath += '?' + queryString;
                }
            } else {
                // For private endpoints, use POST with form data
                method = 'POST';
                const nonce = Date.now().toString();
                params.nonce = nonce;
                postData = new URLSearchParams(params).toString();
                
                // Create signature
                const message = path + createHash('sha256').update(nonce + postData).digest('binary');
                const signature = createHmac('sha512', Buffer.from(this.apiSecret, 'base64'))
                    .update(message, 'binary')
                    .digest('base64');
                
                headers = {
                    'API-Key': this.apiKey,
                    'API-Sign': signature,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                };
            }
            
            const options = {
                hostname: 'api.kraken.com',
                path: fullPath,
                method: method,
                headers: headers
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.error && response.error.length > 0) {
                            reject(new Error(response.error.join(', ')));
                        } else {
                            resolve(response.result);
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            if (postData) {
                req.write(postData);
            }
            req.end();
        });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await executeRequest();
            } catch (error) {
                const isLastAttempt = attempt === maxRetries;
                if (isLastAttempt) {
                    throw error;
                }
                const waitTime = backoffMs * attempt;
                await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
        }
    }

    /**
     * Get the latest OHLC data for a pair
     * @param {string} pair - Trading pair (e.g., 'DOGEUSD')
     * @returns {Promise<Object>} - Latest OHLC data in format {o, h, l, c, v}
     */
    async latest(pair) {
        try {
            const data = await this.makeRequest('/0/public/OHLC', {
                pair: pair,
                interval: 1 // 1 minute interval
            });
            
            // Extract the pair name from the response
            const pairName = Object.keys(data)[0];
            const ohlcData = data[pairName];
            
            // Get the latest data point (last in the array)
            const latestData = ohlcData[ohlcData.length - 1];
            
            // Format the data as {o, h, l, c, v}
            return {
                o: parseFloat(latestData[1]), // open
                h: parseFloat(latestData[2]), // high
                l: parseFloat(latestData[3]), // low
                c: parseFloat(latestData[4]), // close
                v: parseFloat(latestData[6])    // volume
            };
        } catch (error) {
            throw new Error(`Failed to get latest data for ${pair}: ${error.message}`);
        }
    }

    /**
     * Get historical OHLC data for a pair
     * @param {string} pair - Trading pair (e.g., 'DOGEUSD')
     * @param {number} interval - Time interval in minutes (1, 5, 15, 30, 60, 240, 1440, 10080, 21600)
     * @param {number} count - Number of data points to return (optional)
     * @param {number} since - Return committed OHLC data since given ID (optional)
     * @returns {Promise<Array>} - Array of OHLC data in format [{t, o, h, l, c, v}, ...]
     */
    async historical(pair, interval = 60, count = null, since = null) {
        try {
            const params = {
                pair: pair,
                interval: interval
            };
            
            if (since) {
                params.since = since;
            }
            
            const data = await this.makeRequest('/0/public/OHLC', params);
            
            // Extract the pair name from the response
            const pairName = Object.keys(data)[0];
            let ohlcData = data[pairName];
            
            // If count is specified, limit the number of data points
            if (count && count < ohlcData.length) {
                ohlcData = ohlcData.slice(-count);
            }
            
            // Format the data as an array of {t, o, h, l, c, v} objects
            return ohlcData.map(entry => ({
                t: parseInt(entry[0]),            // timestamp
                o: parseFloat(entry[1]),        // open
                h: parseFloat(entry[2]),        // high
                l: parseFloat(entry[3]),        // low
                c: parseFloat(entry[4]),        // close
                v: parseFloat(entry[6])         // volume
            }));
        } catch (error) {
            throw new Error(`Failed to get historical data for ${pair}: ${error.message}`);
        }
    }

    /**
     * Get the server time
     * @returns {Promise<Object>} - Server time information
     */
    async getServerTime() {
        try {
            const data = await this.makeRequest('/0/public/Time');
            return data;
        } catch (error) {
            throw new Error(`Failed to get server time: ${error.message}`);
        }
    }

    /**
     * Get asset information
     * @param {string|Array} assets - Comma-separated list or array of asset names (optional)
     * @returns {Promise<Object>} - Asset information
     */
    async getAssetInfo(assets = null) {
        try {
            const params = {};
            if (assets) {
                params.asset = Array.isArray(assets) ? assets.join(',') : assets;
            }
            
            const data = await this.makeRequest('/0/public/Assets', params);
            return data;
        } catch (error) {
            throw new Error(`Failed to get asset info: ${error.message}`);
        }
    }

    /**
     * Get tradable asset pairs
     * @param {string|Array} pairs - Comma-separated list or array of asset pairs (optional)
     * @param {string} info - Info to retrieve (info, leverage, fees, margin) (optional)
     * @returns {Promise<Object>} - Tradable asset pairs information
     */
    async getTradablePairs(pairs = null, info = 'info') {
        try {
            const params = { info };
            if (pairs) {
                params.pair = Array.isArray(pairs) ? pairs.join(',') : pairs;
            }
            
            const data = await this.makeRequest('/0/public/AssetPairs', params);
            return data;
        } catch (error) {
            throw new Error(`Failed to get tradable pairs: ${error.message}`);
        }
    }

    /**
     * Get ticker information
     * @param {string|Array} pairs - Comma-separated list or array of asset pairs
     * @returns {Promise<Object>} - Ticker information
     */
    async getTicker(pairs) {
        try {
            const params = {
                pair: Array.isArray(pairs) ? pairs.join(',') : pairs
            };
            
            const data = await this.makeRequest('/0/public/Ticker', params);
            return data;
        } catch (error) {
            throw new Error(`Failed to get ticker info: ${error.message}`);
        }
    }

    /**
     * Retrieve account balances for all assets.
     * @returns {Promise<Object>} - Asset balance information keyed by asset symbol.
     */
    async getBalances() {
        try {
            return await this.makeRequest('/0/private/Balance', {}, false);
        } catch (error) {
            throw new Error(`Failed to fetch balances: ${error.message}`);
        }
    }

    /**
     * Alias for getBalances maintained for backwards compatibility.
     * @returns {Promise<Object>}
     */
    async getBalance() {
        return this.getBalances();
    }

    /**
     * Submit an order.
     * Supports both positional arguments (type, pair, orderType, price, volume, extraParams)
     * and a single params object matching Kraken's AddOrder payload.
     * @returns {Promise<Object>} - AddOrder response.
     */
    async addOrder(typeOrParams, pair, orderType, price, volume, extraParams = {}) {
        const params = this._normaliseOrderParams(typeOrParams, pair, orderType, price, volume, extraParams);
        try {
            return await this.makeRequest('/0/private/AddOrder', params, false);
        } catch (error) {
            throw new Error(`Failed to add order: ${error.message}`);
        }
    }

    /**
     * Fetch currently open orders.
     * @param {Object} params - Optional filter parameters.
     * @returns {Promise<Object>} - OpenOrders response.
     */
    async getOpenOrders(params = {}) {
        const maxAttempts = 5;
        const baseDelay = 250;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                return await this.makeRequest('/0/private/OpenOrders', params, false);
            } catch (error) {
                const message = error?.message || '';
                const isNonceError = message.includes('Invalid nonce');
                const isTimeout = message.includes('timeout');

                if (attempt === maxAttempts || (!isNonceError && !isTimeout)) {
                    throw new Error(`Failed to fetch open orders: ${message}`);
                }

                const delay = baseDelay * attempt;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }

        throw new Error('Failed to fetch open orders: exceeded retry attempts');
    }

    /**
     * Fetch closed orders.
     * @param {Object} params - Optional filter parameters (e.g. { start, end, ofs }).
     * @returns {Promise<Object>} - ClosedOrders response.
     */
    async getClosedOrders(params = {}) {
        try {
            return await this.makeRequest('/0/private/ClosedOrders', params, false);
        } catch (error) {
            throw new Error(`Failed to fetch closed orders: ${error.message}`);
        }
    }

    /**
     * Cancel one or multiple orders.
     * @param {string|string[]} txid - Transaction id(s) to cancel.
     * @returns {Promise<Object>} - CancelOrder response.
     */
    async cancelOrder(txid) {
        if (!txid || (Array.isArray(txid) && txid.length === 0)) {
            throw new Error('txid is required to cancel order(s)');
        }
        const payload = Array.isArray(txid) ? { txid: txid.join(',') } : { txid };
        try {
            return await this.makeRequest('/0/private/CancelOrder', payload, false);
        } catch (error) {
            throw new Error(`Failed to cancel order: ${error.message}`);
        }
    }

    /**
     * Internal helper to build AddOrder parameters.
     */
    _normaliseOrderParams(typeOrParams, pair, orderType, price, volume, extraParams) {
        if (typeof typeOrParams === 'object' && typeOrParams !== null) {
            return this._stringifyOrderParams(typeOrParams);
        }

        const params = {
            type: typeOrParams,
            pair,
            ordertype: orderType,
            ...extraParams
        };

        if (price !== undefined) {
            params.price = price;
        }

        if (volume !== undefined) {
            params.volume = volume;
        }

        return this._stringifyOrderParams(params);
    }

    /**
     * Ensure numeric order params are sent as strings as required by Kraken.
     */
    _stringifyOrderParams(params) {
        const normalised = {};
        Object.entries(params).forEach(([key, value]) => {
            if (value === undefined || value === null) {
                return;
            }
            if (typeof value === 'number' || typeof value === 'bigint') {
                normalised[key] = value.toString();
            } else {
                normalised[key] = value;
            }
        });
        return normalised;
    }
}

module.exports = Data;
