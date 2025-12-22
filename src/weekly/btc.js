/**
 * BTC WEEKLY DIRECTIONAL PREDICTIVE ENGINE
 * ---------------------------------------
 * Target: ~60% win rate via aggressive signal filtering
 * Timeframe: Weekly
 * Data: Binance
 */

import fetch from "node-fetch";
import { EMA, ATR } from "technicalindicators";

// =====================
// CONFIG
// =====================
const SYMBOL = "BTCUSDT";
const WEEKLY_LIMIT = 120;
const DAILY_LIMIT = 120;

const CONFIDENCE_THRESHOLD = 0.6;

// =====================
// DATA FETCH
// =====================
async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  return res.json();
}

async function fetchFundingRate(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=5`;
  const res = await fetch(url);
  const data = await res.json();
  const avg = data.reduce((a, b) => a + parseFloat(b.fundingRate), 0) / data.length;
  return avg;
}

// =====================
// HELPERS
// =====================
function parseOHLC(candles) {
  return candles.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4])
  }));
}

function percentileRank(value, min, max) {
  return (value - min) / (max - min);
}

// =====================
// CORE ENGINE
// =====================
async function runEngine() {
  console.log("🔍 Fetching BTC data...");

  const weeklyRaw = await fetchCandles(SYMBOL, "1w", WEEKLY_LIMIT);
  const dailyRaw = await fetchCandles(SYMBOL, "1d", DAILY_LIMIT);
  const fundingRate = await fetchFundingRate(SYMBOL);

  const weekly = parseOHLC(weeklyRaw);
  const daily = parseOHLC(dailyRaw);

  const latestWeek = weekly.at(-1);

  // =====================
  // ATR LOGIC
  // =====================
  const atrValues = ATR.calculate({
    high: weekly.map(c => c.high),
    low: weekly.map(c => c.low),
    close: weekly.map(c => c.close),
    period: 14
  });

  const currentATR = atrValues.at(-1);
  const maxATR = Math.max(...atrValues.slice(-50));

  const atrCompressed = currentATR < maxATR * 0.6;

  // =====================
  // WEEKLY RANGE POSITION
  // =====================
  const rangeHigh = Math.max(...weekly.slice(-6).map(c => c.high));
  const rangeLow = Math.min(...weekly.slice(-6).map(c => c.low));

  const openLocation = percentileRank(
    latestWeek.open,
    rangeLow,
    rangeHigh
  );

  const openExtreme =
    openLocation < 0.25 || openLocation > 0.75;

  // =====================
  // HTF BREAKOUT
  // =====================
  const prevHigh = Math.max(...weekly.slice(-6, -1).map(c => c.high));
  const prevLow = Math.min(...weekly.slice(-6, -1).map(c => c.low));

  let htfBias = "NONE";
  if (latestWeek.close > prevHigh) htfBias = "BULL";
  if (latestWeek.close < prevLow) htfBias = "BEAR";

  // =====================
  // DAILY TREND ALIGNMENT
  // =====================
  const emaFast = EMA.calculate({
    period: 3,
    values: daily.map(c => c.close)
  });
  const emaSlow = EMA.calculate({
    period: 7,
    values: daily.map(c => c.close)
  });

  const dailyTrend =
    emaFast.at(-1) > emaSlow.at(-1) ? "BULL" : "BEAR";

  // =====================
  // FUNDING RATE FILTER
  // =====================
  const fundingSafe =
    Math.abs(fundingRate) < 0.0005;

  // =====================
  // CONFIDENCE SCORING
  // =====================
  let confidence = 0;

  if (atrCompressed) confidence += 0.15;
  if (openExtreme) confidence += 0.10;
  if (htfBias !== "NONE") confidence += 0.25;
  if (
    (htfBias === "BULL" && dailyTrend === "BULL") ||
    (htfBias === "BEAR" && dailyTrend === "BEAR")
  ) confidence += 0.15;
  if (fundingSafe) confidence += 0.10;

  // =====================
  // DECISION
  // =====================
  let decision = "NO_TRADE";
  if (confidence >= CONFIDENCE_THRESHOLD && htfBias !== "NONE") {
    decision = htfBias === "BULL" ? "LONG" : "SHORT";
  }

  // =====================
  // TP / SL
  // =====================
  let tp = null;
  let sl = null;

  if (decision === "LONG") {
    sl = latestWeek.open - currentATR;
    tp = latestWeek.open + currentATR * 1.8;
  }

  if (decision === "SHORT") {
    sl = latestWeek.open + currentATR;
    tp = latestWeek.open - currentATR * 1.8;
  }

  // =====================
  // OUTPUT
  // =====================
  console.log("📊 BTC WEEKLY ENGINE RESULT");
  console.log("---------------------------");
  console.log("Decision:", decision);
  console.log("HTF Bias:", htfBias);
  console.log("Daily Trend:", dailyTrend);
  console.log("ATR:", currentATR.toFixed(2));
  console.log("Funding Rate:", fundingRate.toFixed(5));
  console.log("Confidence:", confidence.toFixed(2));

  if (decision !== "NO_TRADE") {
    console.log("Entry:", latestWeek.open.toFixed(2));
    console.log("TP:", tp.toFixed(2));
    console.log("SL:", sl.toFixed(2));
  }
}

// =====================
// RUN
// =====================
runEngine().catch(console.error);
