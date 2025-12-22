import ccxt from "ccxt";
import { ATR, EMA } from "technicalindicators";

/* ================================
   CONFIG
================================ */
const SYMBOL = "BTC/USDT";
const EXCHANGE = new ccxt.binance();
const DAILY_LIMIT = 120;
const WEEKLY_LIMIT = 60;

/* ================================
   DATA
================================ */
async function fetchCandles(symbol, timeframe, limit) {
  const ohlcv = await EXCHANGE.fetchOHLCV(symbol, timeframe, undefined, limit);
  return ohlcv.map(c => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4]
  }));
}

/* ================================
   INDICATORS
================================ */
function calcATR(candles, period = 14) {
  return ATR.calculate({
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close),
    period
  });
}

function calcEMA(values, period) {
  return EMA.calculate({ values, period });
}

/* ================================
   1️⃣ STRUCTURE CONSTRAINT (WHERE)
================================ */
function structureConstraint(dailyCandle, weeklyCandles) {
  const wHigh = Math.max(...weeklyCandles.map(c => c.high));
  const wLow = Math.min(...weeklyCandles.map(c => c.low));

  const rangePos = (dailyCandle.close - wLow) / (wHigh - wLow);

  if (rangePos > 0.7) {
    return { bias: "BULL", confidence: 1, veto: false };
  }

  if (rangePos < 0.3) {
    return { bias: "BEAR", confidence: 1, veto: false };
  }

  return { bias: "NEUTRAL", confidence: 0, veto: true };
}

/* ================================
   2️⃣ TIME CONSTRAINT (WHEN)
================================ */
function timeConstraint(candle) {
  const closePos = (candle.close - candle.low) / (candle.high - candle.low);

  if (closePos > 0.75) {
    return { bias: "BULL", strength: 1 };
  }

  if (closePos < 0.25) {
    return { bias: "BEAR", strength: 1 };
  }

  return { bias: "NEUTRAL", strength: 0 };
}

/* ================================
   3️⃣ VOLATILITY CONSTRAINT (HOW)
================================ */
function volatilityConstraint(candles, atrs) {
  const c = candles[candles.length - 1];
  const currentATR = atrs[atrs.length - 1];
  const avgATR =
    atrs.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const atrRatio = currentATR / avgATR;
  const efficiency =
    Math.abs(c.close - c.open) / (c.high - c.low);

  if (atrRatio > 1.2 && efficiency > 0.6) {
    return {
      state: "EXPANSION",
      bias: c.close > c.open ? "BULL" : "BEAR",
      quality: 1
    };
  }

  if (efficiency < 0.4) {
    return { state: "ABSORPTION", bias: "NEUTRAL", quality: 0 };
  }

  return { state: "NEUTRAL", bias: "NEUTRAL", quality: 0.5 };
}

/* ================================
   4️⃣ PARTICIPATION CONSTRAINT (WHO)
================================ */
function participationConstraint(candles) {
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  if (curr.low < prev.low && curr.close > prev.low) {
    return { trappedSide: "SELLERS", confidence: 1 };
  }

  if (curr.high > prev.high && curr.close < prev.high) {
    return { trappedSide: "BUYERS", confidence: 1 };
  }

  return { trappedSide: "NONE", confidence: 0 };
}

/* ================================
   3️⃣ REGIME DETECTION (W+D)
================================ */
function regimeDetection(dailyCandles, weeklyCandles) {
  const dailyCloses = dailyCandles.map(c => c.close);
  const weeklyCloses = weeklyCandles.map(c => c.close);

  const dailyEMA = calcEMA(dailyCloses, 20);
  const weeklyEMA = calcEMA(weeklyCloses, 20);

  const d = dailyCloses.at(-1);
  const w = weeklyCloses.at(-1);

  if (d > dailyEMA.at(-1) && w > weeklyEMA.at(-1)) {
    return "TREND_UP";
  }

  if (d < dailyEMA.at(-1) && w < weeklyEMA.at(-1)) {
    return "TREND_DOWN";
  }

  if (
    Math.abs(d - dailyEMA.at(-1)) / d < 0.01
  ) {
    return "RANGE";
  }

  return "TRANSITION";
}

/* ================================
   2️⃣ ATR INVALIDATION
================================ */
function atrInvalidation(candle, atr, direction) {
  const buffer = atr * 0.8;

  if (direction === "BULL") {
    return candle.low - buffer;
  }

  if (direction === "BEAR") {
    return candle.high + buffer;
  }

  return null;
}

/* ================================
   DECISION + STRENGTH
================================ */
function decideCTWL(
  structure,
  time,
  volatility,
  participation,
  regime
) {
  if (structure.veto) return { decision: "NO TRADE", strength: 0 };
  if (volatility.state === "ABSORPTION") {
    return { decision: "NO TRADE", strength: 0 };
  }

  let score = 0;
  const biasVotes = {};

  const vote = bias => {
    biasVotes[bias] = (biasVotes[bias] || 0) + 1;
  };

  if (structure.bias !== "NEUTRAL") {
    vote(structure.bias);
    score += 1;
  }

  if (time.bias !== "NEUTRAL") {
    vote(time.bias);
    score += 1;
  }

  if (volatility.bias !== "NEUTRAL") {
    vote(volatility.bias);
    score += volatility.quality;
  }

  if (participation.trappedSide === "SELLERS") {
    vote("BULL");
    score += 1;
  }

  if (participation.trappedSide === "BUYERS") {
    vote("BEAR");
    score += 1;
  }

  const decision =
    (biasVotes.BULL || 0) > (biasVotes.BEAR || 0)
      ? "BULL"
      : "BEAR";

  if (score < 3) return { decision: "NO TRADE", strength: 0 };

  // Strength normalization (0–100)
  let strength = Math.min(100, Math.round((score / 5) * 100));

  // Regime penalty
  if (
    (decision === "BULL" && regime === "TREND_DOWN") ||
    (decision === "BEAR" && regime === "TREND_UP")
  ) {
    strength -= 20;
  }

  return { decision, strength: Math.max(strength, 0) };
}

/* ================================
   RUNNER
================================ */
async function runCTWL() {
  const daily = await fetchCandles(SYMBOL, "1d", DAILY_LIMIT);
  const weekly = await fetchCandles(SYMBOL, "1w", WEEKLY_LIMIT);

  const atrs = calcATR(daily);
  const lastATR = atrs.at(-1);
  const lastCandle = daily.at(-1);

  const structure = structureConstraint(lastCandle, weekly);
  const time = timeConstraint(lastCandle);
  const volatility = volatilityConstraint(daily, atrs);
  const participation = participationConstraint(daily);
  const regime = regimeDetection(daily, weekly);

  const result = decideCTWL(
    structure,
    time,
    volatility,
    participation,
    regime
  );

  const invalidation =
    result.decision !== "NO TRADE"
      ? atrInvalidation(lastCandle, lastATR, result.decision)
      : null;

  console.log("CTWL DAILY OUTPUT");
  console.log({
    decision: result.decision,
    strength: result.strength,
    regime,
    invalidation,
    structure,
    time,
    volatility,
    participation
  });
}

runCTWL();
