import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";

const FAST = 7;
const SLOW = 25;
const LOOKBACK = 120;

const CONCURRENCY = 6;
const limit = pLimit(CONCURRENCY);

let scannedCount = 0;

// ================= SMA =================
function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ================= FETCH PAIRS =================
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

// ================= FETCH CANDLES =================
async function getCandleData(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });

  return {
    closes: data.map(c => parseFloat(c[4])),
    highs: data.map(c => parseFloat(c[2])),
    lows: data.map(c => parseFloat(c[3])),
    volumes: data.map(c => parseFloat(c[5]))
  };
}

// ================= MA CROSS =================
function detectCross(closes) {
  if (closes.length < SLOW + 2) return null;

  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  if (
    maFast[i - 1] === null ||
    maSlow[i - 1] === null
  ) return null;

  if (maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i])
    return "BULLISH";

  if (maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i])
    return "BEARISH";

  return null;
}

// ================= DIRECTION =================
function detectDirection(closes) {
  if (closes.length < SLOW) return null;

  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  if (maFast[i] > maSlow[i]) return "BULLISH";
  if (maFast[i] < maSlow[i]) return "BEARISH";

  return null;
}

// ================= STRUCTURE BREAK =================
function structureBreak(highs, lows, direction) {
  const lookback = 20;
  const recentHigh = Math.max(...highs.slice(-lookback - 1, -1));
  const recentLow = Math.min(...lows.slice(-lookback - 1, -1));

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  if (direction === "BULLISH" && lastHigh > recentHigh)
    return true;

  if (direction === "BEARISH" && lastLow < recentLow)
    return true;

  return false;
}

// ================= LIQUIDITY SWEEP =================
function liquiditySweep(highs, lows, direction) {
  const lookback = 20;

  const prevHigh = Math.max(...highs.slice(-lookback - 2, -2));
  const prevLow = Math.min(...lows.slice(-lookback - 2, -2));

  const sweepHigh = highs[highs.length - 2] > prevHigh;
  const sweepLow = lows[lows.length - 2] < prevLow;

  if (direction === "BULLISH" && sweepLow) return true;
  if (direction === "BEARISH" && sweepHigh) return true;

  return false;
}

// ================= VOLUME EXPANSION =================
function volumeExpansion(volumes) {
  const lastVol = volumes[volumes.length - 1];
  const avgVol =
    volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  return lastVol > avgVol * 1.7;
}

// ================= MAIN SCANNER =================
async function scan() {
  console.log("\n🚀 Elite 1D Cross Scanner (With Structure + Liquidity + Volume)\n");

  const pairs = await getFuturesUSDTPairs();
  console.log(`Total Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        // 1D DATA
        const daily = await getCandleData(symbol, "1d");
        const cross = detectCross(daily.closes);

        if (!cross) return;

        // Alignment
        const h4 = await getCandleData(symbol, "4h");
        const h1 = await getCandleData(symbol, "1h");

        const dir4 = detectDirection(h4.closes);
        const dir1 = detectDirection(h1.closes);

        if (dir4 !== cross || dir1 !== cross) return;

        // Structure Break
        if (!structureBreak(daily.highs, daily.lows, cross)) return;

        // Liquidity Sweep
        if (!liquiditySweep(daily.highs, daily.lows, cross)) return;

        // Volume Expansion
        if (!volumeExpansion(daily.volumes)) return;

        console.log(
          `\n🔥 ${symbol} — 1D ${cross} CROSS + Structure Break + Liquidity Sweep + Volume Expansion`
        );

      } catch {
        scannedCount++;
      }
    })
  );

  await Promise.all(tasks);

  console.log("\n\n✅ Scan complete.\n");
}

scan();
