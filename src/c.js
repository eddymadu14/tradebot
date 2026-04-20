import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1h";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 60;

const MIN_24H_VOLUME_USDT = 5_000_000; // futures liquidity filter
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

// ===== GET USDT PERPETUAL FUTURES PAIRS =====
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

// ===== GET 24H VOLUME FILTER =====
async function getLiquidPairs(symbols) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`);

  const volumeMap = new Map();
  data.forEach(s => {
    volumeMap.set(s.symbol, parseFloat(s.quoteVolume));
  });

  return symbols.filter(
    symbol => volumeMap.get(symbol) >= MIN_24H_VOLUME_USDT
  );
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

// ===== CROSS DETECTOR =====
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

// ===== MAIN SCANNER =====
async function scan() {
  console.log("\n🚀 Binance Futures USDT MA(7/25) Scanner Starting...\n");

  const allPairs = await getFuturesUSDTPairs();
  const liquidPairs = await getLiquidPairs(allPairs);

  console.log(`Total Futures Pairs: ${allPairs.length}`);
  console.log(`Liquid Pairs After Filter: ${liquidPairs.length}\n`);

  const tasks = liquidPairs.map(symbol =>
    limit(async () => {
      try {
        const prices = await getCloses(symbol);
        const cross = detectCross(prices);

        scannedCount++;
        process.stdout.write(
          `Scanning ${scannedCount}/${liquidPairs.length}\r`
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
