import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1w";
const LOOKBACK = 60;
const CONCURRENCY = 8;
const MIN_VOLUME_USDT = 20_000_000;
const limit = pLimit(CONCURRENCY);

let scannedCount = 0;

// ===== KDJ =====
function calculateKDJ(highs, lows, closes, period = 9) {
  const RSV = [], K = [], D = [], J = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      RSV.push(null); K.push(null); D.push(null); J.push(null);
      continue;
    }

    const periodHigh = Math.max(...highs.slice(i - period + 1, i + 1));
    const periodLow = Math.min(...lows.slice(i - period + 1, i + 1));

    const rsv = periodHigh === periodLow
      ? 50
      : ((closes[i] - periodLow) / (periodHigh - periodLow)) * 100;

    RSV.push(rsv);

    if (i === period - 1) {
      K.push(50);
      D.push(50);
    } else {
      K.push((2 / 3) * K[K.length - 1] + (1 / 3) * rsv);
      D.push((2 / 3) * D[D.length - 1] + (1 / 3) * K[K.length - 1]);
    }

    J.push(3 * K[K.length - 1] - 2 * D[D.length - 1]);
  }

  return { K, D, J };
}

// ===== J MOMENTUM =====
function detectJMomentum(highs, lows, closes) {
  const { J } = calculateKDJ(highs, lows, closes);
  const i = closes.length - 1;

  const J_now = J[i];
  const J_prev = J[i - 1];
  const J_prev2 = J[i - 2];

  if ([J_now, J_prev, J_prev2].some(v => v === null)) return null;

  const slope1 = J_prev - J_prev2;
  const slope2 = J_now - J_prev;

  const STEEP = 8;

  const bullish =
    slope1 < 0 &&
    slope2 > STEEP &&
    J_now <= 25;

  const bearish =
    slope1 > 0 &&
    slope2 < -STEEP &&
    J_now >= 65;

  if (bullish) return "LONG";
  if (bearish) return "SHORT";

  return null;
}

// ===== ATR =====
function calculateATR(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
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
  const ema = [prices[0]];

  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }

  return ema;
}

// ===== Futures Pairs =====
async function getFuturesUSDTPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(s => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
    .map(s => s.symbol);
}

// ===== Candle Data =====
async function getCandleData(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval: INTERVAL, limit: LOOKBACK }
  });

  return {
    closes: data.map(c => parseFloat(c[4])),
    highs: data.map(c => parseFloat(c[2])),
    lows: data.map(c => parseFloat(c[3])),
    volumes: data.map(c => parseFloat(c[5]))
  };
}

// ===== 24h Volume =====
async function get24hVolume(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`, {
    params: { symbol }
  });

  return parseFloat(data.quoteVolume);
}

// ===== Filters =====
function checkFilters({ closes, highs, lows, volumes }) {
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

  return score;
}

// ===== MAIN =====
async function scan() {
  console.log("\n🚀 Binance Futures USDT J-Momentum Scanner Starting...\n");

  const pairs = await getFuturesUSDTPairs();
  console.log(`Total USDT Futures Pairs: ${pairs.length}\n`);

  const symbolsData = await Promise.all(
    pairs.map(symbol => limit(async () => {
      try {
        const candleData = await getCandleData(symbol);
        const volume24h = await get24hVolume(symbol);

        if (volume24h < MIN_VOLUME_USDT) return null;

        return { symbol, ...candleData, volume24h };
      } catch {
        return null;
      }
    }))
  );

  const validSymbols = symbolsData
    .filter(Boolean)
    .sort((a, b) => b.volume24h - a.volume24h);

  for (const { symbol, closes, highs, lows, volumes } of validSymbols) {
    scannedCount++;
    process.stdout.write(`Scanning ${scannedCount}/${validSymbols.length}\r`);

    const signal = detectJMomentum(highs, lows, closes);

    if (signal) {
      const score = checkFilters({ closes, highs, lows, volumes });

      // ===== ALIGNMENT LOGIC =====
      const trendText = score.criteria.find(c => c.startsWith("Trend"));
      const trend = trendText.includes("BULLISH") ? "BULLISH" : "BEARISH";

      const isAligned =
        (signal === "LONG" && trend === "BULLISH") ||
        (signal === "SHORT" && trend === "BEARISH");

      if (!isAligned) continue; // 🚫 skip counter-trend signals

      console.log(
        `\n🔥 ${symbol} — ${signal} J MOMENTUM (ALIGNED) | Score: ${score.total} | ${score.criteria.join(", ")}`
      );
    }
  }

  console.log("\n\n✅ Scan complete.\n");
}

scan();
