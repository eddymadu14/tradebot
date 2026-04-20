
import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "4h";
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
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atr = [];
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    const sum = slice.reduce((a, b) => a + b, 0);
    atr.push(sum / period);
  }
  return atr;
}

// ===== Futures Pairs =====
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
async function getCandleData(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval: INTERVAL, limit: LOOKBACK }
  });
  const closes = data.map(c => parseFloat(c[4]));
  const highs = data.map(c => parseFloat(c[2]));
  const lows = data.map(c => parseFloat(c[3]));
  const volumes = data.map(c => parseFloat(c[5]));
  return { closes, highs, lows, volumes };
}

// ===== Detect Cross =====
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
  )
    return null;
  if (fastPrev <= slowPrev && fastNow > slowNow) return "BULLISH";
  if (fastPrev >= slowPrev && fastNow < slowNow) return "BEARISH";
  return null;
}

// ===== Filter Checks =====
function checkFilters({ closes, highs, lows, volumes, maFast }) {
  const score = { total: 0, criteria: [] };

  // 200 EMA trend
  const ema200 = calculateEMA(closes, 200);
  const lastPrice = closes[closes.length - 1];
  const trend = lastPrice > ema200[ema200.length - 1] ? "BULLISH" : "BEARISH";
  score.total++;
  score.criteria.push(`Trend: ${trend}`);

  // ATR expansion
  const atr = calculateATR(highs, lows, closes, 14);
  const atrLast = atr[atr.length - 1];
  const atrAvg = atr.slice(-5).reduce((a, b) => a + b, 0) / 5;
  if (atrLast > atrAvg) {
    score.total++;
    score.criteria.push("ATR Expansion ✅");
  }

  // Volume spike
  const volLast = volumes[volumes.length - 1];
  const volAvg = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  if (volLast >= volAvg * 1.5) {
    score.total++;
    score.criteria.push("Volume Spike ✅");
  }

  // Slope strength MA7
  const slope = (maFast[maFast.length - 1] - maFast[maFast.length - 2]) / maFast[maFast.length - 2];
  if (Math.abs(slope) >= 0.001) {
    score.total++;
    score.criteria.push("Slope Strength ✅");
  }

  // Market regime: ATR trending
  const atrAvg20 = atr.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (atrLast > atrAvg20 * 1.2) {
    score.total++;
    score.criteria.push("Trending Market ✅");
  }

  return score;
}

// ===== Main Scanner =====
async function scan() {
  console.log("\n🚀 Binance Futures USDT MA(7/25) Scoring Scanner Starting...\n");
  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const { closes, highs, lows, volumes } = await getCandleData(symbol);
        const maFast = calculateSMA(closes, FAST);
        const cross = detectCross(closes);

        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        if (cross) {
          const score = checkFilters({ closes, highs, lows, volumes, maFast });
          console.log(
            `\n🔥 ${symbol} — ${cross} CROSS | Score: ${score.total} | ${score.criteria.join(", ")}`
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
