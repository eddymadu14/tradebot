import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1d";
const LOOKBACK = 60;
const CONCURRENCY = 8;
const MIN_VOLUME_USDT = 30_000_000; // 50M USDT
const limit = pLimit(CONCURRENCY);

let scannedCount = 0;

// ===== KDJ =====
function calculateKDJ(highs, lows, closes, period = 9) {
  const RSV = [];
  const K = [];
  const D = [];
  const J = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      RSV.push(null);
      K.push(null);
      D.push(null);
      J.push(null);
      continue;
    }
    const periodHigh = Math.max(...highs.slice(i - period + 1, i + 1));
    const periodLow = Math.min(...lows.slice(i - period + 1, i + 1));
    const rsv = periodHigh === periodLow ? 50 : ((closes[i] - periodLow) / (periodHigh - periodLow)) * 100;
    RSV.push(rsv);
    if (i === period - 1) {
      K.push(50);
      D.push(50);
    } else {
      K.push(2 / 3 * K[K.length - 1] + 1 / 3 * rsv);
      D.push(2 / 3 * D[D.length - 1] + 1 / 3 * K[K.length - 1]);
    }
    J.push(3 * K[K.length - 1] - 2 * D[D.length - 1]);
  }

  return { K, D, J };
}

// ===== ATR =====
function calculateATR(highs, lows, closes, period = 14) {
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
    atr.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return atr;
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

// ===== Detect KDJ Cross or Very Close =====
function detectKDJCross(highs, lows, closes) {
  const { K, D, J } = calculateKDJ(highs, lows, closes);
  const i = closes.length - 1;

  const K_now = K[i];
  const K_prev = K[i - 1];
  const D_now = D[i];
  const D_prev = D[i - 1];
  const J_now = J[i];

  if ([K_now, K_prev, D_now, D_prev, J_now].some(v => v === null)) return null;

  // LONG: K crosses above D or very close (<1)
  if ((K_prev < D_prev && K_now >= D_now) || Math.abs(K_now - D_now) <= 1) {
    if (K_now <= 25 || D_now <= 25 || J_now <= 25) return "LONG";
  }

  // SHORT: K crosses below D or very close (<1)
  if ((K_prev > D_prev && K_now <= D_now) || Math.abs(K_now - D_now) <= 1) {
    if (K_now >= 65 || D_now >= 65 || J_now >= 65) return "SHORT";
  }

  return null;
}

// ===== Filter Checks =====
function checkFilters({ closes, highs, lows, volumes }) {
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

  return score;
}

// ===== Main Scanner =====
async function scan() {
  console.log("\n🚀 Binance Futures USDT KDJ Scanner Starting...\n");
  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  // Fetch all candle data once
  const symbolsData = await Promise.all(
    pairs.map(symbol =>
      limit(async () => {
        try {
          const data = await getCandleData(symbol);
          const lastClose = data.closes[data.closes.length - 1];
          const lastVolUSDT = lastClose * data.volumes[data.volumes.length - 1]; // Approx USDT volume

          if (lastVolUSDT < MIN_VOLUME_USDT) return null; // enforce 50M filter
          return { symbol, ...data, lastVolUSDT };
        } catch {
          return null;
        }
      })
    )
  );

  // Filter out nulls
  const validSymbols = symbolsData.filter(Boolean);

  // Sort descending by last USDT volume
  validSymbols.sort((a, b) => b.lastVolUSDT - a.lastVolUSDT);

  // Scan for KDJ crosses
  for (const { symbol, closes, highs, lows, volumes } of validSymbols) {
    scannedCount++;
    process.stdout.write(`Scanning ${scannedCount}/${validSymbols.length}\r`);

    const cross = detectKDJCross(highs, lows, closes);
    if (cross) {
      const score = checkFilters({ closes, highs, lows, volumes });
      console.log(
        `\n🔥 ${symbol} — ${cross} CROSS | Score: ${score.total} | ${score.criteria.join(", ")}`
      );
    }
  }

  console.log("\n\n✅ Scan complete.\n");
}

scan();
