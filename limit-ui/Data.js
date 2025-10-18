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
    return new Promise((resolve, reject) => {
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
        v: parseFloat(latestData[6])  // volume
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
        t: parseInt(entry[0]),      // timestamp
        o: parseFloat(entry[1]),    // open
        h: parseFloat(entry[2]),    // high
        l: parseFloat(entry[3]),    // low
        c: parseFloat(entry[4]),    // close
        v: parseFloat(entry[6])     // volume
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
}

module.exports = Data;