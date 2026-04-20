import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";

const FAST = 7;
const SLOW = 25;
const LOOKBACK = 100;

const CONCURRENCY = 8;
const limit = pLimit(CONCURRENCY);

let scannedCount = 0;

// ===== SMA =====
function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ===== Get Futures Pairs =====
async function getFuturesUSDTPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(
      s =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING"
    )
    .map(s => s.symbol);
}

// ===== Get Candles =====
async function getCandleData(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });

  return data.map(c => parseFloat(c[4])); // close prices only
}

// ===== Detect Cross (Last Closed Candle) =====
function detectCross(closes) {
  if (closes.length < SLOW + 2) return null;

  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  const fastPrev = maFast[i - 1];
  const fastNow = maFast[i];

  const slowPrev = maSlow[i - 1];
  const slowNow = maSlow[i];

  if (
    fastPrev === null ||
    fastNow === null ||
    slowPrev === null ||
    slowNow === null
  ) return null;

  if (fastPrev <= slowPrev && fastNow > slowNow) return "BULLISH";
  if (fastPrev >= slowPrev && fastNow < slowNow) return "BEARISH";

  return null;
}

// ===== Detect Direction Only (No Cross Required) =====
function detectDirection(closes) {
  if (closes.length < SLOW) return null;

  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  const fast = maFast[i];
  const slow = maSlow[i];

  if (fast === null || slow === null) return null;

  if (fast > slow) return "BULLISH";
  if (fast < slow) return "BEARISH";

  return null;
}

// ===== Main Scanner =====
async function scan() {
  console.log("\n🚀 1D Cross + 4H & 1H Alignment Scanner Starting...\n");

  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const dailyCloses = await getCandleData(symbol, "1d");
        const cross1D = detectCross(dailyCloses);

        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        if (!cross1D) return;

        // Lower timeframe alignment
        const closes4H = await getCandleData(symbol, "4h");
        const closes1H = await getCandleData(symbol, "1h");

        const dir4H = detectDirection(closes4H);
        const dir1H = detectDirection(closes1H);

        if (dir4H === cross1D && dir1H === cross1D) {
          console.log(
            `\n🔥 ${symbol} — 1D ${cross1D} CROSS | 4H + 1H Aligned ✅`
          );
        }

      } catch {
        scannedCount++;
      }
    })
  );

  await Promise.all(tasks);

  console.log("\n\n✅ Scan complete.\n");
}

scan();
