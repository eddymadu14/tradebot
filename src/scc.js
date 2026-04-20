import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 300;
const CONCURRENCY = 8;
const limit = pLimit(CONCURRENCY);

// ===== Parse CLI args =====
const args = process.argv.slice(2);
let timestampFilter = args[0] ? new Date(args[0]).getTime() : null;
let rangeCandles = args[1] ? parseInt(args[1], 10) : 0;

// ===== SMA =====
function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

// ===== EMA =====
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  ema[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ===== ATR =====
function calculateATR(highs, lows, closes, period) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  const atr = [];
  for (let i = period - 1; i < trs.length; i++) {
    atr.push(trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return atr;
}

// ===== Detect Cross =====
function detectCross(closes) {
  if (closes.length < SLOW + 2) return null;
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);
  const i = closes.length - 1;
  const fastPrev = maFast[i - 1], fastNow = maFast[i];
  const slowPrev = maSlow[i - 1], slowNow = maSlow[i];
  if (!fastPrev || !fastNow || !slowPrev || !slowNow) return null;
  if (fastPrev <= slowPrev && fastNow > slowNow) return "BULLISH";
  if (fastPrev >= slowPrev && fastNow < slowNow) return "BEARISH";
  return null;
}

// ===== Detect Recent Cross =====
function detectRecentCross(closes, lookbackCandles = 5) {
  if (closes.length < SLOW + lookbackCandles + 2) return null;
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);
  const lastIndex = closes.length - 2; // ignore forming candle
  for (let i = lastIndex; i > lastIndex - lookbackCandles; i--) {
    if (!maFast[i - 1] || !maFast[i] || !maSlow[i - 1] || !maSlow[i]) continue;
    if (maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i]) return "BULLISH";
    if (maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i]) return "BEARISH";
  }
  return null;
}

// ===== Direction =====
function getDirection(closes) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);
  const i = closes.length - 1;
  if (!maFast[i] || !maSlow[i]) return null;
  return maFast[i] > maSlow[i] ? "BULLISH" : "BEARISH";
}

// ===== Filters =====
function checkFilters({ closes, highs, lows, volumes, maFast }) {
  const score = { total: 0, criteria: [] };
  const ema200 = calculateEMA(closes, 200);
  const lastPrice = closes[closes.length - 1];
  const trend = lastPrice > ema200[ema200.length - 1] ? "BULLISH" : "BEARISH";
  score.total++;
  score.criteria.push(`Trend: ${trend}`);

  const atr = calculateATR(highs, lows, closes, 14);
  const atrLast = atr[atr.length - 1];
  const atrAvg = atr.slice(-5).reduce((a, b) => a + b, 0) / 5;
  if (atrLast > atrAvg) {
    score.total++;
    score.criteria.push("ATR Expansion ✅");
  }

  const volLast = volumes[volumes.length - 1];
  const volAvg = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  if (volLast >= volAvg * 1.5) {
    score.total++;
    score.criteria.push("Volume Spike ✅");
  }

  const slope = (maFast[maFast.length - 1] - maFast[maFast.length - 2]) / maFast[maFast.length - 2];
  if (Math.abs(slope) >= 0.001) {
    score.total++;
    score.criteria.push("Slope Strength ✅");
  }

  const atrAvg20 = atr.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (atrLast > atrAvg20 * 1.2) {
    score.total++;
    score.criteria.push("Trending Market ✅");
  }

  return score;
}

// ===== Get Pairs =====
async function getFuturesUSDTPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(s => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
    .map(s => s.symbol);
}

// ===== Get Candles =====
async function getCandleData(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });
  return {
    closes: data.map(c => parseFloat(c[4])),
    highs: data.map(c => parseFloat(c[2])),
    lows: data.map(c => parseFloat(c[3])),
    volumes: data.map(c => parseFloat(c[5])),
    openTimes: data.map(c => c[0]),
    closeTimes: data.map(c => c[6])
  };
}

// ===== Find Closest Candle =====
function findClosestCandle(candles, timestamp) {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].closeTime <= timestamp) return { index: i, candle: candles[i] };
  }
  return null;
}

// ===== Main Scanner =====
async function scan() {
  console.log("\n🚀 Multi-Timeframe MA Alignment Scanner Starting...\n");

  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  let scannedCount = 0;

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const h1 = await getCandleData(symbol, "1h");
        const h4 = await getCandleData(symbol, "4h");
        const d1 = await getCandleData(symbol, "1d");

        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        // ===== Determine H1 range =====
        let h1Indexes = [...Array(h1.closes.length).keys()];
        if (timestampFilter) {
          const closest = findClosestCandle(
            h1.openTimes.map((t, i) => ({ closeTime: h1.closeTimes[i], index: i })),
            timestampFilter
          );
          if (!closest) return;
          const start = Math.max(0, closest.index - rangeCandles);
          const end = Math.min(h1.closes.length - 1, closest.index + rangeCandles);
          h1Indexes = [];
          for (let i = start; i <= end; i++) h1Indexes.push(i);
        }

        // ===== Scan each H1 candle in range =====
        for (const i of h1Indexes) {
          const fastPrev = calculateSMA(h1.closes, FAST)[i - 1];
          const fastNow = calculateSMA(h1.closes, FAST)[i];
          const slowPrev = calculateSMA(h1.closes, SLOW)[i - 1];
          const slowNow = calculateSMA(h1.closes, SLOW)[i];

          if (!fastPrev || !fastNow || !slowPrev || !slowNow) continue;

          let cross = null;
          if (fastPrev <= slowPrev && fastNow > slowNow) cross = "BULLISH";
          if (fastPrev >= slowPrev && fastNow < slowNow) cross = "BEARISH";
          if (!cross) continue;

          // 4H alignment
          const h4Match = findClosestCandle(
            h4.openTimes.map((t, idx) => ({ closeTime: h4.closeTimes[idx], index: idx })),
            h1.closeTimes[i]
          );
          if (!h4Match) continue;
          const h4Dir = getDirection(h4.closes.slice(0, h4Match.index + 1));
          if (h4Dir !== cross) continue;

          // 1D alignment: recent 5 days
          const recentD1Cross = detectRecentCross(d1.closes, 5);
          if (!recentD1Cross || recentD1Cross !== cross) continue;

          // Filters & score
          const maFastH1 = calculateSMA(h1.closes, FAST);
          const score = checkFilters({
            closes: h1.closes,
            highs: h1.highs,
            lows: h1.lows,
            volumes: h1.volumes,
            maFast: maFastH1
          });

          console.log(
            `\n🔥 ${symbol} — ${cross} ALIGNMENT | H1: ${new Date(h1.closeTimes[i]).toISOString()} | Score: ${score.total} | ${score.criteria.join(", ")}`
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
