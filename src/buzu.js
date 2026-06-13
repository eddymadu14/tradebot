import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1d";
const MIN_VOLUME_USDT = 10_000_000;
const CONCURRENCY = 10;

const limit = pLimit(CONCURRENCY);

/*
  MARUBOZU LOGIC

  Bullish Marubozu:
  - Strong green candle
  - Tiny/no upper wick
  - Tiny/no lower wick

  Bearish Marubozu:
  - Strong red candle
  - Tiny/no upper wick
  - Tiny/no lower wick

  We allow very small wick tolerance.
*/

const WICK_TOLERANCE_PERCENT = 1; // 0.1%

// =========================
// FETCH ALL FUTURES SYMBOLS
// =========================
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

// =========================
// FETCH DAILY CANDLE
// =========================
async function fetchDailyCandle(symbol) {
  const { data } = await axios.get(
    `${BASE_URL}/fapi/v1/klines`,
    {
      params: {
        symbol,
        interval: INTERVAL,
        limit: 1,
      },
    }
  );

  return data[0];
}

// =========================
// MARUBOZU DETECTOR
// =========================
function detectMarubozu(candle) {
  const open = Number(candle[1]);
  const high = Number(candle[2]);
  const low = Number(candle[3]);
  const close = Number(candle[4]);

  const bodySize = Math.abs(close - open);

  if (bodySize === 0) return null;

  const upperWick =
    close > open
      ? high - close
      : high - open;

  const lowerWick =
    close > open
      ? open - low
      : close - low;

  const upperWickPercent =
    (upperWick / bodySize) * 100;

  const lowerWickPercent =
    (lowerWick / bodySize) * 100;

  const isBullish = close > open;
  const isBearish = close < open;

  const isMarubozu =
    upperWickPercent <= WICK_TOLERANCE_PERCENT &&
    lowerWickPercent <= WICK_TOLERANCE_PERCENT;

  if (!isMarubozu) return null;

  return {
    type: isBullish ? "BULLISH" : isBearish ? "BEARISH" : "NEUTRAL",
    open,
    high,
    low,
    close,
    bodySize,
    upperWickPercent: upperWickPercent.toFixed(4),
    lowerWickPercent: lowerWickPercent.toFixed(4),
  };
}

// =========================
// MAIN SCANNER
// =========================
async function scanMarubozu() {
  try {
    console.log("\nFetching futures pairs...\n");

    const symbols = await fetchSymbols();

    console.log(
      `Found ${symbols.length} USDT pairs with volume >= $20M\n`
    );

    const results = [];

    await Promise.all(
      symbols.map((s) =>
        limit(async () => {
          try {
            const candle = await fetchDailyCandle(s.symbol);

            const marubozu = detectMarubozu(candle);

            if (marubozu) {
              results.push({
                symbol: s.symbol,
                volume24h: s.volume.toFixed(0),
                ...marubozu,
              });

              console.log(
                `✅ ${s.symbol} -> ${marubozu.type} MARUBOZU`
              );
            }
          } catch (err) {
            console.log(`Error on ${s.symbol}`);
          }
        })
      )
    );

    console.log("\n========================");
    console.log("MARUBOZU RESULTS");
    console.log("========================\n");

    if (results.length === 0) {
      console.log("No marubozu candles found.");
      return;
    }

    results
      .sort((a, b) => b.volume24h - a.volume24h)
      .forEach((r, i) => {
        console.log(
          `${i + 1}. ${r.symbol}
Type: ${r.type}
24h Volume: $${Number(r.volume24h).toLocaleString()}
Open: ${r.open}
High: ${r.high}
Low: ${r.low}
Close: ${r.close}
Upper Wick %: ${r.upperWickPercent}%
Lower Wick %: ${r.lowerWickPercent}%
--------------------------------------`
        );
      });
  } catch (err) {
    console.error("Scanner Error:", err.message);
  }
}

scanMarubozu();
