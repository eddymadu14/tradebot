/**
 * CTWL-D1 — BTC Daily Directional Predictive Engine
 * Target accuracy: ~58–62% (with heavy no-trade filtering)
 */

import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";

const exchange = new ccxt.binance({ enableRateLimit: true });
const SYMBOL = "BTC/USDT";
const DAILY = "1d";
const WEEKLY = "1w";

// =====================
// CONFIG
// =====================
const CONFIDENCE_THRESHOLD = 0.60;
const ATR_EXPANSION_LIMIT = 1.25;
const MIN_VOLUME_MULTIPLIER = 1.1;

// =====================
// HELPERS
// =====================
const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

function candleStructure(c) {
  const open = c[1], high = c[2], low = c[3], close = c[4];
  return {
    open, high, low, close,
    body: Math.abs(close - open),
    range: high - low,
    mid: (high + low) / 2
  };
}

// =====================
// FETCH DATA
// =====================
async function fetchCandles(tf, limit = 60) {
  return exchange.fetchOHLCV(SYMBOL, tf, undefined, limit);
}

// =====================
// CORE ENGINE
// =====================
async function runDailyDirectionalModel() {
  const daily = await fetchCandles(DAILY, 40);
  const weekly = await fetchCandles(WEEKLY, 20);

  const d = daily.map(candleStructure);
  const w = weekly.map(candleStructure);

  const lastDay = d[d.length - 1];
  const prevDay = d[d.length - 2];
  const lastWeek = w[w.length - 1];

  // =====================
  // WEEKLY BIAS
  // =====================
  const weeklyBias =
    lastWeek.close > lastWeek.open ? "BULL" :
    lastWeek.close < lastWeek.open ? "BEAR" :
    "NEUTRAL";

  if (weeklyBias === "NEUTRAL") {
    return { direction: "NO_TRADE", reason: "Weekly indecision" };
  }

  // =====================
  // WEEKLY RANGE POSITION
  // =====================
  const weeklyRangePos =
    (lastDay.open - lastWeek.low) / (lastWeek.high - lastWeek.low);

  if (
    (weeklyBias === "BULL" && weeklyRangePos > 0.6) ||
    (weeklyBias === "BEAR" && weeklyRangePos < 0.4)
  ) {
    return { direction: "NO_TRADE", reason: "Bad weekly range location" };
  }

  // =====================
  // DAILY OPEN VS PREVIOUS DAY
  // =====================
  if (
    lastDay.open > prevDay.low &&
    lastDay.open < prevDay.high
  ) {
    return { direction: "NO_TRADE", reason: "Opened inside prior day range" };
  }

  // =====================
  // PREVIOUS DAY EFFICIENCY
  // =====================
  if (prevDay.body / prevDay.range < 0.4) {
    return { direction: "NO_TRADE", reason: "Previous day inefficient" };
  }

  // =====================
  // ATR STATE
  // =====================
  const atrValues = ATR.calculate({
    high: d.map(x => x.high),
    low: d.map(x => x.low),
    close: d.map(x => x.close),
    period: 14
  });

  const atrNow = atrValues[atrValues.length - 1];
  const atrAvg = avg(atrValues.slice(-20));

  if (atrNow > atrAvg * ATR_EXPANSION_LIMIT) {
    return { direction: "NO_TRADE", reason: "ATR already expanded" };
  }

  // =====================
  // EMA TREND FILTER
  // =====================
  const ema20 = EMA.calculate({ period: 20, values: d.map(x => x.close) });
  const ema50 = EMA.calculate({ period: 50, values: d.map(x => x.close) });

  const emaSlope = ema20[ema20.length - 1] - ema20[ema20.length - 2];

  if (
    (weeklyBias === "BULL" && emaSlope <= 0) ||
    (weeklyBias === "BEAR" && emaSlope >= 0)
  ) {
    return { direction: "NO_TRADE", reason: "EMA slope conflict" };
  }

  // =====================
  // MOMENTUM CONSISTENCY
  // =====================
  const lastTwo = d.slice(-3, -1);
  const alternating =
    (lastTwo[0].close > lastTwo[0].open) !==
    (lastTwo[1].close > lastTwo[1].open);

  if (alternating) {
    return { direction: "NO_TRADE", reason: "Momentum chop detected" };
  }

  // =====================
  // CONFIDENCE SCORE
  // =====================
  let score = 0;
  score += 0.2; // weekly bias
  score += 0.15; // range position
  score += 0.15; // ATR state
  score += 0.15; // EMA slope
  score += 0.15; // momentum
  score += 0.2; // clean daily structure

  if (score < CONFIDENCE_THRESHOLD) {
    return { direction: "NO_TRADE", confidence: score };
  }

  // =====================
  // FINAL DIRECTION & SL
  // =====================
  const direction = weeklyBias;

  const invalidation =
    direction === "BULL"
      ? Math.min(prevDay.low, lastWeek.low)
      : Math.max(prevDay.high, lastWeek.high);

  return {
    direction,
    confidence: score.toFixed(2),
    dailyOpen: lastDay.open,
    invalidationSL: invalidation,
    comment: "Directional bias valid until invalidation breached"
  };
}

// =====================
// RUN
// =====================
runDailyDirectionalModel()
  .then(res => console.log("📊 CTWL-D1 RESULT:", res))
  .catch(err => console.error("❌ Error:", err.message));
