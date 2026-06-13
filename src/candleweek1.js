// scanWeeklyLargeBodies.js

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

        // Previous completed weekly candle
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
        'Scanning Binance USDT Futures using the previous completed weekly candle...\n'
    );

    const [symbols, volumeMap] = await Promise.all([
        getUSDTFuturesPairs(),
        get24hrVolumes()
    ]);

    if (symbols.length === 0) {
        console.log('No futures pairs found.');
        return;
    }

    const eligibleSymbols = symbols.filter(
        symbol => (volumeMap[symbol] || 0) >= MIN_QUOTE_VOLUME
    );

    console.log(
        `Found ${eligibleSymbols.length} USDT perpetual pairs with ≥ $${(
            MIN_QUOTE_VOLUME / 1_000_000
        ).toFixed(0)}M 24-hour volume.\n`
    );

    const bullishResults = [];
    const bearishResults = [];

    for (const symbol of eligibleSymbols) {
        const candle = await getPreviousWeeklyCandle(symbol);

        if (!candle) {
            continue;
        }

        const { open, close, openTime } = candle;

        const weekStart = new Date(openTime)
            .toISOString()
            .split('T')[0];

        // Bullish candle
        if (close > open) {
            const bodyPercent =
                ((close - open) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                bullishResults.push({
                    symbol,
                    weekStart,
                    bodyPercent:
                        `${bodyPercent.toFixed(2)}%`,
                    open,
                    close,
                    volume24h:
                        `$${(
                            volumeMap[symbol] /
                            1_000_000
                        ).toFixed(2)}M`
                });
            }
        }

        // Bearish candle
        else if (close < open) {
            const bodyPercent =
                ((open - close) / open) * 100;

            if (bodyPercent >= MIN_BODY_PERCENT) {
                bearishResults.push({
                    symbol,
                    weekStart,
                    bodyPercent:
                        `${bodyPercent.toFixed(2)}%`,
                    open,
                    close,
                    volume24h:
                        `$${(
                            volumeMap[symbol] /
                            1_000_000
                        ).toFixed(2)}M`
                });
            }
        }
    }

    // Sort by largest body percentage
    bullishResults.sort(
        (a, b) =>
            parseFloat(b.bodyPercent) -
            parseFloat(a.bodyPercent)
    );

    bearishResults.sort(
        (a, b) =>
            parseFloat(b.bodyPercent) -
            parseFloat(a.bodyPercent)
    );

    if (
        bullishResults.length === 0 &&
        bearishResults.length === 0
    ) {
        console.log(
            `No pairs found with ≥ ${MIN_BODY_PERCENT}% body size in the previous completed weekly candle.`
        );
        return;
    }

    // Bullish Table
    console.log(
        `\n========== BULLISH PAIRS (${bullishResults.length}) ==========`
    );

    if (bullishResults.length > 0) {
        console.table(bullishResults);
    } else {
        console.log('No bullish pairs found.');
    }

    // Bearish Table
    console.log(
        `\n========== BEARISH PAIRS (${bearishResults.length}) ==========`
    );

    if (bearishResults.length > 0) {
        console.table(bearishResults);
    } else {
        console.log('No bearish pairs found.');
    }

    // Summary
    console.log('\n========== SUMMARY ==========');
    console.log(
        `Bullish Pairs: ${bullishResults.length}`
    );
    console.log(
        `Bearish Pairs: ${bearishResults.length}`
    );
    console.log(
        `Total Matches: ${
            bullishResults.length +
            bearishResults.length
        }`
    );

    console.log(
        `\nCriteria:`
    );
    console.log(
        `• Previous completed weekly candle body ≥ ${MIN_BODY_PERCENT}%`
    );
    console.log(
        `• Minimum 24-hour quote volume ≥ $${MIN_QUOTE_VOLUME.toLocaleString()}`
    );
}

main().catch(error => {
    console.error(
        'Unexpected error:',
        error.message
    );
    process.exit(1);
});
