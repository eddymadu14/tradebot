// =============================================================
// WICK CONSISTENCY SCANNER
// PART 1 OF 2
// Node.js ES Module
// =============================================================

import axios from "axios";
import fs from "fs";
import { createObjectCsvWriter } from "csv-writer";

// =============================================================
// CONFIG
// =============================================================

const BINANCE =
  "https://fapi.binance.com/fapi/v1";

const INTERVAL = "1d";
const LOOKBACK = 40;

// Minimum 24hr USDT Volume
const MIN_24H_VOLUME = 10_000_000;

// Ignore candles with tiny bodies
const MIN_BODY_PERCENT = 0.10;

// Minimum bullish/bearish samples required
const MIN_BULLISH = 10;
const MIN_BEARISH = 10;

// Maximum acceptable CV
const MAX_CV = 0.80;

// Save outputs
const SAVE_TXT = true;
const SAVE_CSV = true;

// =============================================================
// FETCH FUTURES PAIRS
// =============================================================

async function getPairs() {

    const url =
        `${BINANCE}/ticker/24hr`;

    const { data } = await axios.get(url);

    return data
        .filter(pair =>
            pair.symbol.endsWith("USDT") &&
            Number(pair.quoteVolume) >= MIN_24H_VOLUME
        )
        .map(pair => pair.symbol);

}

// =============================================================
// FETCH KLINES
// =============================================================

async function getCandles(symbol) {

    const url =
        `${BINANCE}/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${LOOKBACK}`;

    const { data } = await axios.get(url);

    return data;

}

// =============================================================
// BASIC STATS
// =============================================================

function average(values) {

    if (!values.length) return 0;

    return values.reduce((a, b) => a + b, 0) / values.length;

}

function minimum(values) {

    if (!values.length) return 0;

    return Math.min(...values);

}

function maximum(values) {

    if (!values.length) return 0;

    return Math.max(...values);

}

function median(values) {

    if (!values.length) return 0;

    const sorted =
        [...values].sort((a, b) => a - b);

    const mid =
        Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {

        return (sorted[mid - 1] + sorted[mid]) / 2;

    }

    return sorted[mid];

}

function standardDeviation(values) {

    if (values.length <= 1)
        return 0;

    const avg =
        average(values);

    const variance =
        values.reduce(
            (sum, value) =>
                sum + Math.pow(value - avg, 2),
            0
        ) / values.length;

    return Math.sqrt(variance);

}

function coefficientVariation(values) {

    const avg =
        average(values);

    if (avg === 0)
        return 999;

    return standardDeviation(values) / avg;

}

// =============================================================
// ANALYZE ONE PAIR
// =============================================================

function analyzeCandles(symbol, candles) {

    const bullishLower = [];

    const bearishUpper = [];

    for (const candle of candles) {

        const open =
            Number(candle[1]);

        const high =
            Number(candle[2]);

        const low =
            Number(candle[3]);

        const close =
            Number(candle[4]);

        const bodyPercent =
            (Math.abs(close - open) / close) * 100;

        // Ignore tiny-body candles
        if (bodyPercent < MIN_BODY_PERCENT)
            continue;

        // Bullish candle
        if (close > open) {

            const lowerWick =
                ((Math.min(open, close) - low) / close) * 100;

            bullishLower.push(lowerWick);

        }

        // Bearish candle
        else if (close < open) {

            const upperWick =
                ((high - Math.max(open, close)) / close) * 100;

            bearishUpper.push(upperWick);

        }

    }

    // Not enough samples

    if (
        bullishLower.length < MIN_BULLISH ||
        bearishUpper.length < MIN_BEARISH
    ) {

        return null;

    }

    const bullCV =
        coefficientVariation(bullishLower);

    const bearCV =
        coefficientVariation(bearishUpper);

    const score =
        (bullCV + bearCV) / 2;

    if (score > MAX_CV)
        return null;

    return {

        symbol,

        bullishSamples:
            bullishLower.length,

        bearishSamples:
            bearishUpper.length,

        bullAverage:
            average(bullishLower),

        bearAverage:
            average(bearishUpper),

        bullMedian:
            median(bullishLower),

        bearMedian:
            median(bearishUpper),

        bullMinimum:
            minimum(bullishLower),

        bearMinimum:
            minimum(bearishUpper),

        bullMaximum:
            maximum(bullishLower),

        bearMaximum:
            maximum(bearishUpper),

        bullStd:
            standardDeviation(bullishLower),

        bearStd:
            standardDeviation(bearishUpper),

        bullCV,

        bearCV,

        score

    };

}

