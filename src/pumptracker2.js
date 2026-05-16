// advanced-pump-tracker.js
// npm install axios p-limit
// node advanced-pump-tracker.js

import axios from "axios";
import pLimit from "p-limit";

// ======================================================
// CONFIG
// ======================================================

const BASE_URL = "https://fapi.binance.com";

const CONCURRENCY = 6;

const LOOP_MS = 30_000;

const TOP_RESULTS = 15;

const MIN_24H_VOLUME = 25_000_000;

const INTERVAL_TRIGGER = "5m";
const INTERVAL_TREND = "15m";
const INTERVAL_HTF = "1h";

const LOOKBACK = 80;

// ======================================================
// WEIGHTS
// ======================================================

const WEIGHTS = {
  trend: 20,
  volume: 20,
  oi: 20,
  breakout: 10,
  momentum: 10,
  funding: 10,
  candle: 5,
  acceleration: 5,
};

// ======================================================
// HTTP
// ======================================================

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
});

// ======================================================
// HELPERS
// ======================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  return Number(v || 0);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ======================================================
// EMA
// ======================================================

function ema(values, period) {
  if (values.length < period) return 0;

  const k = 2 / (period + 1);

  let emaVal = avg(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

// ======================================================
// ATR
// ======================================================

function atr(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );

    trs.push(tr);
  }

  return avg(trs.slice(-period));
}

// ======================================================
// FETCHERS
// ======================================================

async function getKlines(symbol, interval, limit = LOOKBACK) {
  const { data } = await api.get("/fapi/v1/klines", {
    params: {
      symbol,
      interval,
      limit,
    },
  });

  return data;
}

async function getOpenInterest(symbol) {
  const { data } = await api.get("/fapi/v1/openInterest", {
    params: { symbol },
  });

  return num(data.openInterest);
}

async function getFunding(symbol) {
  const { data } = await api.get("/fapi/v1/premiumIndex", {
    params: { symbol },
  });

  return num(data.lastFundingRate);
}

async function getTickers24h() {
  const { data } = await api.get("/fapi/v1/ticker/24hr");
  return data;
}

// ======================================================
// BTC MARKET REGIME
// ======================================================

async function getBTCRegime() {
  try {
    const btc = await getKlines("BTCUSDT", "15m", 80);

    const closes = btc.map((x) => num(x[4]));

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);

    const last = closes.at(-1);
    const prev = closes.at(-2);

    const momentum = pct(last, prev);

    const bullish = last > ema20 && ema20 > ema50 && momentum > 0;

    return {
      bullish,
      momentum: momentum.toFixed(2),
    };
  } catch {
    return {
      bullish: false,
      momentum: 0,
    };
  }
}

// ======================================================
// ELIGIBLE PAIRS
// ======================================================

async function getEligiblePairs() {
  const tickers = await getTickers24h();

  return tickers
    .filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("_") &&
        num(x.quoteVolume) >= MIN_24H_VOLUME
    )
    .map((x) => ({
      symbol: x.symbol,
      volume24h: num(x.quoteVolume),
      change24h: num(x.priceChangePercent),
    }));
}

// ======================================================
// ANALYZER
// ======================================================

