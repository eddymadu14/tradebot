import axios from "axios";

// ===== CONFIG =====
const BASE_URL = "https://fapi.binance.com";
const FAST = 7;
const SLOW = 25;
const LOOKBACK = 300; // number of candles to fetch
const SYMBOL = "AKEUSDT"; // <-- modify here
const TIMEFRAMES = { H1: "1h", H4: "4h", D1: "1d" };

// ===== SMA =====
function calculateSMA(prices, period) {
  return prices.map((_, i, arr) => {
    if (i < period - 1) return null;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

// ===== CROSS DETECTION =====
function detectCrosses(prices) {
  const maFast = calculateSMA(prices, FAST);
  const maSlow = calculateSMA(prices, SLOW);
  const crosses = [];
  for (let i = 1; i < prices.length; i++) {
    if (!maFast[i - 1] || !maFast[i] || !maSlow[i - 1] || !maSlow[i]) continue;
    if (maFast[i - 1] <= maSlow[i - 1] && maFast[i] > maSlow[i]) {
      crosses.push({ index: i, type: "BULLISH" });
    }
    if (maFast[i - 1] >= maSlow[i - 1] && maFast[i] < maSlow[i]) {
      crosses.push({ index: i, type: "BEARISH" });
    }
  }
  return crosses;
}

// ===== FETCH CANDLES =====
async function getCandles(symbol, interval) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol, interval, limit: LOOKBACK }
  });
  return data.map(c => ({
    openTime: c[0],
    closeTime: c[6],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));
}

// ===== FIND CLOSEST CANDLE BEFORE OR AT =====
function findClosestCandle(candles, timestamp) {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].closeTime <= timestamp) return { index: i, candle: candles[i] };
  }
  return null;
}

// ===== DIRECTION AT INDEX =====
function getDirectionAtIndex(prices, index) {
  const maFast = calculateSMA(prices, FAST);
  const maSlow = calculateSMA(prices, SLOW);
  if (!maFast[index] || !maSlow[index]) return null;
  return maFast[index] > maSlow[index] ? "BULLISH" : "BEARISH";
}

// ===== MAIN =====
async function findAllAlignedCrosses(symbol) {
  const h1 = await getCandles(symbol, TIMEFRAMES.H1);
  const h4 = await getCandles(symbol, TIMEFRAMES.H4);
  const d1 = await getCandles(symbol, TIMEFRAMES.D1);

  const h1Closes = h1.map(c => c.close);
  const h4Closes = h4.map(c => c.close);
  const d1Closes = d1.map(c => c.close);

  const h1Crosses = detectCrosses(h1Closes);
  const d1Crosses = detectCrosses(d1Closes);

  const results = [];

  h1Crosses.forEach(h1c => {
    const h1Dir = h1c.type;
    const h1Time = h1[h1c.index].closeTime;

    // 4H alignment: find closest prior 4H candle
    const h4Match = findClosestCandle(h4, h1Time);
    if (!h4Match) return;
    const h4Dir = getDirectionAtIndex(h4Closes, h4Match.index);
    if (h4Dir !== h1Dir) return;

    // 1D alignment: find all 1D crosses in last 5 days before or at h1Time
    const alignedD1Crosses = d1Crosses
      .filter(dc => {
        const d1Time = d1[dc.index].closeTime;
        return d1Time <= h1Time && d1Time >= h1Time - 5 * 24 * 60 * 60 * 1000 && dc.type === h1Dir;
      });

    alignedD1Crosses.forEach(dc => {
      results.push({
        h1CrossTime: new Date(h1Time).toISOString(),
        type: h1Dir,
        h4Dir,
        d1CrossTime: new Date(d1[dc.index].closeTime).toISOString()
      });
    });
  });

  return results;
}

// ===== RUN =====
(async () => {
  const aligned = await findAllAlignedCrosses(SYMBOL);
  if (aligned.length === 0) console.log("No aligned crosses found.");
  else console.table(aligned);
})();
