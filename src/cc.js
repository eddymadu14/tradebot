import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1h";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 60;

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

// ===== GET ALL USDT PERPETUAL FUTURES =====
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

// ===== GET CANDLES =====
async function getCloses(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: {
      symbol,
      interval: INTERVAL,
      limit: LOOKBACK
    }
  });

  return data.map(c => parseFloat(c[4]));
}

// ===== CROSS DETECTION =====
function detectCross(prices) {
  if (prices.length < SLOW + 2) return null;

  const maFast = calculateSMA(prices, FAST);
  const maSlow = calculateSMA(prices, SLOW);

  const i = prices.length - 1;

  const fastPrev = maFast[i - 1];
  const fastNow = maFast[i];

  const slowPrev = maSlow[i - 1];
  const slowNow = maSlow[i];

  if (
    fastPrev === null ||
    fastNow === null ||
    slowPrev === null ||
    slowNow === null
  )
    return null;

  if (fastPrev <= slowPrev && fastNow > slowNow)
    return "BULLISH";

  if (fastPrev >= slowPrev && fastNow < slowNow)
    return "BEARISH";

  return null;
}

// ===== MAIN ENGINE =====
async function scan() {
  console.log("\n🚀 Scanning ALL Binance USDT Futures (MA 7/25)...\n");

  const pairs = await getFuturesUSDTPairs();

  console.log(`Total USDT Perpetual Futures Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const prices = await getCloses(symbol);
        const cross = detectCross(prices);

        scannedCount++;
        process.stdout.write(
          `Scanning ${scannedCount}/${pairs.length}\r`
        );

        if (cross) {
          console.log(`\n🔥 ${symbol} — ${cross} CROSS`);
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
