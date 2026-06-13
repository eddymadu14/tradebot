import axios from "axios";

const SYMBOL = "SOLUSDT";
const INTERVAL = "1w";
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
        const timestamp = candle[0];

        const open = parseFloat(candle[1]);
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        const close = parseFloat(candle[4]);

        // Ignore doji candles
        if (close === open) {
            continue;
        }

        // =========================
        // Bullish Candle
        // =========================
        if (close > open && bullish.length < 20) {

            const lowerWick = open - low;

            const lowerWickPercent =
                (lowerWick / open) * 100;

            const bullishData = {
                time: new Date(timestamp).toISOString(),
                open,
                high,
                low,
                close,
                wickSize: lowerWick,
                wickPercent: lowerWickPercent
            };

            bullish.push(bullishData);

            console.log("\n[BULLISH]");
            console.log(bullishData);
        }

        // =========================
        // Bearish Candle
        // =========================
        if (close < open && bearish.length < 20) {

            const upperWick = high - open;

            const upperWickPercent =
                (upperWick / open) * 100;

            const bearishData = {
                time: new Date(timestamp).toISOString(),
                open,
                high,
                low,
                close,
                wickSize: upperWick,
                wickPercent: upperWickPercent
            };

            bearish.push(bearishData);

            console.log("\n[BEARISH]");
            console.log(bearishData);
        }

        // Stop once both are filled
        if (bullish.length >= 20 && bearish.length >= 20) {
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

        let candles = await fetchCandles();

        // ===================================
        // Remove currently forming candle
        // ===================================
        candles.pop();

        // ===================================
        // Reverse so newest CLOSED candles
        // are processed first
        // ===================================
        candles.reverse();

        const stats = calculateWickStats(candles);

        console.log("\n==============================");
        console.log("BTC Futures Wick Analysis");
        console.log("==============================\n");

        console.log(
            `Bullish Candles Analysed: ${stats.bullish.length}`
        );

        console.log(
            `Bearish Candles Analysed: ${stats.bearish.length}\n`
        );

        console.log(
            `Average Bullish Lower Wick %: ${stats.avgBullishLowerWick.toFixed(6)}%`
        );

        console.log(
            `Average Bearish Upper Wick %: ${stats.avgBearishUpperWick.toFixed(6)}%`
        );

        console.log("\n==============================");
        console.log("Bullish Lower Wick Samples");
        console.log("==============================");

        stats.bullish.forEach((c, i) => {

            console.log(`
#${i + 1}
Time: ${c.time}
Open: ${c.open}
High: ${c.high}
Low: ${c.low}
Close: ${c.close}
Lower Wick Size: ${c.wickSize}
Lower Wick %: ${c.wickPercent.toFixed(6)}%
            `);

        });

        console.log("\n==============================");
        console.log("Bearish Upper Wick Samples");
        console.log("==============================");

        stats.bearish.forEach((c, i) => {

            console.log(`
#${i + 1}
Time: ${c.time}
Open: ${c.open}
High: ${c.high}
Low: ${c.low}
Close: ${c.close}
Upper Wick Size: ${c.wickSize}
Upper Wick %: ${c.wickPercent.toFixed(6)}%
            `);

        });

    } catch (error) {

        console.error("\nERROR:");
        console.error(error.message);

        if (error.response) {
            console.error(error.response.data);
        }

    }
}

main();
