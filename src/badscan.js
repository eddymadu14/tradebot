import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 300;
const CONCURRENCY = 8;
const limit = pLimit(CONCURRENCY);

const args = process.argv.slice(2);
const inputTime = args[0] ? new Date(args[0]) : null;
const range = args[1] ? parseInt(args[1]) : 0;

if (args[0] && isNaN(inputTime.getTime())) {
  console.error("❌ Invalid date format. Use ISO format like 2025-02-24T01:00:00Z");
  process.exit(1);
}

let scannedCount = 0;

/* ================= INDICATORS ================= */

function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  ema[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

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
    atr.push(slice.reduce((a, b) => a + b, 0) / period);
  }

  return atr;
}

/* ================= CROSS DETECTION ================= */

function detectCrossAtIndex(closes, index) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  if (
    !maFast[index - 1] ||
    !maFast[index] ||
    !maSlow[index - 1] ||
    !maSlow[index]
  )
    return null;

  if (maFast[index - 1] <= maSlow[index - 1] && maFast[index] > maSlow[index])
    return "BULLISH";

  if (maFast[index - 1] >= maSlow[index - 1] && maFast[index] < maSlow[index])
    return "BEARISH";

  return null;
}

function getDirectionAtIndex(closes, index) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);
  if (!maFast[index] || !maSlow[index]) return null;
  return maFast[index] > maSlow[index] ? "BULLISH" : "BEARISH";
}

function detectRecent1DCross(closes, index, lookback = 5) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  for (let i = index; i > index - lookback; i--) {
    if (
      !maFast[i - 1] ||
      !maFast[i] ||
      !maSlow[i - 1] ||
      !maSlow[i]
    )
      continue;

    if (maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i])
      return "BULLISH";

    if (maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i])
      return "BEARISH";
  }

  return null;
}

/* ================= FILTER ================= */

function checkFiltersAtIndex(data, index) {
  const { closes, highs, lows, volumes } = data;
  const score = { total: 0, criteria: [] };

  const ema200 = calculateEMA(closes.slice(0, index + 1), 200);
  const lastPrice = closes[index];
  const trend = lastPrice > ema200[ema200.length - 1] ? "BULLISH" : "BEARISH";
  score.total++;
  score.criteria.push(`Trend: ${trend}`);

  const atr = calculateATR(
    highs.slice(0, index + 1),
    lows.slice(0, index + 1),
    closes.slice(0, index + 1),
    14
  );

  const atrLast = atr[atr.length - 1];
  const atrAvg = atr.slice(-5).reduce((a, b) => a + b, 0) / 5;

  if (atrLast > atrAvg) {
    score.total++;
    score.criteria.push("ATR Expansion ✅");
  }

  const volLast = volumes[index];
  const volAvg =
    volumes.slice(index - 20, index).reduce((a, b) => a + b, 0) / 20;

  if (volLast >= volAvg * 1.5) {
    score.total++;
    score.criteria.push("Volume Spike ✅");
  }

  return score;
}

/* ================= FETCH ================= */

async function getCandleData(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });

  return {
    opens: data.map(c => c[0]),
    closes: data.map(c => parseFloat(c[4])),
    highs: data.map(c => parseFloat(c[2])),
    lows: data.map(c => parseFloat(c[3])),
    volumes: data.map(c => parseFloat(c[5]))
  };
}

async function getPairs() {
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

/* ================= MAIN ================= */

async function scan() {
  console.log("\n🚀 Advanced Historical MA Scanner Starting...\n");

  const pairs = await getPairs();
  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const h1 = await getCandleData(symbol, "1h");
        const h4 = await getCandleData(symbol, "4h");
        const d1 = await getCandleData(symbol, "1d");

        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        let targetIndex;

        if (!inputTime) {
          targetIndex = h1.closes.length - 2; // last closed candle
        } else {
          const targetClose = inputTime.getTime();
          targetIndex = h1.opens.findIndex(
            t => t + 3600000 === targetClose
          );
          if (targetIndex === -1) return;
        }

        const start = Math.max(1, targetIndex - range);
        const end = Math.min(h1.closes.length - 2, targetIndex + range);

        for (let i = start; i <= end; i++) {
          const cross = detectCrossAtIndex(h1.closes, i);
          if (!cross) continue;

          const dir4 = getDirectionAtIndex(h4.closes, Math.floor(i / 4));
          if (cross !== dir4) continue;

          const dir1 = getDirectionAtIndex(d1.closes, Math.floor(i / 24));
          if (cross !== dir1) continue;

          const recent1D = detectRecent1DCross(
            d1.closes,
            Math.floor(i / 24),
            5
          );
          if (recent1D !== cross) continue;

          const score = checkFiltersAtIndex(h1, i);

          console.log(
            `\n🔥 ${symbol} — ${cross} @ ${new Date(
              h1.opens[i] + 3600000
            ).toISOString()} | Score: ${score.total} | ${score.criteria.join(", ")}`
          );
        }
      } catch {}
    })
  );

  await Promise.all(tasks);
  console.log("\n\n✅ Scan complete.\n");
}

scan();
