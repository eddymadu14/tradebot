// filename: scanWeeklyLargeBodies.js

import axios from 'axios';

const MIN_BODY_PERCENT = 10;
const MIN_QUOTE_VOLUME = 40_000_000; // $40M

async function getUSDTFuturesPairs() {
    try {
        const { data } = await axios.get(
            'https://fapi.binance.com/fapi/v1/exchangeInfo'
        );

        return data.symbols
            .filter(
                symbol =>
                    symbol.quoteAsset === 'USDT' &&
                    symbol.contractType === 'PERPETUAL' &&
                    symbol.status === 'TRADING'
            )
            .map(symbol => symbol.symbol);
    } catch (error) {
        console.error(
            'Error fetching exchange information:',
            error.message
        );
        return [];
    }
}

async function get24hrVolumes() {
    try {
        const { data } = await axios.get(
            'https://fapi.binance.com/fapi/v1/ticker/24hr'
        );

        const volumeMap = {};

        for (const ticker of data) {
            volumeMap[ticker.symbol] = Number(ticker.quoteVolume);
        }

        return volumeMap;
    } catch (error) {
        console.error(
            'Error fetching 24-hour volumes:',
            error.message
        );
        return {};
    }
}

async function getPreviousWeeklyCandle(symbol) {
    try {
        const { data } = await axios.get(
            'https://fapi.binance.com/fapi/v1/klines',
            {
                params: {
                    symbol,
                    interval: '1w',
                    limit: 2
                }
            }
        );

        if (!data || data.length < 2) {
            return null;
        }

        // Use the previous completed weekly candle
        const candle = data[data.length - 2];

        return {
            openTime: candle[0],
            closeTime: candle[6],
            open: Number(candle[1]),
            high: Number(candle[2]),
            low: Number(candle[3]),
            close: Number(candle[4]),
            volume: Number(candle[5]),
            quoteVolume: Number(candle[7]),
            tradeCount: Number(candle[8])
        };
    } catch (error) {
        console.error(
            `Error fetching weekly candle for ${symbol}:`,
            error.message
        );
        return null;
    }
}

async function main() {
    console.log(
        'Scanning Binance Futures using the previous completed weekly candle...\n'
    );

    const [symbols, volumeMap] = await Promise.all([
        getUSDTFuturesPairs(),
        get24hrVolumes()
    ]);

    const eligibleSymbols = symbols.filter(
        symbol => (volumeMap[symbol] || 0) >= MIN_QUOTE_VOLUME
    );

    console.log(
        `Found ${eligibleSymbols.length} USDT perpetual pairs with ≥ $40M 24-hour volume.\n`
    );

    const results = [];

    for (const symbol of eligibleSymbols) {
        const candle = await getPreviousWeeklyCandle(symbol);

        if (!candle) {
            continue;
        }

        const { open, close, openTime } = candle;

        let direction = null;
        let bodyPercent = 0;

        if (close > open) {
            // Bullish candle
            bodyPercent = ((close - open) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                direction = 'Bullish';
            }
        } else if (close < open) {
            // Bearish candle
            bodyPercent = ((open - close) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                direction = 'Bearish';
            }
        }

        if (direction) {
            results.push({
                symbol,
                direction,
                weekStart: new Date(openTime)
                    .toISOString()
                    .split('T')[0],
                bodyPercent: bodyPercent.toFixed(2) + '%',
                open,
                close,
                volume24h:
                    '$' +
                    (
                        (volumeMap[symbol] || 0) /
                        1_000_000
                    ).toFixed(2) +
                    'M'
            });
        }
    }

    results.sort(
        (a, b) =>
            parseFloat(b.bodyPercent) -
            parseFloat(a.bodyPercent)
    );

    if (results.length === 0) {
        console.log(
            `No pairs found with ≥ ${MIN_BODY_PERCENT}% body size in the previous completed weekly candle.`
        );
        return;
    }

    console.table(results);

    console.log(`\nTotal Matches: ${results.length}`);
    console.log(
        `Criteria: Previous completed weekly candle body ≥ ${MIN_BODY_PERCENT}% and 24h volume ≥ $${MIN_QUOTE_VOLUME.toLocaleString()}`
    );
}

main().catch(error => {
    console.error('Unexpected error:', error.message);
    process.exit(1);
});
