import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1h";
const LOOKBACK = 60;
const CONCURRENCY = 8;

const limit = pLimit(CONCURRENCY);

let scanned = 0;

// ===== Utilities =====

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

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
    atr.push(average(trs.slice(i - period + 1, i + 1)));
  }
  return atr;
}

// ===== Get Futures Pairs =====

async function getUSDTPairs() {
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

// ===== Fetch Candles =====

async function getCandles(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: {
      symbol,
      interval: INTERVAL,
      limit: LOOKBACK
    }
  });

  return data.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }));
}

// ===== Scoring Model =====

function scoreSpike(candles) {
  if (candles.length < 30) return null;

  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const prevCandles = candles.slice(0, -1);

  const avgVolume = average(prevCandles.map(c => c.volume));
  const ratio = last.volume / avgVolume;

  const notional = last.volume * last.close;

  const range = last.high - last.low;
  const avgRange = average(
    prevCandles.slice(-20).map(c => c.high - c.low)
  );
  const rangeRatio = range / avgRange;

  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  const recentHigh = Math.max(...prevCandles.slice(-20).map(c => c.high));
  const recentLow = Math.min(...prevCandles.slice(-20).map(c => c.low));

  const atr = calculateATR(highs, lows, closes);
  const atrLast = atr[atr.length - 1];
  const atrAvg = average(atr.slice(-20));
  const atrRatio = atrLast / atrAvg;

  let score = 0;

  // 1️⃣ Relative Volume (0–3)
  if (ratio >= 5) score += 3;
  else if (ratio >= 3) score += 2;
  else if (ratio >= 2) score += 1;

  // 2️⃣ Notional (0–2)
  if (notional >= 1_000_000) score += 2;
  else if (notional >= 300_000) score += 1;

  // 3️⃣ Range Expansion (0–2)
  if (rangeRatio >= 1.8) score += 2;
  else if (rangeRatio >= 1.3) score += 1;

  // 4️⃣ Commitment (0–1)
  if (bodyRatio >= 0.6) score += 1;

  // 5️⃣ Structure Break (0–1)
  if (last.close > recentHigh || last.close < recentLow)
    score += 1;

  // 6️⃣ Volatility Regime (0–1)
  if (atrRatio >= 1.5) score += 1;

  return {
    score,
    ratio: ratio.toFixed(2),
    notional: Math.round(notional),
    rangeRatio: rangeRatio.toFixed(2),
    atrRatio: atrRatio.toFixed(2)
  };
}

// ===== Scanner =====

async function scan() {
  console.log("\n🚀 Futures Volume Spike Scoring Scanner\n");

  const pairs = await getUSDTPairs();
  console.log(`Total Pairs: ${pairs.length}\n`);

  const results = [];

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const candles = await getCandles(symbol);
        const result = scoreSpike(candles);

        scanned++;
        process.stdout.write(`Scanning ${scanned}/${pairs.length}\r`);

        if (result && result.score >= 6) {
          results.push({ symbol, ...result });
        }
      } catch {
        scanned++;
      }
    })
  );

  await Promise.all(tasks);

  results.sort((a, b) => b.score - a.score);

  console.log("\n\n🔥 High-Probability Spikes:\n");

  results.forEach(r => {
    console.log(
      `${r.symbol} | Score: ${r.score}/10 | VolRatio: ${r.ratio}x | Notional: $${r.notional} | Range: ${r.rangeRatio}x | ATR: ${r.atrRatio}x`
    );
  });

  console.log("\n✅ Scan Complete.\n");
}

scan();
