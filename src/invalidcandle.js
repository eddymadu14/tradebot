/*
===========================================================
INVALIDATION WICK MODEL — BTCUSDT (BINANCE)
===========================================================

LOGIC:
1. Get daily candles
2. Determine daily bias
3. Get intraday candles inside each daily candle
4. Detect:
   - initial move in direction of final daily bias
   - BEFORE opposite sweep occurs
5. Calculate ratio against daily open

BULLISH:
ratio = (initialHigh - open) / open

BEARISH:
ratio = (open - initialLow) / open

6. Average last N valid candles

===========================================================
INSTALL:
===========================================================

npm install axios

===========================================================
RUN:
===========================================================

node invalidation.js

===========================================================
*/

const axios = require("axios");

const SYMBOL = "BTCUSDT";

const DAILY_INTERVAL = "1d";
const INTRADAY_INTERVAL = "5m";

const DAILY_LIMIT = 30; // fetch more than needed
const SAMPLE_SIZE = 20;

const BINANCE_URL = "https://api.binance.com/api/v3/klines";

// ----------------------------------------------------
// FETCH CANDLES
// ----------------------------------------------------

async function fetchCandles(symbol, interval, limit, startTime, endTime) {
  const params = {
    symbol,
    interval,
    limit,
  };

  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;

  const response = await axios.get(BINANCE_URL, { params });

  return response.data.map((candle) => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    closeTime: candle[6],
  }));
}

// ----------------------------------------------------
// DETERMINE DAILY BIAS
// ----------------------------------------------------

function getBias(day) {
  if (day.close > day.open) return "bullish";
  if (day.close < day.open) return "bearish";
  return "neutral";
}

// ----------------------------------------------------
// FIND INVALIDATION WICK RATIO
// ----------------------------------------------------

function calculateInvalidationRatio(day, intradayCandles) {
  const bias = getBias(day);

  if (bias === "neutral") {
    return null;
  }

  const open = day.open;

  // ------------------------------------------------
  // BULLISH DAY
  // ------------------------------------------------

  if (bias === "bullish") {
    let initialHigh = open;
    let sweepOccurred = false;

    for (const candle of intradayCandles) {
      // BEFORE sweep
      if (!sweepOccurred) {
        // update highest move
        if (candle.high > initialHigh) {
          initialHigh = candle.high;
        }

        // opposite sweep condition
        // price moves below daily open
        if (candle.low < open) {
          sweepOccurred = true;
          break;
        }
      }
    }

    // invalid structure
    if (!sweepOccurred) {
      return null;
    }

    const ratio = (initialHigh - open) / open;

    return {
      date: new Date(day.openTime).toISOString(),
      bias,
      open,
      initialHigh,
      sweepOccurred,
      ratio,
    };
  }

  // ------------------------------------------------
  // BEARISH DAY
  // ------------------------------------------------

  if (bias === "bearish") {
    let initialLow = open;
    let sweepOccurred = false;

    for (const candle of intradayCandles) {
      // BEFORE sweep
      if (!sweepOccurred) {
        // update lowest move
        if (candle.low < initialLow) {
          initialLow = candle.low;
        }

        // opposite sweep condition
        // price moves above daily open
        if (candle.high > open) {
          sweepOccurred = true;
          break;
        }
      }
    }

    // invalid structure
    if (!sweepOccurred) {
      return null;
    }

    const ratio = (open - initialLow) / open;

    return {
      date: new Date(day.openTime).toISOString(),
      bias,
      open,
      initialLow,
      sweepOccurred,
      ratio,
    };
  }

  return null;
}

// ----------------------------------------------------
// MAIN
// ----------------------------------------------------

async function main() {
  try {
    console.log("Fetching daily candles...\n");

    const dailyCandles = await fetchCandles(
      SYMBOL,
      DAILY_INTERVAL,
      DAILY_LIMIT
    );

    const validResults = [];

    for (const day of dailyCandles) {
      const startTime = day.openTime;
      const endTime = day.closeTime;

      console.log(
        `Processing ${new Date(day.openTime).toISOString()}`
      );

      // fetch 5m candles inside daily candle
      const intradayCandles = await fetchCandles(
        SYMBOL,
        INTRADAY_INTERVAL,
        288, // 24h of 5m candles
        startTime,
        endTime
      );

      const result = calculateInvalidationRatio(
        day,
        intradayCandles
      );

      if (result) {
        validResults.push(result);
      }

      // keep latest sample size
      if (validResults.length >= SAMPLE_SIZE) {
        break;
      }
    }

    console.log("\n================================================");
    console.log("VALID RESULTS");
    console.log("================================================\n");

    validResults.forEach((r) => {
      console.log({
        date: r.date,
        bias: r.bias,
        ratioPercent: (r.ratio * 100).toFixed(4) + "%",
      });
    });

    const average =
      validResults.reduce((sum, r) => sum + r.ratio, 0) /
      validResults.length;

    console.log("\n================================================");
    console.log("FINAL STATISTICS");
    console.log("================================================\n");

    console.log(`Samples: ${validResults.length}`);
    console.log(
      `Average Ratio: ${(average * 100).toFixed(4)}%`
    );

  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

main();
