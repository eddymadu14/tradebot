// scanner.mjs

import fs from "fs/promises";

const BINANCE_FAPI = "https://fapi.binance.com";

const MIN_VOLUME = 10_000_000;
const CANDLE_LIMIT = 30;
const MIN_SAMPLE_SIZE = 15;
const MAX_STD_DEV = 0.6;

const qualifyingPairs = new Set();

// -----------------------------
// FETCH ALL FUTURES PAIRS
// -----------------------------
async function getFuturesPairs() {
  try {
    const exchangeInfoRes = await fetch(
      `${BINANCE_FAPI}/fapi/v1/exchangeInfo`
    );

    const tickerRes = await fetch(
      `${BINANCE_FAPI}/fapi/v1/ticker/24hr`
    );

    const exchangeInfo =
      await exchangeInfoRes.json();

    const tickers =
      await tickerRes.json();

    const volumeMap = {};

    for (const ticker of tickers) {
      volumeMap[ticker.symbol] =
        Number(ticker.quoteVolume);
    }

    return exchangeInfo.symbols.filter(
      (symbol) => {
        return (
          symbol.contractType ===
            "PERPETUAL" &&
          symbol.status === "TRADING" &&
          symbol.quoteAsset ===
            "USDT" &&
          volumeMap[symbol.symbol] >=
            MIN_VOLUME
        );
      }
    );
  } catch (err) {
    console.error(
      "Failed to fetch futures pairs:",
      err.message
    );

    return [];
  }
}

// -----------------------------
// FETCH DAILY CANDLES
// -----------------------------
async function getDailyCandles(symbol) {
  try {
    const res = await fetch(
      `${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=${CANDLE_LIMIT}`
    );

    return await res.json();
  } catch (err) {
    console.error(
      `Error fetching candles for ${symbol}:`,
      err.message
    );

    return [];
  }
}

// -----------------------------
// STANDARD DEVIATION
// -----------------------------
function standardDeviation(values) {
  if (!values.length) return 0;

  const avg =
    values.reduce((a, b) => a + b, 0) /
    values.length;

  const squareDiffs = values.map((v) => {
    const diff = v - avg;

    return diff * diff;
  });

  const avgSquareDiff =
    squareDiffs.reduce((a, b) => a + b, 0) /
    values.length;

  return Math.sqrt(avgSquareDiff);
}

// -----------------------------
// ANALYZE WICK CONSISTENCY
// -----------------------------
function analyzeCandles(symbol, candles) {
  const bullishLowerWicks = [];
  const bearishUpperWicks = [];

  for (const candle of candles) {
    const open = Number(candle[1]);
    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);

    // Skip invalid candles
    if (
      !open ||
      !high ||
      !low ||
      !close
    ) {
      continue;
    }

    // -----------------------------
    // BULLISH CANDLE
    // -----------------------------
    if (close > open) {
      const lowerWick =
        ((open - low) / open) * 100;

      bullishLowerWicks.push(lowerWick);
    }

    // -----------------------------
    // BEARISH CANDLE
    // -----------------------------
    if (close < open) {
      const upperWick =
        ((high - open) / open) * 100;

      bearishUpperWicks.push(upperWick);
    }
  }

  const results = [];

  // -----------------------------
  // BULLISH ANALYSIS
  // -----------------------------
  if (
    bullishLowerWicks.length >=
    MIN_SAMPLE_SIZE
  ) {
    const avg =
      bullishLowerWicks.reduce(
        (a, b) => a + b,
        0
      ) / bullishLowerWicks.length;

    const stdDev =
      standardDeviation(
        bullishLowerWicks
      );

    let consistency =
      (1 - stdDev / avg) * 100;

    consistency = Math.max(
      0,
      Math.min(100, consistency)
    );

    // FILTER BY MAX STD DEV
    if (stdDev <= MAX_STD_DEV) {
      qualifyingPairs.add(symbol);

      results.push({
        pair: symbol,
        type: "BULLISH",
        consistency:
          consistency.toFixed(2),
        avgWick: avg.toFixed(4),
        stdDev: stdDev.toFixed(4),
        sampleSize:
          bullishLowerWicks.length,
      });
    }
  }

  // -----------------------------
  // BEARISH ANALYSIS
  // -----------------------------
  if (
    bearishUpperWicks.length >=
    MIN_SAMPLE_SIZE
  ) {
    const avg =
      bearishUpperWicks.reduce(
        (a, b) => a + b,
        0
      ) / bearishUpperWicks.length;

    const stdDev =
      standardDeviation(
        bearishUpperWicks
      );

    let consistency =
      (1 - stdDev / avg) * 100;

    consistency = Math.max(
      0,
      Math.min(100, consistency)
    );

    // FILTER BY MAX STD DEV
    if (stdDev <= MAX_STD_DEV) {
      qualifyingPairs.add(symbol);

      results.push({
        pair: symbol,
        type: "BEARISH",
        consistency:
          consistency.toFixed(2),
        avgWick: avg.toFixed(4),
        stdDev: stdDev.toFixed(4),
        sampleSize:
          bearishUpperWicks.length,
      });
    }
  }

  return results;
}

// -----------------------------
// MAIN SCANNER
// -----------------------------
async function runScanner() {
  console.log(
    "Fetching Binance Futures pairs..."
  );

  const pairs =
    await getFuturesPairs();

  console.log(
    `Found ${pairs.length} eligible pairs\n`
  );

  const allResults = [];

  for (const pairData of pairs) {
    const symbol = pairData.symbol;

    console.log(
      `Scanning ${symbol}...`
    );

    const candles =
      await getDailyCandles(symbol);

    if (
      !Array.isArray(candles)
    ) {
      continue;
    }

    const analysis =
      analyzeCandles(
        symbol,
        candles
      );

    allResults.push(...analysis);

    // Prevent API hammering
    await new Promise(
      (resolve) =>
        setTimeout(resolve, 100)
    );
  }

  // -----------------------------
  // SORT RESULTS
  // -----------------------------
  allResults.sort(
    (a, b) =>
      Number(a.stdDev) -
      Number(b.stdDev)
  );

  // -----------------------------
  // FORMAT DETAILED OUTPUT
  // -----------------------------
  let detailedOutput = "";

  for (const result of allResults) {
    detailedOutput +=
`PAIR: ${result.pair}
TYPE: ${result.type}
CONSISTENCY: ${result.consistency}%
AVG WICK: ${result.avgWick}%
STD DEV: ${result.stdDev}%
SAMPLES: ${result.sampleSize}

`;
  }

  // -----------------------------
  // SAVE DETAILED RESULTS
  // -----------------------------
  await fs.writeFile(
    "wick_consistency_4h.txt",
    detailedOutput
  );

  // -----------------------------
  // SAVE QUALIFIED PAIRS ONLY
  // -----------------------------
  const pairList =
    [...qualifyingPairs].join(
      "\n"
    );

  await fs.writeFile(
    "qualified_pairs.txt",
    pairList
  );

  console.log(
    "\nScan Complete."
  );

  console.log(
    "Detailed results saved to wick_consistency_results.txt"
  );

  console.log(
    "Qualified pairs saved to qualified_pairs.txt"
  );
}

runScanner();
