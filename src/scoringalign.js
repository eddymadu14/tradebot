import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 250;
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

// ===== Get Candles (Dynamic TF) =====
async function getCandleData(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });

  const closes = data.map(c => parseFloat(c[4]));
  const highs = data.map(c => parseFloat(c[2]));
  const lows = data.map(c => parseFloat(c[3]));
  const volumes = data.map(c => parseFloat(c[5]));

  return { closes, highs, lows, volumes };
}

// ===== Detect Cross (Only for 1H) =====
function detectCross(closes) {
  if (closes.length < SLOW + 2) return null;

  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  const fastPrev = maFast[i - 1];
  const fastNow = maFast[i];
  const slowPrev = maSlow[i - 1];
  const slowNow = maSlow[i];

  if (!fastPrev || !fastNow || !slowPrev || !slowNow) return null;

  if (fastPrev <= slowPrev && fastNow > slowNow) return "BULLISH";
  if (fastPrev >= slowPrev && fastNow < slowNow) return "BEARISH";

  return null;
}

// ===== Get Direction (No Cross Needed) =====
function getDirection(closes) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;
  if (!maFast[i] || !maSlow[i]) return null;

  return maFast[i] > maSlow[i] ? "BULLISH" : "BEARISH";
}

// ===== Filter Checks (UNCHANGED LOGIC) =====
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
  const volAvg =
    volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;

  if (volLast >= volAvg * 1.5) {
    score.total++;
    score.criteria.push("Volume Spike ✅");
  }

  const slope =
    (maFast[maFast.length - 1] - maFast[maFast.length - 2]) /
    maFast[maFast.length - 2];

  if (Math.abs(slope) >= 0.001) {
    score.total++;
    score.criteria.push("Slope Strength ✅");
  }

  const atrAvg20 =
    atr.slice(-20).reduce((a, b) => a + b, 0) / 20;

  if (atrLast > atrAvg20 * 1.2) {
    score.total++;
    score.criteria.push("Trending Market ✅");
  }

  return score;
}

// ===== Main Scanner =====
async function scan() {
  console.log("\n🚀 Multi-Timeframe MA Alignment Scanner Starting...\n");

  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const h1 = await getCandleData(symbol, "1h");
        const h4 = await getCandleData(symbol, "4h");
        const d1 = await getCandleData(symbol, "1d");

        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        const cross1H = detectCross(h1.closes);
        if (!cross1H) return;

        const dir4H = getDirection(h4.closes);
        const dir1D = getDirection(d1.closes);

        if (cross1H !== dir4H || cross1H !== dir1D) return;

        const maFast1H = calculateSMA(h1.closes, FAST);
        const score = checkFilters({
          closes: h1.closes,
          highs: h1.highs,
          lows: h1.lows,
          volumes: h1.volumes,
          maFast: maFast1H
        });

        console.log(
          `\n🔥 ${symbol} — ${cross1H} ALIGNMENT (1H+4H+1D) | Score: ${score.total} | ${score.criteria.join(", ")}`
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
