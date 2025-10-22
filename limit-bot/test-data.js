const Data = require('./Data');

// Initialize the Data class
const data = new Data();

// Get latest OHLC data for DOGEUSD
data.latest('DOGEUSD')
    .then(({o, h, l, c, v}) => {
        console.log(`DOGEUSD - Open: ${o}, High: ${h}, Low: ${l}, Close: ${c}, Volume: ${v}`);
    })
    .catch(error => {
        console.error(error);
    });

// Get historical OHLC data for DOGEUSD with 60-minute intervals
data.historical('DOGEUSD', 60)
    .then(historicalData => {
        console.log('Historical data for DOGEUSD:');
        historicalData.forEach(entry => {
            console.log(`Time: ${new Date(entry.t * 1000)}, Open: ${entry.o}, High: ${entry.h}, Low: ${entry.l}, Close: ${entry.c}, Volume: ${entry.v}`);
        });
    })
    .catch(error => {
        console.error(error);
    });

// Get ticker information for multiple pairs
data.getTicker(['DOGEUSD', 'BTCUSD'])
    .then(tickerData => {
        console.log('Ticker data:', tickerData);
    })
    .catch(error => {
        console.error(error);
    });