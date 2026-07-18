import axios from "axios";

const SYMBOL = "HYPEUSDT";
const INTERVAL = "2h";
const LIMIT = 200;

const BASE_URL = "https://fapi.binance.com";

async function fetchCandles() {
    const url = `${BASE_URL}/fapi/v1/klines`;

    const response = await axios.get(url, {
        params: {
            symbol: SYMBOL,
            interval: INTERVAL,
            limit: LIMIT
        }
    });

    return response.data;
}

function calculateWickStats(candles) {
    const bullish = [];
    const bearish = [];

    for (const candle of candles) {
        const open = parseFloat(candle[1]);
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        const close = parseFloat(candle[4]);

        // Bullish Candle
        if (close > open && bullish.length < 40) {
            const lowerWick = open - low;

            const lowerWickPercent =
                (lowerWick / open) * 100;

            bullish.push({
                open,
                low,
                close,
                wickSize: lowerWick,
                wickPercent: lowerWickPercent
            });
        }

        // Bearish Candle
        if (close < open && bearish.length < 40) {
            const upperWick = high - open;

            const upperWickPercent =
                (upperWick / open) * 100;

            bearish.push({
                open,
                high,
                close,
                wickSize: upperWick,
                wickPercent: upperWickPercent
            });
        }

        if (bullish.length >= 40 && bearish.length >= 40) {
            break;
        }
    }

    const avgBullishLowerWick =
        bullish.reduce((sum, c) => sum + c.wickPercent, 0) /
        bullish.length;

    const avgBearishUpperWick =
        bearish.reduce((sum, c) => sum + c.wickPercent, 0) /
        bearish.length;

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
        console.log("BTC Futures Wick Analysis");
        console.log("==============================\n");

        console.log(`Bullish Candles Analysed: ${stats.bullish.length}`);
        console.log(`Bearish Candles Analysed: ${stats.bearish.length}\n`);

        console.log(
            `Average Bullish Lower Wick %: ${stats.avgBullishLowerWick.toFixed(4)}%`
        );

        console.log(
            `Average Bearish Upper Wick %: ${stats.avgBearishUpperWick.toFixed(4)}%`
        );

        console.log("\n--- Bullish Lower Wick Samples ---");
        stats.bullish.forEach((c, i) => {
            console.log(
                `${i + 1}. ${c.wickPercent.toFixed(4)}%`
            );
        });

        console.log("\n--- Bearish Upper Wick Samples ---");
        stats.bearish.forEach((c, i) => {
            console.log(
                `${i + 1}. ${c.wickPercent.toFixed(4)}%`
            );
        });

    } catch (error) {
        console.error("Error:", error.message);
    }
}

main();