async function analyzeSymbol(meta, btcRegime) {
  const symbol = meta.symbol;

  try {
    const oi1 = await getOpenInterest(symbol);

    await sleep(200);

    const [k5, k15, k1h, funding] = await Promise.all([
      getKlines(symbol, INTERVAL_TRIGGER),
      getKlines(symbol, INTERVAL_TREND),
      getKlines(symbol, INTERVAL_HTF),
      getFunding(symbol),
    ]);

    await sleep(200);

    const oi2 = await getOpenInterest(symbol);

    // ==================================================
    // EXTRACT
    // ==================================================

    const closes5 = k5.map((x) => num(x[4]));
    const highs5 = k5.map((x) => num(x[2]));
    const lows5 = k5.map((x) => num(x[3]));
    const volumes5 = k5.map((x) => num(x[5]));

    const closes15 = k15.map((x) => num(x[4]));
    const closes1h = k1h.map((x) => num(x[4]));

    const lastClose = closes5.at(-1);
    const prevClose = closes5.at(-2);

    const lastHigh = highs5.at(-1);
    const lastLow = lows5.at(-1);

    const momentumPct = pct(lastClose, prevClose);

    // ==================================================
    // MULTI TF TREND
    // ==================================================

    const ema20_15m = ema(closes15, 20);
    const ema50_15m = ema(closes15, 50);

    const ema20_1h = ema(closes1h, 20);
    const ema50_1h = ema(closes1h, 50);

    const bullish15m = ema20_15m > ema50_15m;
    const bullish1h = ema20_1h > ema50_1h;

    const trendAligned = bullish15m && bullish1h;

    // ==================================================
    // SUSTAINED VOLUME
    // ==================================================

    const recentVolAvg = avg(volumes5.slice(-5));

    const baselineVol = avg(volumes5.slice(-30, -5));

    const relVol =
      baselineVol === 0 ? 0 : recentVolAvg / baselineVol;

    const sustainedVolume = relVol > 1.8;

    // ==================================================
    // BREAKOUT
    // ==================================================

    const recentHigh = Math.max(...highs5.slice(-21, -1));

    const breakout = lastClose > recentHigh;

    // ==================================================
    // OI
    // ==================================================

    const oiChangePct = pct(oi2, oi1);

    const healthyOI =
      momentumPct > 0 &&
      oiChangePct > 0;

    // ==================================================
    // CANDLE QUALITY
    // ==================================================

    const candleBody = Math.abs(lastClose - prevClose);

    const upperWick =
      lastHigh - Math.max(lastClose, prevClose);

    const bodyToWickRatio =
      upperWick <= 0
        ? 999
        : candleBody / upperWick;

    const strongCandle = bodyToWickRatio > 1.5;

    // ==================================================
    // ACCELERATION
    // ==================================================

    const move1 = pct(closes5.at(-1), closes5.at(-2));

    const move2 = pct(closes5.at(-2), closes5.at(-3));

    const acceleration = move1 - move2;

    // ==================================================
    // ATR
    // ======================================================

    const currentATR = atr(highs5, lows5, closes5);

    const atrPct = (currentATR / lastClose) * 100;

    const healthyATR =
      atrPct >= 1 &&
      atrPct <= 4;

    // ==================================================
    // FUNDING
    // ==================================================

    let fundingScore = 0;

    let fundingReason = "";

    if (funding < 0 && momentumPct > 0) {
      fundingScore = WEIGHTS.funding;
      fundingReason = "Short squeeze potential";
    } else if (funding >= 0 && funding <= 0.0008) {
      fundingScore = WEIGHTS.funding * 0.8;
      fundingReason = "Healthy funding";
    } else if (funding > 0.003) {
      fundingScore = -5;
      fundingReason = "Overcrowded longs";
    }

    // ==================================================
    // SCORES
    // ======================================================

    const trendScore =
      trendAligned
        ? WEIGHTS.trend
        : 0;

    const volumeScore =
      sustainedVolume
        ? clamp(
            (relVol / 4) * WEIGHTS.volume,
            0,
            WEIGHTS.volume
          )
        : 0;

    const oiScore =
      healthyOI
        ? clamp(
            (oiChangePct / 2) * WEIGHTS.oi,
            0,
            WEIGHTS.oi
          )
        : 0;

    const breakoutScore =
      breakout
        ? WEIGHTS.breakout
        : 0;

    const momentumScore =
      clamp(
        (momentumPct / 2) * WEIGHTS.momentum,
        0,
        WEIGHTS.momentum
      );

    const candleScore =
      strongCandle
        ? WEIGHTS.candle
        : 0;

    const accelerationScore =
      acceleration > 0
        ? WEIGHTS.acceleration
        : 0;

    // ==================================================
    // TOTAL
    // ======================================================

    let total =
      trendScore +
      volumeScore +
      oiScore +
      breakoutScore +
      momentumScore +
      fundingScore +
      candleScore +
      accelerationScore;

    // ==================================================
    // PENALTIES
    // ======================================================

    // bad BTC environment
    if (!btcRegime.bullish) {
      total *= 0.7;
    }

    // overextended
    if (meta.change24h > 12) {
      total *= 0.75;
    }

    // weak ATR
    if (!healthyATR) {
      total *= 0.8;
    }

    // weak candle
    if (!strongCandle) {
      total *= 0.85;
    }

    // ==================================================
    // CLASSIFICATION
    // ======================================================

    let setupType = "NEUTRAL";

    if (
      relVol > 2 &&
      oiChangePct > 1 &&
      funding < 0
    ) {
      setupType = "SHORT_SQUEEZE";
    } else if (
      breakout &&
      trendAligned
    ) {
      setupType = "BREAKOUT";
    } else if (
      acceleration > 0 &&
      sustainedVolume
    ) {
      setupType = "EARLY_MOMENTUM";
    }

    // ==================================================
    // REASONS
    // ======================================================

    const reasons = [];

    if (trendAligned)
      reasons.push("MTF bullish");

    if (healthyOI)
      reasons.push("OI supports move");

    if (sustainedVolume)
      reasons.push("Sustained volume");

    if (breakout)
      reasons.push("Structure breakout");

    if (strongCandle)
      reasons.push("Strong candle");

    if (acceleration > 0)
      reasons.push("Momentum accelerating");

    if (healthyATR)
      reasons.push("Healthy volatility");

    if (fundingReason)
      reasons.push(fundingReason);

    // ==================================================
    // HARD FILTERS
    // ======================================================

    if (
      !trendAligned ||
      !healthyOI ||
      !sustainedVolume ||
      momentumPct <= 0
    ) {
      return null;
    }

    return {
      symbol,

      type: setupType,

      score: total.toFixed(2),

      momentum: momentumPct.toFixed(2) + "%",

      oi: oiChangePct.toFixed(2) + "%",

      relVol: relVol.toFixed(2),

      funding: funding.toFixed(5),

      atr: atrPct.toFixed(2) + "%",

      change24h: meta.change24h.toFixed(2) + "%",

      reasons: reasons.join(" | "),
    };
  } catch {
    return null;
  }
}

