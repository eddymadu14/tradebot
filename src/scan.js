import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 120;
const CONCURRENCY = 6;
const limit = pLimit(CONCURRENCY);

const TIMEFRAMES = ["1h", "4h", "1d"];
let scanned = 0;

// ================= SMA =================
function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ================= ATR =================
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
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ================= Fetch Pairs =================
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

// ================= Fetch Candles =================
async function getCandles(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });

  return {
    closes: data.map(d => parseFloat(d[4])),
    highs: data.map(d => parseFloat(d[2])),
    lows: data.map(d => parseFloat(d[3])),
    volumes: data.map(d => parseFloat(d[5]))
  };
}

// ================= Cross Direction =================
function getCrossDirection(closes) {
  const fast = calculateSMA(closes, FAST);
  const slow = calculateSMA(closes, SLOW);
  const i = closes.length - 1;

  if (!fast[i - 1] || !slow[i - 1]) return null;

  if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) return "BULLISH";
  if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]) return "BEARISH";

  if (fast[i] > slow[i]) return "BULLISH";
  if (fast[i] < slow[i]) return "BEARISH";

  return null;
}

// ================= Structure Break =================
function structureBreak(highs, lows, direction) {
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  const prevHigh = Math.max(...highs.slice(-20, -1));
  const prevLow = Math.min(...lows.slice(-20, -1));

  if (direction === "BULLISH" && lastHigh > prevHigh) return true;
  if (direction === "BEARISH" && lastLow < prevLow) return true;

  return false;
}

// ================= Volume Spike =================
function volumeSpike(volumes) {
  const last = volumes[volumes.length - 1];
  const avg =
    volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  return last > avg * 1.7;
}

// ================= Liquidity Sweep =================
function liquiditySweep(highs, lows, direction) {
  const recentHigh = Math.max(...highs.slice(-10, -2));
  const recentLow = Math.min(...lows.slice(-10, -2));
  const lastHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 2];
  const close = highs.length - 1;

  if (direction === "BULLISH") {
    return lastLow < recentLow;
  }
  if (direction === "BEARISH") {
    return lastHigh > recentHigh;
  }
  return false;
}

// ================= ATR Expansion =================
function atrExpansion(highs, lows, closes) {
  const currentATR = calculateATR(highs, lows, closes, 14);
  const pastATR =
    calculateATR(
      highs.slice(0, -5),
      lows.slice(0, -5),
      closes.slice(0, -5),
      14
    );

  return currentATR > pastATR * 1.2;
}

// ================= Alignment =================
function alignmentCheck(tfData) {
  const directions = TIMEFRAMES.map(tf =>
    getCrossDirection(tfData[tf].closes)
  );

  if (directions.every(d => d === "BULLISH")) return "BULLISH";
  if (directions.every(d => d === "BEARISH")) return "BEARISH";

  return null;
}

// ================= MAIN =================
async function scan() {
  console.log("\n🚀 Structural Multi-TF Scanner Starting...\n");
  const pairs = await getPairs();
  console.log(`Total Futures Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const tfData = {};
        for (let tf of TIMEFRAMES) {
          tfData[tf] = await getCandles(symbol, tf);
        }

        const direction = alignmentCheck(tfData);
        scanned++;
        process.stdout.write(`Scanning ${scanned}/${pairs.length}\r`);

        if (!direction) return;

        let score = 1; // alignment = 1
        const criteria = ["Alignment"];

        if (volumeSpike(tfData["1h"].volumes)) {
          score++;
          criteria.push("Volume Spike");
        }

        if (
          structureBreak(
            tfData["1h"].highs,
            tfData["1h"].lows,
            direction
          )
        ) {
          score++;
          criteria.push("Structure Break");
        }

        if (
          atrExpansion(
            tfData["1h"].highs,
            tfData["1h"].lows,
            tfData["1h"].closes
          )
        ) {
          score++;
          criteria.push("ATR Expansion");
        }

        if (
          liquiditySweep(
            tfData["1h"].highs,
            tfData["1h"].lows,
            direction
          )
        ) {
          score++;
          criteria.push("Liquidity Sweep");
        }

        if (score >= 3) {
          console.log(
            `\n🔥 ${symbol} — ${direction} | Score: ${score} | ${criteria.join(
              ", "
            )}`
          );
        }
      } catch {
        scanned++;
      }
    })
  );

  await Promise.all(tasks);
  console.log("\n\n✅ Scan Complete.\n");
}

scan();
