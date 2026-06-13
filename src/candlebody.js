// filename: scanLargeBodies.js

import axios from 'axios';

const TARGET_DATE = process.argv[2]; // Example: 2026-06-09

if (!TARGET_DATE) {
    console.error('Usage: node scanLargeBodies.js YYYY-MM-DD');
    process.exit(1);
}

const MIN_BODY_PERCENT = 10;
const MIN_QUOTE_VOLUME = 40_000_000; // $40M

async function getUSDTFuturesPairs() {
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
}

async function get24hrVolumes() {
    const { data } = await axios.get(
        'https://fapi.binance.com/fapi/v1/ticker/24hr'
    );

    const volumeMap = {};

    for (const ticker of data) {
        volumeMap[ticker.symbol] = Number(ticker.quoteVolume);
    }

    return volumeMap;
}

async function getDailyCandle(symbol, targetDate) {
    try {
        const startTime = new Date(`${targetDate}T00:00:00Z`).getTime();

        const { data } = await axios.get(
            'https://fapi.binance.com/fapi/v1/klines',
            {
                params: {
                    symbol,
                    interval: '1d',
                    startTime,
                    limit: 1
                }
            }
        );

        if (!data.length) {
            return null;
        }

        const candle = data[0];

        return {
            openTime: candle[0],
            open: Number(candle[1]),
            high: Number(candle[2]),
            low: Number(candle[3]),
            close: Number(candle[4]),
            volume: Number(candle[7]) // quote asset volume
        };
    } catch (error) {
        console.error(`Error fetching ${symbol}:`, error.message);
        return null;
    }
}

async function main() {
    console.log(`Scanning Binance Futures for ${TARGET_DATE}...\n`);

    const [symbols, volumeMap] = await Promise.all([
        getUSDTFuturesPairs(),
        get24hrVolumes()
    ]);

    const eligibleSymbols = symbols.filter(
        symbol => (volumeMap[symbol] || 0) >= MIN_QUOTE_VOLUME
    );

    console.log(
        `Found ${eligibleSymbols.length} USDT perpetual pairs with ≥ $40M 24h volume.\n`
    );

    const results = [];

    for (const symbol of eligibleSymbols) {
        const candle = await getDailyCandle(symbol, TARGET_DATE);

        if (!candle) continue;

        const { open, close } = candle;

        let direction = null;
        let bodyPercent = 0;

        if (close > open) {
            bodyPercent = ((close - open) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                direction = 'Bullish';
            }
        } else if (close < open) {
            bodyPercent = ((open - close) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                direction = 'Bearish';
            }
        }

        if (direction) {
            results.push({
                symbol,
                direction,
                bodyPercent: bodyPercent.toFixed(2),
                open,
                close,
                volume24h: (volumeMap[symbol] / 1_000_000).toFixed(2)
            });
        }
    }

    results.sort(
        (a, b) => Number(b.bodyPercent) - Number(a.bodyPercent)
    );

    if (results.length === 0) {
        console.log(
            `No pairs found with ≥ ${MIN_BODY_PERCENT}% candle body on ${TARGET_DATE}.`
        );
        return;
    }

    console.table(results);

    console.log(`\nTotal Matches: ${results.length}`);
}

main().catch(console.error);
