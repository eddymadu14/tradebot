import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1d";
const MIN_VOLUME_USDT = 20_000_000;
const CONCURRENCY = 10;

// Practical marubozu settings
const MAX_WICK_PERCENT = 10; // wick <= 5% of total range
const MIN_BODY_PERCENT = 60; // body >= 90% of total range

const limit = pLimit(CONCURRENCY);

// =====================================
// FETCH ALL FUTURES USDT PAIRS
// =====================================
async function fetchSymbols() {
  const { data } = await axios.get(
    `${BASE_URL}/fapi/v1/ticker/24hr`
  );

  return data
    .filter(
      (s) =>
        s.symbol.endsWith("USDT") &&
        Number(s.quoteVolume) >= MIN_VOLUME_USDT
    )
    .map((s) => ({
      symbol: s.symbol,
      volume: Number(s.quoteVolume),
    }));
}

// =====================================
// FETCH CURRENT FORMING DAILY CANDLE
// =====================================
async function fetchCurrentDailyCandle(symbol) {
  const { data } = await axios.get(
    `${BASE_URL}/fapi/v1/klines`,
    {
      params: {
        symbol,
        interval: INTERVAL,
        limit: 1, // current forming candle
      },
    }
  );

  return data[0];
}

// =====================================
// MARUBOZU DETECTOR
// =====================================
function detectMarubozu(candle) {
  const open = Number(candle[1]);
  const high = Number(candle[2]);
  const low = Number(candle[3]);
  const close = Number(candle[4]);

  const range = high - low;

  if (range === 0) return null;

  const bullish = close > open;
  const bearish = close < open;

  if (!bullish && !bearish) return null;

  let upperWick;
  let lowerWick;

  // Bullish candle
  if (bullish) {
    upperWick = high - close;
    lowerWick = open - low;
  }

  // Bearish candle
  if (bearish) {
    upperWick = high - open;
    lowerWick = close - low;
  }

  const body = Math.abs(close - open);

  // Percentages relative to TOTAL candle range
  const bodyPercent = (body / range) * 100;
  const upperWickPercent = (upperWick / range) * 100;
  const lowerWickPercent = (lowerWick / range) * 100;

  const isMarubozu =
    bodyPercent >= MIN_BODY_PERCENT &&
    upperWickPercent <= MAX_WICK_PERCENT &&
    lowerWickPercent <= MAX_WICK_PERCENT;

  if (!isMarubozu) return null;

  return {
    type: bullish ? "BULLISH" : "BEARISH",
    open,
    high,
    low,
    close,
    bodyPercent: bodyPercent.toFixed(2),
    upperWickPercent: upperWickPercent.toFixed(2),
    lowerWickPercent: lowerWickPercent.toFixed(2),
  };
}

// =====================================
// SCANNER
// =====================================
async function scanMarubozu() {
  try {
    console.log("\nFetching futures pairs...\n");

    const symbols = await fetchSymbols();

    console.log(
      `Scanning ${symbols.length} pairs...\n`
    );

    const results = [];

    await Promise.all(
      symbols.map((s) =>
        limit(async () => {
          try {
            const candle =
              await fetchCurrentDailyCandle(s.symbol);

            const marubozu =
              detectMarubozu(candle);

            if (marubozu) {
              results.push({
                symbol: s.symbol,
                volume24h: s.volume,
                ...marubozu,
              });

              console.log(
                `✅ ${s.symbol} -> ${marubozu.type} MARUBOZU`
              );
            }
          } catch (err) {
            console.log(
              `❌ ${s.symbol} -> ${err.message}`
            );
          }
        })
      )
    );

    console.log("\n==========================");
    console.log("MARUBOZU RESULTS");
    console.log("==========================\n");

    if (results.length === 0) {
      console.log(
        "No current forming marubozu candles found."
      );
      return;
    }

    results
      .sort((a, b) => b.volume24h - a.volume24h)
      .forEach((r, i) => {
        console.log(`
${i + 1}. ${r.symbol}
Type: ${r.type}
24h Volume: $${Number(
          r.volume24h
        ).toLocaleString()}

Open: ${r.open}
High: ${r.high}
Low: ${r.low}
Close: ${r.close}

Body %: ${r.bodyPercent}%
Upper Wick %: ${r.upperWickPercent}%
Lower Wick %: ${r.lowerWickPercent}%
----------------------------------------
`);
      });
  } catch (err) {
    console.error(
      "Scanner Error:",
      err.message
    );
  }
}

scanMarubozu();
