import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";

const FAST = 7;
const SLOW = 25;
const LOOKBACK = 150;

const CONCURRENCY = 5;
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

  return trs.map((_, i, arr) => {
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

// ================= OPEN INTEREST =================
async function getOpenInterestHistory(symbol) {
  const { data } = await axios.get(
    `${BASE_URL}/futures/data/openInterestHist`,
    {
      params: {
        symbol,
        period: "1d",
        limit: 30
      }
    }
  );

  return data.map(d => parseFloat(d.sumOpenInterest));
}

// ================= FUNDING =================
async function getFundingRate(symbol) {
  const { data } = await axios.get(
    `${BASE_URL}/fapi/v1/fundingRate`,
    {
      params: { symbol, limit: 1 }
    }
  );

  return parseFloat(data[0]?.fundingRate || 0);
}

// ================= MA CROSS =================
function detectCross(closes) {
  const maFast = calculateSMA(closes, FAST);
  const maSlow = calculateSMA(closes, SLOW);

  const i = closes.length - 1;

  if (
    maFast[i - 1] <= maSlow[i - 1] &&
    maFast[i] > maSlow[i]
  ) return "BULLISH";

  if (
    maFast[i - 1] >= maSlow[i - 1] &&
    maFast[i] < maSlow[i]
  ) return "BEARISH";

  return null;
}

// ================= DIRECTION =================
function detectDirection(closes) {
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
  const prevHigh = Math.max(...highs.slice(-lookback - 1, -1));
  const prevLow = Math.min(...lows.slice(-lookback - 1, -1));

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  if (direction === "BULLISH" && lastHigh > prevHigh) return true;
  if (direction === "BEARISH" && lastLow < prevLow) return true;

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

// ================= VOLUME =================
function volumeExpansion(volumes) {
  const last = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return last > avg * 1.7;
}

// ================= ATR DISPLACEMENT =================
function atrDisplacement(highs, lows, closes) {
  const atr = calculateATR(highs, lows, closes, 14);
  const lastATR = atr[atr.length - 1];

  const candleRange =
    highs[highs.length - 1] - lows[lows.length - 1];

  return candleRange > lastATR * 1.5;
}

// ================= OI EXPANSION =================
function oiExpansion(oiHistory) {
  const last = oiHistory[oiHistory.length - 1];
  const avg =
    oiHistory.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;

  return last > avg * 1.1;
}

// ================= MAIN =================
async function scan() {
  console.log("\n🚀 Institutional MA Cross Scanner Starting...\n");

  const pairs = await getFuturesUSDTPairs();

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        scannedCount++;
        process.stdout.write(`Scanning ${scannedCount}/${pairs.length}\r`);

        const daily = await getCandleData(symbol, "1d");
        const cross = detectCross(daily.closes);
        if (!cross) return;

        const h4 = await getCandleData(symbol, "4h");
        const h1 = await getCandleData(symbol, "1h");

        if (
          detectDirection(h4.closes) !== cross ||
          detectDirection(h1.closes) !== cross
        ) return;

        if (!structureBreak(daily.highs, daily.lows, cross)) return;
        if (!liquiditySweep(daily.highs, daily.lows, cross)) return;
        if (!volumeExpansion(daily.volumes)) return;
        if (!atrDisplacement(daily.highs, daily.lows, daily.closes)) return;

        const oiHistory = await getOpenInterestHistory(symbol);
        if (!oiExpansion(oiHistory)) return;

        const funding = await getFundingRate(symbol);
        if (cross === "BULLISH" && funding <= 0) return;
        if (cross === "BEARISH" && funding >= 0) return;

        console.log(
          `\n🔥 ${symbol} — ${cross} Institutional-Grade Signal`
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
