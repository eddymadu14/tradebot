import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 150;
const CONCURRENCY = 5;
const MIN_24H_VOLUME = 5_000_000; // filter low liquidity
const TIMEFRAMES = ["1h", "4h", "1d"];

const limit = pLimit(CONCURRENCY);
let scanned = 0;

// ================= SMA =================
function SMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ================= ATR =================
function ATR(highs, lows, closes, period = 14) {
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
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ================= Fetch All Futures =================
async function getPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  const tickers = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`);

  const volumeMap = {};
  tickers.data.forEach(t => {
    volumeMap[t.symbol] = parseFloat(t.quoteVolume);
  });

  return data.symbols
    .filter(
      s =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING" &&
        volumeMap[s.symbol] > MIN_24H_VOLUME
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

// ================= Direction + Strength =================
function getDirectionAndStrength(closes) {
  const fast = SMA(closes, FAST);
  const slow = SMA(closes, SLOW);
  const i = closes.length - 1;

  if (!fast[i] || !slow[i]) return null;

  const direction = fast[i] > slow[i] ? "BULLISH" : "BEARISH";

  const separation = Math.abs(fast[i] - slow[i]) / slow[i];
  const slope = (fast[i] - fast[i - 1]) / fast[i - 1];

  return { direction, separation, slope };
}

// ================= Structure Break =================
function structureBreak(highs, lows, direction) {
  const recentHigh = Math.max(...highs.slice(-25, -2));
  const recentLow = Math.min(...lows.slice(-25, -2));
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  if (direction === "BULLISH") return lastHigh > recentHigh;
  if (direction === "BEARISH") return lastLow < recentLow;
  return false;
}

// ================= Volume Acceleration =================
function volumeAcceleration(volumes) {
  const last = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const prevAvg = volumes.slice(-41, -21).reduce((a, b) => a + b, 0) / 20;

  return last > avg * 1.5 && avg > prevAvg;
}

// ================= Liquidity Sweep =================
function liquiditySweep(highs, lows, direction) {
  const prevHigh = Math.max(...highs.slice(-15, -3));
  const prevLow = Math.min(...lows.slice(-15, -3));

  const sweepHigh = highs[highs.length - 2] > prevHigh;
  const sweepLow = lows[lows.length - 2] < prevLow;

  if (direction === "BULLISH") return sweepLow;
  if (direction === "BEARISH") return sweepHigh;

  return false;
}

// ================= ATR Regime =================
function atrRegime(highs, lows, closes) {
  const current = ATR(highs, lows, closes, 14);
  const baseline = ATR(
    highs.slice(0, -20),
    lows.slice(0, -20),
    closes.slice(0, -20),
    14
  );
  return current > baseline * 1.3;
}

// ================= Relative Strength vs BTC =================
async function relativeStrength(symbolCloses) {
  const btc = await getCandles("BTCUSDT", "1h");
  const btcReturn =
    (btc.closes.at(-1) - btc.closes.at(-20)) / btc.closes.at(-20);
  const symReturn =
    (symbolCloses.at(-1) - symbolCloses.at(-20)) /
    symbolCloses.at(-20);

  return symReturn > btcReturn;
}

// ================= Alignment =================
function alignment(tfData) {
  const directions = [];
  const strengthScores = [];

  for (let tf of TIMEFRAMES) {
    const data = getDirectionAndStrength(tfData[tf].closes);
    if (!data) return null;

    directions.push(data.direction);

    strengthScores.push(
      data.separation > 0.003 ? 1 : 0,
      Math.abs(data.slope) > 0.001 ? 1 : 0
    );
  }

  if (directions.every(d => d === "BULLISH") ||
      directions.every(d => d === "BEARISH")) {

    const totalStrength = strengthScores.reduce((a, b) => a + b, 0);
    return { direction: directions[0], strength: totalStrength };
  }

  return null;
}

// ================= MAIN =================
async function scan() {
  console.log("\n🚀 ELITE STRUCTURAL MOMENTUM ENGINE\n");

  const pairs = await getPairs();
  console.log(`Scanning ${pairs.length} high-liquidity pairs\n`);

  const results = [];

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const tfData = {};
        for (let tf of TIMEFRAMES) {
          tfData[tf] = await getCandles(symbol, tf);
        }

        const align = alignment(tfData);
        scanned++;
        process.stdout.write(`Scanning ${scanned}/${pairs.length}\r`);

        if (!align) return;

        let score = 1 + align.strength;
        const criteria = ["Multi-TF Alignment"];

        if (volumeAcceleration(tfData["1h"].volumes)) {
          score++; criteria.push("Volume Acceleration");
        }

        if (structureBreak(tfData["1h"].highs, tfData["1h"].lows, align.direction)) {
          score++; criteria.push("Structure Break");
        }

        if (liquiditySweep(tfData["1h"].highs, tfData["1h"].lows, align.direction)) {
          score++; criteria.push("Liquidity Sweep");
        }

        if (atrRegime(tfData["1h"].highs, tfData["1h"].lows, tfData["1h"].closes)) {
          score++; criteria.push("ATR Expansion");
        }

        const rs = await relativeStrength(tfData["1h"].closes);
        if (rs) { score++; criteria.push("Outperforming BTC"); }

        if (score >= 4) {
          results.push({ symbol, direction: align.direction, score, criteria });
        }

      } catch {}
    })
  );

  await Promise.all(tasks);

  results.sort((a, b) => b.score - a.score);

  console.log("\n\n🔥 TOP STRUCTURAL MOMENTUM SETUPS:\n");
  results.forEach(r => {
    console.log(
      `${r.symbol} — ${r.direction} | Score: ${r.score} | ${r.criteria.join(", ")}`
    );
  });

  console.log("\n✅ Scan Complete.\n");
}

scan();
