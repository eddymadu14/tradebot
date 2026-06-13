import axios from "axios";

const SYMBOL = "GBPUSD=X";
const INTERVAL = "1d";
const LIMIT = 200;

async function fetchCandles() {
    const intervalMap = {
        "1d": "1d",
        "1wk": "1wk",
        "1mo": "1mo"
    };

    const rangeMap = {
        "1d": "2y",
        "1wk": "10y",
        "1mo": "max"
    };

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}`;

    const response = await axios.get(url, {
        params: {
            interval: intervalMap[INTERVAL],
            range: rangeMap[INTERVAL]
        },
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
    });

    const result = response.data.chart.result?.[0];

    if (!result) {
        throw new Error("No data returned from Yahoo Finance");
    }

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    const candles = [];

    for (let i = 0; i < timestamps.length; i++) {
        const open = quote.open[i];
        const high = quote.high[i];
        const low = quote.low[i];
        const close = quote.close[i];

        if (
            open == null ||
            high == null ||
            low == null ||
            close == null
        ) {
            continue;
        }

        candles.push({
            date: new Date(timestamps[i] * 1000)
                .toISOString()
                .split("T")[0],
            open,
            high,
            low,
            close
        });
    }

    return candles.slice(-LIMIT);
}

function calculateWickStats(candles) {
    const bullish = [];
    const bearish = [];

    for (const candle of candles) {
        const { date, open, high, low, close } = candle;

        // Bullish Candle
        if (close > open && bullish.length < 20) {
            const lowerWick = open - low;

            const lowerWickPercent =
                (lowerWick / open) * 100;

            bullish.push({
                date,
                open,
                low,
                close,
                wickSize: lowerWick,
                wickPercent: lowerWickPercent
            });
        }

        // Bearish Candle
        if (close < open && bearish.length < 20) {
            const upperWick = high - open;

            const upperWickPercent =
                (upperWick / open) * 100;

            bearish.push({
                date,
                open,
                high,
                close,
                wickSize: upperWick,
                wickPercent: upperWickPercent
            });
        }

        if (
            bullish.length >= 20 &&
            bearish.length >= 20
        ) {
            break;
        }
    }

    const avgBullishLowerWick =
        bullish.reduce(
            (sum, c) => sum + c.wickPercent,
            0
        ) / bullish.length;

    const avgBearishUpperWick =
        bearish.reduce(
            (sum, c) => sum + c.wickPercent,
            0
        ) / bearish.length;

    return {
        bullish,
        bearish,
        avgBullishLowerWick,
        avgBearishUpperWick
    };
}

async function main() {
    try {
        const candles = await fetchCandles();

        // Reverse so newest candles are processed first
        candles.reverse();

        const stats = calculateWickStats(candles);

        console.log("\n==============================");
        console.log("GBP/USD Forex Wick Analysis");
        console.log("==============================\n");

        console.log(
            `Bullish Candles Analysed: ${stats.bullish.length}`
        );

        console.log(
            `Bearish Candles Analysed: ${stats.bearish.length}\n`
        );

        console.log(
            `Average Bullish Lower Wick %: ${stats.avgBullishLowerWick.toFixed(
                4
            )}%`
        );

        console.log(
            `Average Bearish Upper Wick %: ${stats.avgBearishUpperWick.toFixed(
                4
            )}%`
        );

        console.log(
            "\n--- Bullish Lower Wick Samples ---"
        );

        stats.bullish.forEach((c, i) => {
            console.log(
                `${i + 1}. ${c.date} | ${c.wickPercent.toFixed(
                    4
                )}%`
            );
        });

        console.log(
            "\n--- Bearish Upper Wick Samples ---"
        );

        stats.bearish.forEach((c, i) => {
            console.log(
                `${i + 1}. ${c.date} | ${c.wickPercent.toFixed(
                    4
                )}%`
            );
        });

    } catch (error) {
        console.error(
            "Error:",
            error.response?.data || error.message
        );
    }
}

main();
