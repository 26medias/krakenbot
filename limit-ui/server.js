#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Data = require('./Data');

/**
 * Thin Kraken client with helper methods for private endpoints.
 */
class KrakenAPI extends Data {
  async getBalance() {
    return this.makeRequest('/0/private/Balance', {}, false);
  }

  async addOrder(type, pair, orderType, price, volume) {
    const params = {
      ordertype: orderType,
      type,
      pair,
      price: price.toString(),
      volume: volume.toString()
    };
    return this.makeRequest('/0/private/AddOrder', params, false);
  }

  async getOpenOrders() {
    return this.makeRequest('/0/private/OpenOrders', {}, false);
  }

  async getClosedOrders(params = {}) {
    return this.makeRequest('/0/private/ClosedOrders', params, false);
  }

  async cancelOrder(txid) {
    return this.makeRequest('/0/private/CancelOrder', { txid }, false);
  }

  async getTradablePairs(info = 'info') {
    return super.getTradablePairs(null, info);
  }
}

const kraken = new KrakenAPI();
const PORT = process.env.KRAKEN_API_PORT || 3000;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        const error = new Error('Request body too large');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        const parseError = new Error('Invalid JSON body');
        parseError.statusCode = 400;
        reject(parseError);
      }
    });
    req.on('error', reject);
  });
}

function formatOrdersCollection(collection) {
  return Object.entries(collection).map(([txid, order]) => ({
    txid,
    refid: order.refid || null,
    userref: order.userref || null,
    status: order.status,
    opentm: order.opentm,
    closetm: order.closetm || null,
    starttm: order.starttm || null,
    expiretm: order.expiretm || null,
    vol: parseFloat(order.vol),
    vol_exec: parseFloat(order.vol_exec),
    cost: parseFloat(order.cost || 0),
    fee: parseFloat(order.fee || 0),
    price: parseFloat(order.price || order.descr?.price || 0),
    limitprice: parseFloat(order.descr?.price2 || 0),
    descr: order.descr || {}
  }));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = parsedUrl;

  try {
    if (req.method === 'GET' && pathname === '/') {
      const filePath = path.join(__dirname, 'static', 'page.html');
      const stream = fs.createReadStream(filePath);

      stream.on('open', () => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8'
        });
        stream.pipe(res);
      });

      stream.on('error', (error) => {
        console.error(error);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Failed to load page' });
        } else {
          res.destroy(error);
        }
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/balances') {
      const balances = await kraken.getBalance();
      sendJson(res, 200, balances);
      return;
    }

    if (req.method === 'GET' && pathname === '/pairs') {
      const pairsResponse = await kraken.getTradablePairs('info');
      const usdPairs = Object.entries(pairsResponse)
        .filter(([, details]) => details.altname && details.altname.includes('USD'))
        .map(([pair, details]) => ({
          pair,
          altname: details.altname,
          wsname: details.wsname || null,
          base: details.base,
          quote: details.quote,
          lot: details.lot,
          pair_decimals: details.pair_decimals,
          lot_decimals: details.lot_decimals,
          lot_multiplier: details.lot_multiplier,
          fee_volume_currency: details.fee_volume_currency,
          fees: Array.isArray(details.fees) && details.fees.length > 0 ? details.fees[0][1] : null,
          fees_maker: Array.isArray(details.fees_maker) && details.fees_maker.length > 0 ? details.fees_maker[0][1] : null,
          ordermin: details.ordermin ? parseFloat(details.ordermin) : null,
          costmin: details.costmin ? parseFloat(details.costmin) : null,
          tick_size: details.tick_size ? parseFloat(details.tick_size) : null,
          status: details.status || null
        }));

      sendJson(res, 200, usdPairs);
      return;
    }

    if (req.method === 'GET' && pathname === '/price') {
      const pair = searchParams.get('pair');
      if (!pair) {
        sendJson(res, 400, { error: 'Missing required query parameter: pair' });
        return;
      }

      const snapshot = await kraken.latest(pair);
      sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'GET' && pathname === '/orders/open') {
      const ordersResponse = await kraken.getOpenOrders();
      const openOrders = formatOrdersCollection(ordersResponse.open || {});
      sendJson(res, 200, openOrders);
      return;
    }

    if (req.method === 'GET' && pathname === '/orders/closed') {
      const ordersResponse = await kraken.getClosedOrders();
      const closedOrders = formatOrdersCollection(ordersResponse.closed || {})
        .sort((a, b) => (b.closetm || 0) - (a.closetm || 0))
        .slice(0, 50);
      sendJson(res, 200, closedOrders);
      return;
    }

    if (req.method === 'POST' && pathname === '/orders/limit') {
      const { pair, type, price, qty } = await parseBody(req);

      if (!pair || !type || typeof price !== 'number' || typeof qty !== 'number') {
        sendJson(res, 400, { error: 'Parameters pair, type, price, and qty are required' });
        return;
      }

      const normalizedType = type.toLowerCase();
      if (normalizedType !== 'buy' && normalizedType !== 'sell') {
        sendJson(res, 400, { error: 'Parameter type must be "buy" or "sell"' });
        return;
      }

      if (price <= 0 || qty <= 0) {
        sendJson(res, 400, { error: 'Parameters price and qty must be positive numbers' });
        return;
      }

      const result = await kraken.addOrder(normalizedType, pair, 'limit', price, qty);
      sendJson(res, 200, { result });
      return;
    }

    if (req.method === 'POST' && pathname === '/orders/cancel') {
      const { asset, op, limit } = await parseBody(req);

      if (!asset || !op || typeof limit !== 'number') {
        sendJson(res, 400, { error: 'Parameters asset, op, and limit are required' });
        return;
      }

      const normalizedOp = op.toLowerCase();
      if (normalizedOp !== 'gt' && normalizedOp !== 'lt') {
        sendJson(res, 400, { error: 'Parameter op must be "gt" or "lt"' });
        return;
      }

      const ordersResponse = await kraken.getOpenOrders();
      const openOrders = formatOrdersCollection(ordersResponse.open || {});

      const toCancel = openOrders.filter(order => {
        if (!order.descr || order.descr.pair !== asset || order.descr.ordertype !== 'limit') {
          return false;
        }
        const price = parseFloat(order.descr.price);
        if (Number.isNaN(price)) {
          return false;
        }
        return normalizedOp === 'gt' ? price > limit : price < limit;
      });

      if (toCancel.length === 0) {
        sendJson(res, 200, { cancelled: [], message: 'No matching orders found' });
        return;
      }

      const summary = {
        total: toCancel.length,
        cancelled: [],
        failed: []
      };

      for (const order of toCancel) {
        try {
          const response = await kraken.cancelOrder(order.txid);
          summary.cancelled.push({ txid: order.txid, response });
        } catch (error) {
          summary.failed.push({ txid: order.txid, error: error.message });
        }
      }

      sendJson(res, 200, summary);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    console.error(error);
    const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    sendJson(res, statusCode, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Kraken API server listening on port ${PORT}`);
});

module.exports = server;
