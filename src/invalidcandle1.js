/*
===========================================================
INVALIDATION WICK RESEARCH MODEL (ES MODULE VERSION)
===========================================================

SETUP:
-----------------------------------------------------------

1. package.json

{
  "type": "module"
}

2. Install axios

npm install axios

3. Run

node invalidation.js

===========================================================
*/

import axios from "axios";

const SYMBOL = "ZECUSDT";

const DAILY_INTERVAL = "1d";
const INTRADAY_INTERVAL = "5m";

const DAILY_LIMIT = 30;
const SAMPLE_SIZE = 20;

const BINANCE_URL = "https://api.binance.com/api/v3/klines";

// =======================================================
// FETCH CANDLES
// =======================================================

async function fetchCandles(
  symbol,
  interval,
  limit,
  startTime,
  endTime
) {
  const params = {
    symbol,
    interval,
    limit,
  };

  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;

  const response = await axios.get(BINANCE_URL, {
    params,
  });

  return response.data.map((candle) => ({
    openTime: candle[0],
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    closeTime: candle[6],
  }));
}

// =======================================================
// DETERMINE DAILY BIAS
// =======================================================

function getBias(day) {
  if (day.close > day.open) return "bullish";
  if (day.close < day.open) return "bearish";

  return "neutral";
}

// =======================================================
// CALCULATE INVALIDATION WICK RATIO
// =======================================================

function calculateInvalidationRatio(day, intradayCandles) {
  const bias = getBias(day);

  if (bias === "neutral") {
    return null;
  }

  const open = day.open;

  // =====================================================
  // BULLISH DAY
  // =====================================================

  if (bias === "bullish") {
    let initialHigh = open;
    let sweepOccurred = false;

    for (const candle of intradayCandles) {
      // Track bullish expansion BEFORE sweep
      if (candle.high > initialHigh) {
        initialHigh = candle.high;
      }

      // Opposite sweep occurs
      // price trades below daily open
      if (candle.low < open) {
        sweepOccurred = true;
        break;
      }
    }

    // Ignore invalid structures
    if (!sweepOccurred) {
      return null;
    }

    const ratio = (initialHigh - open) / open;

    return {
      date: new Date(day.openTime).toISOString(),
      bias,
      open,
      initialHigh,
      ratio,
      ratioPercent: (ratio * 100).toFixed(4),
    };
  }

  // =====================================================
  // BEARISH DAY
  // =====================================================

  if (bias === "bearish") {
    let initialLow = open;
    let sweepOccurred = false;

    for (const candle of intradayCandles) {
      // Track bearish expansion BEFORE sweep
      if (candle.low < initialLow) {
        initialLow = candle.low;
      }

      // Opposite sweep occurs
      // price trades above daily open
      if (candle.high > open) {
        sweepOccurred = true;
        break;
      }
    }

    // Ignore invalid structures
    if (!sweepOccurred) {
      return null;
    }

    const ratio = (open - initialLow) / open;

    return {
      date: new Date(day.openTime).toISOString(),
      bias,
      open,
      initialLow,
      ratio,
      ratioPercent: (ratio * 100).toFixed(4),
    };
  }

  return null;
}

// =======================================================
// MAIN
// =======================================================

async function main() {
  try {
    console.log("\nFetching daily candles...\n");

    const dailyCandles = await fetchCandles(
      SYMBOL,
      DAILY_INTERVAL,
      DAILY_LIMIT
    );

    const results = [];

    for (const day of dailyCandles) {
      console.log(
        `Processing: ${new Date(
          day.openTime
        ).toISOString()}`
      );

      const intradayCandles = await fetchCandles(
        SYMBOL,
        INTRADAY_INTERVAL,
        288,
        day.openTime,
        day.closeTime
      );

      const result = calculateInvalidationRatio(
        day,
        intradayCandles
      );

      if (result) {
        results.push(result);
      }

      if (results.length >= SAMPLE_SIZE) {
        break;
      }
    }

    // ===================================================
    // OUTPUT RESULTS
    // ===================================================

    console.log("\n================================================");
    console.log("VALID INVALIDATION DAYS");
    console.log("================================================\n");

    results.forEach((r, index) => {
      console.log(
        `${index + 1}. ${r.date}`
      );

      console.log({
        bias: r.bias,
        ratioPercent: `${r.ratioPercent}%`,
      });

      console.log("-----------------------------------");
    });

    // ===================================================
    // AVERAGE
    // ===================================================

    const average =
      results.reduce((sum, r) => sum + r.ratio, 0) /
      results.length;

    console.log("\n================================================");
    console.log("FINAL STATISTICS");
    console.log("================================================\n");

    console.log(`Samples Used: ${results.length}`);

    console.log(
      `Average Ratio: ${(average * 100).toFixed(4)}%`
    );

  } catch (error) {
    console.error(
      "\nERROR:\n",
      error.response?.data || error.message
    );
  }
}

main();