// ======================================================
// MAIN LOOP
// ======================================================

async function runScanner() {
  console.clear();

  console.log("======================================");
  console.log("ADVANCED FUTURES MOMENTUM ENGINE");
  console.log("======================================");

  console.log("");

  while (true) {
    try {
      const btcRegime = await getBTCRegime();

      const pairs = await getEligiblePairs();

      const limit = pLimit(CONCURRENCY);

      const jobs = pairs.map((p) =>
        limit(() => analyzeSymbol(p, btcRegime))
      );

      const results = (await Promise.all(jobs))
        .filter(Boolean)
        .filter((x) => Number(x.score) >= 55)
        .sort((a, b) => Number(b.score) - Number(a.score))
        .slice(0, TOP_RESULTS);

      console.clear();

      console.log(
        `=== QUALITY PUMP TRACKER | ${new Date().toLocaleTimeString()} ===`
      );

      console.log("");

      console.log(
        `BTC REGIME: ${
          btcRegime.bullish ? "BULLISH" : "WEAK"
        } | BTC MOMENTUM: ${btcRegime.momentum}%`
      );

      console.log("");

      if (!results.length) {
        console.log("No high-quality continuation setups.");
      } else {
        console.table(results);
      }
    } catch (err) {
      console.log("Loop error:", err.message);
    }

    await sleep(LOOP_MS);
  }
}

runScanner();
