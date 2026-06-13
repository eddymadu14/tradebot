import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1h";
const LIMIT = 300;

async function fetchCandles() {
    const response = await axios.get(
        `${BASE_URL}/fapi/v1/klines`,
        {
            params: {
                symbol: SYMBOL,
                interval: INTERVAL,
                limit: LIMIT
            }
        }
    );

    return response.data;
}

function analyzeWicks(candles) {

    // Binance returns oldest -> newest
    // We reverse so index 0 becomes latest candle
    const latestFirst = [...candles].reverse();

    const bullish = [];
    const bearish = [];

    for (const candle of latestFirst) {

        const open = parseFloat(candle[1]);
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        const close = parseFloat(candle[4]);

        // =========================
        // BULLISH CANDLE
        // =========================
        if (close > open && bullish.length < 20) {

            const lowerWick =
                Math.min(open, close) - low;

            const wickPercent =
                (lowerWick / open) * 100;

            bullish.push({
                label: bullish.length + 1,
                open,
                low,
                close,
                wick: lowerWick,
                wickPercent
            });
        }

        // =========================
        // BEARISH CANDLE
        // =========================
        if (close < open && bearish.length < 20) {

            const upperWick =
                high - Math.max(open, close);

            const wickPercent =
                (upperWick / open) * 100;

            bearish.push({
                label: bearish.length + 1,
                open,
                high,
                close,
                wick: upperWick,
                wickPercent
            });
        }

        if (
            bullish.length >= 20 &&
            bearish.length >= 20
        ) {
            break;
        }
    }

    const avgBullish =
        bullish.reduce(
            (sum, c) => sum + c.wickPercent,
            0
        ) / bullish.length;

    const avgBearish =
        bearish.reduce(
            (sum, c) => sum + c.wickPercent,
            0
        ) / bearish.length;

    return {
        bullish,
        bearish,
        avgBullish,
        avgBearish
    };
}

async function main() {

    try {

        const candles = await fetchCandles();

        const result = analyzeWicks(candles);

        console.log("\n===============================");
        console.log("BTCUSDT Futures Wick Analysis");
        console.log("===============================\n");

        console.log(
            `Average Bullish Lower Wick: ${result.avgBullish.toFixed(4)}%`
        );

        console.log(
            `Average Bearish Upper Wick: ${result.avgBearish.toFixed(4)}%`
        );

        console.log("\n");
        console.log("LATEST BULLISH LOWER WICKS");
        console.log("--------------------------------");

        result.bullish.forEach((c) => {

            console.log(
                `#${c.label} | ` +
                `Lower Wick: ${c.wick.toFixed(2)} | ` +
                `Wick %: ${c.wickPercent.toFixed(4)}%`
            );

        });

        console.log("\n");
        console.log("LATEST BEARISH UPPER WICKS");
        console.log("--------------------------------");

        result.bearish.forEach((c) => {

            console.log(
                `#${c.label} | ` +
                `Upper Wick: ${c.wick.toFixed(2)} | ` +
                `Wick %: ${c.wickPercent.toFixed(4)}%`
            );

        });

    } catch (err) {

        console.error(
            "Error:",
            err.response?.data || err.message
        );

    }
}

main();