// =============================================================
// RESULTS ARRAY
// =============================================================

const results = [];

// =============================================================
// WICK CONSISTENCY SCANNER
// PART 2 OF 2
// =============================================================

// Scan all pairs
async function scanPairs() {

    const pairs = await getPairs();

    console.log(`\nScanning ${pairs.length} USDT Futures pairs...\n`);

    let scanned = 0;

    for (const symbol of pairs) {

        try {

            const candles = await getCandles(symbol);

            const stats = analyzeCandles(symbol, candles);

            if (stats)
                results.push(stats);

        } catch (err) {

            console.log(`Failed: ${symbol}`);

        }

        scanned++;

        process.stdout.write(
            `\rProgress : ${scanned}/${pairs.length}`
        );

    }

    console.log("\n");

}

// =============================================================
// SORT RESULTS
// =============================================================

function sortResults() {

    results.sort((a, b) => a.score - b.score);

}

// =============================================================
// DISPLAY RESULTS
// =============================================================

function displayResults() {

    console.log(
        "\n================ WICK CONSISTENCY RANKING ================\n"
    );

    console.table(

        results.map(r => ({

            Pair: r.symbol,

            BullAvg: r.bullAverage.toFixed(2) + "%",

            BullCV: r.bullCV.toFixed(3),

            BearAvg: r.bearAverage.toFixed(2) + "%",

            BearCV: r.bearCV.toFixed(3),

            Score: r.score.toFixed(3)

        }))

    );

}

// =============================================================
// SAVE TXT
// =============================================================

function saveTxt() {

    if (!SAVE_TXT)
        return;

    let text = "";

    text +=
        "=========== WICK CONSISTENCY REPORT ===========\n\n";

    for (const r of results) {

        text +=
`PAIR : ${r.symbol}

Bullish Lower Wicks

Samples : ${r.bullishSamples}
Average : ${r.bullAverage.toFixed(3)}%
Median  : ${r.bullMedian.toFixed(3)}%
Minimum : ${r.bullMinimum.toFixed(3)}%
Maximum : ${r.bullMaximum.toFixed(3)}%
Std Dev : ${r.bullStd.toFixed(3)}
CV      : ${r.bullCV.toFixed(3)}

Bearish Upper Wicks

Samples : ${r.bearishSamples}
Average : ${r.bearAverage.toFixed(3)}%
Median  : ${r.bearMedian.toFixed(3)}%
Minimum : ${r.bearMinimum.toFixed(3)}%
Maximum : ${r.bearMaximum.toFixed(3)}%
Std Dev : ${r.bearStd.toFixed(3)}
CV      : ${r.bearCV.toFixed(3)}

Overall Score : ${r.score.toFixed(3)}

------------------------------------------------------------

`;

    }

    fs.writeFileSync(
        "wick_consistency_report.txt",
        text
    );

    console.log(
        "TXT report saved."
    );

}

// =============================================================
// SAVE CSV
// =============================================================

async function saveCsv() {

    if (!SAVE_CSV)
        return;

    const writer = createObjectCsvWriter({

        path: "wick_consistency_report.csv",

        header: [

            { id: "symbol", title: "PAIR" },

            { id: "bullishSamples", title: "BULL_SAMPLES" },

            { id: "bearishSamples", title: "BEAR_SAMPLES" },

            { id: "bullAverage", title: "BULL_AVG" },

            { id: "bearAverage", title: "BEAR_AVG" },

            { id: "bullMedian", title: "BULL_MEDIAN" },

            { id: "bearMedian", title: "BEAR_MEDIAN" },

            { id: "bullMinimum", title: "BULL_MIN" },

            { id: "bearMinimum", title: "BEAR_MIN" },

            { id: "bullMaximum", title: "BULL_MAX" },

            { id: "bearMaximum", title: "BEAR_MAX" },

            { id: "bullStd", title: "BULL_STD" },

            { id: "bearStd", title: "BEAR_STD" },

            { id: "bullCV", title: "BULL_CV" },

            { id: "bearCV", title: "BEAR_CV" },

            { id: "score", title: "OVERALL_SCORE" }

        ]

    });

    await writer.writeRecords(results);

    console.log(
        "CSV report saved."
    );

}

// =============================================================
// MAIN
// =============================================================

async function main() {

    console.time("Completed In");

    await scanPairs();

    sortResults();

    displayResults();

    saveTxt();

    await saveCsv();

    console.timeEnd("Completed In");

}

main().catch(console.error);
