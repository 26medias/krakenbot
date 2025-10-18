#!/usr/bin/env node

const baseUrl = `http://localhost:${process.env.KRAKEN_API_PORT || 3000}`;

async function jsonRequest(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    });

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
        const error = new Error(`Request to ${path} failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

async function run() {
    try {
        console.log('GET /balances');
        const balances = await jsonRequest('/balances');
        console.log(balances);

        /*console.log('\nGET /price?pair=DOGEUSD');
        const price = await jsonRequest('/price?pair=DOGEUSD');
        console.log(price);

        console.log('\nGET /pairs');
        const pairs = await jsonRequest('/pairs');
        console.log(pairs.slice(0, 5));

        console.log('\nGET /orders/open');
        const openOrders = await jsonRequest('/orders/open');
        console.log(openOrders.slice(0, 5));

        console.log('\nGET /orders/closed');
        const closedOrders = await jsonRequest('/orders/closed');
        console.log(closedOrders.slice(0, 5));

        console.log('\nPOST /orders/limit');
        const limitOrder = await jsonRequest('/orders/limit', {
            method: 'POST',
            body: JSON.stringify({
                pair: 'DOGEUSD',
                type: 'buy',
                price: 0.01,
                qty: 25
            })
        });
        console.log(limitOrder);*/

        console.log('\nPOST /orders/cancel');
        const cancelOrders = await jsonRequest('/orders/cancel', {
            method: 'POST',
            body: JSON.stringify({
                asset: 'XDGUSD',
                op: 'lt',
                limit: 0.6
            })
        });
        console.log(cancelOrders);
    } catch (error) {
        console.error('Error during API calls:', error.message);
        if (error.payload) {
            console.error('Payload:', error.payload);
        }
        process.exit(1);
    }
}

run();
