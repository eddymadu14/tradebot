// long-trend-tracker.js
// npm install axios p-limit
// node long-trend-tracker.js

import axios from "axios";
import pLimit from "p-limit";

// ======================================================
// CONFIG
// ======================================================

const BASE_URL = "https://fapi.binance.com";

const CONCURRENCY = 5;

const LOOP_MS = 60_000;

const TOP_RESULTS = 20;

const LOOKBACK = 250;

const MIN_24H_VOLUME = 40_000_000;

// ======================================================
// WEIGHTS
// ======================================================

const WEIGHTS = {
  trend: 25,
  relativeStrength: 15,
  accumulation: 15,
  oiPersistence: 15,
  pullback: 10,
  funding: 10,
  volume: 10,
};

// ======================================================
// HTTP
// ======================================================

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
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
// OBV
// ======================================================

function obv(closes, volumes) {
  let val = 0;

  const result = [0];

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      val += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      val -= volumes[i];
    }

    result.push(val);
  }

  return result;
}

// ======================================================
// FETCHERS
// ======================================================

async function getTickers24h() {
  const { data } = await api.get("/fapi/v1/ticker/24hr");
  return data;
}

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

async function getFunding(symbol) {
  const { data } = await api.get("/fapi/v1/premiumIndex", {
    params: { symbol },
  });

  return num(data.lastFundingRate);
}

async function getOpenInterest(symbol) {
  const { data } = await api.get("/fapi/v1/openInterest", {
    params: { symbol },
  });

  return num(data.openInterest);
}

// ======================================================
// BTC REGIME
// ======================================================

async function getBTCRegime() {
  try {
    const k = await getKlines("BTCUSDT", "4h", 200);

    const closes = k.map((x) => num(x[4]));

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const ema200 = ema(closes, 200);

    const last = closes.at(-1);

    const bullish =
      last > ema20 &&
      ema20 > ema50 &&
      ema50 > ema200;

    return {
      bullish,
      last,
    };
  } catch {
    return {
      bullish: false,
      last: 0,
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
// MAIN ANALYZER
// ======================================================

async function analyzeSymbol(meta, btcRegime, btc4hReturn) {
  const symbol = meta.symbol;

  try {
    // ==================================================
    // FETCH
    // ==================================================

    const oi1 = await getOpenInterest(symbol);

    await sleep(150);

    const [k4h, k1d, funding] = await Promise.all([
      getKlines(symbol, "4h", LOOKBACK),
      getKlines(symbol, "1d", LOOKBACK),
      getFunding(symbol),
    ]);

    await sleep(150);

    const oi2 = await getOpenInterest(symbol);

    // ==================================================
    // EXTRACT
    // ==================================================

    const closes4h = k4h.map((x) => num(x[4]));
    const highs4h = k4h.map((x) => num(x[2]));
    const lows4h = k4h.map((x) => num(x[3]));
    const volumes4h = k4h.map((x) => num(x[5]));

    const closes1d = k1d.map((x) => num(x[4]));

    const last = closes4h.at(-1);

    // ==================================================
    // EMA STACK
    // ==================================================

    const ema20_4h = ema(closes4h, 20);
    const ema50_4h = ema(closes4h, 50);
    const ema200_4h = ema(closes4h, 200);

    const ema20_1d = ema(closes1d, 20);
    const ema50_1d = ema(closes1d, 50);

    const bullish4h =
      ema20_4h > ema50_4h &&
      ema50_4h > ema200_4h;

    const bullish1d =
      ema20_1d > ema50_1d;

    const trendAligned =
      bullish4h &&
      bullish1d;

    // ==================================================
    // RELATIVE STRENGTH
    // ==================================================

    const coinReturn4h = pct(
      closes4h.at(-1),
      closes4h.at(-7)
    );

    const relativeStrength =
      coinReturn4h - btc4hReturn;

    const strongRS =
      relativeStrength > 2;

    // ==================================================
    // OI PERSISTENCE
    // ======================================================

    const oiChangePct = pct(oi2, oi1);

    const healthyOI =
      oiChangePct > 0 &&
      oiChangePct < 12;

    // ==================================================
    // FUNDING
    // ======================================================

    let fundingState = "Neutral";

    let fundingScore = 0;

    if (
      funding >= -0.0005 &&
      funding <= 0.001
    ) {
      fundingState = "Healthy";

      fundingScore = WEIGHTS.funding;
    } else if (funding > 0.003) {
      fundingState = "Crowded";
      fundingScore = 0;
    }

    // ==================================================
    // ATR
    // ======================================================

    const currentATR = atr(
      highs4h,
      lows4h,
      closes4h
    );

    const atrPct =
      (currentATR / last) * 100;

    // ==================================================
    // ACCUMULATION
    // ======================================================

    const recentRangeHigh = Math.max(
      ...highs4h.slice(-20)
    );

    const recentRangeLow = Math.min(
      ...lows4h.slice(-20)
    );

    const rangeCompression =
      pct(recentRangeHigh, recentRangeLow);

    const compressed =
      rangeCompression < 18;

    // ==================================================
    // OBV
    // ======================================================

    const obvSeries = obv(
      closes4h,
      volumes4h
    );

    const obvTrend =
      obvSeries.at(-1) >
      obvSeries.at(-10);

    // ==================================================
    // PULLBACK QUALITY
    // ======================================================

    const localHigh = Math.max(
      ...highs4h.slice(-30)
    );

    const pullbackDepth =
      pct(localHigh, last);

    const healthyPullback =
      pullbackDepth >= 3 &&
      pullbackDepth <= 10;

    // ==================================================
    // VOLUME PERSISTENCE
    // ======================================================

    const recentVol = avg(
      volumes4h.slice(-8)
    );

    const baselineVol = avg(
      volumes4h.slice(-40, -8)
    );

    const relVol =
      baselineVol === 0
        ? 0
        : recentVol / baselineVol;

    const sustainedVolume =
      relVol > 1.5;

    // ==================================================
    // TREND AGE
    // ======================================================

    const change24h = meta.change24h;

    const exhausted =
      change24h > 35;

    // ==================================================
    // SCORES
    // ======================================================

    const trendScore =
      trendAligned
        ? WEIGHTS.trend
        : 0;

    const rsScore =
      strongRS
        ? clamp(
            relativeStrength *
              WEIGHTS.relativeStrength *
              0.2,
            0,
            WEIGHTS.relativeStrength
          )
        : 0;

    const accumulationScore =
      compressed && obvTrend
        ? WEIGHTS.accumulation
        : 0;

    const oiScore =
      healthyOI
        ? clamp(
            oiChangePct *
              WEIGHTS.oiPersistence *
              0.15,
            0,
            WEIGHTS.oiPersistence
          )
        : 0;

    const pullbackScore =
      healthyPullback
        ? WEIGHTS.pullback
        : 0;

    const volumeScore =
      sustainedVolume
        ? clamp(
            relVol *
              WEIGHTS.volume *
              0.3,
            0,
            WEIGHTS.volume
          )
        : 0;

    // ==================================================
    // TOTAL
    // ======================================================

    let total =
      trendScore +
      rsScore +
      accumulationScore +
      oiScore +
      pullbackScore +
      fundingScore +
      volumeScore;

    // ==================================================
    // PENALTIES
    // ======================================================

    if (!btcRegime.bullish) {
      total *= 0.65;
    }

    if (exhausted) {
      total *= 0.7;
    }

    if (atrPct > 10) {
      total *= 0.75;
    }

    // ==================================================
    // CLASSIFICATION
    // ======================================================

    let setupType = "TREND";

    if (
      compressed &&
      sustainedVolume
    ) {
      setupType = "ACCUMULATION_BREAKOUT";
    }

    if (
      healthyPullback &&
      trendAligned
    ) {
      setupType = "TREND_PULLBACK";
    }

    if (
      strongRS &&
      healthyOI
    ) {
      setupType = "MARKET_LEADER";
    }

    // ==================================================
    // REASONS
    // ======================================================

    const reasons = [];

    if (trendAligned)
      reasons.push("4H/1D EMA aligned");

    if (strongRS)
      reasons.push("Outperforming BTC");

    if (healthyOI)
      reasons.push("Healthy OI expansion");

    if (compressed)
      reasons.push("Range compression");

    if (obvTrend)
      reasons.push("OBV accumulation");

    if (healthyPullback)
      reasons.push("Healthy pullback");

    if (sustainedVolume)
      reasons.push("Sustained volume");

    if (fundingState === "Healthy")
      reasons.push("Healthy funding");

    // ==================================================
    // HARD FILTERS
    // ======================================================

    if (
      !trendAligned ||
      !strongRS ||
      !healthyOI ||
      exhausted
    ) {
      return null;
    }

    return {
      symbol,

      type: setupType,

      score: total.toFixed(2),

      rsVsBTC:
        relativeStrength.toFixed(2) + "%",

      oi:
        oiChangePct.toFixed(2) + "%",

      funding:
        funding.toFixed(5),

      relVol:
        relVol.toFixed(2),

      pullback:
        pullbackDepth.toFixed(2) + "%",

      atr:
        atrPct.toFixed(2) + "%",

      reasons:
        reasons.join(" | "),
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

  console.log("===========================================");
  console.log("LONG TREND PERSISTENCE TRACKER");
  console.log("===========================================");

  console.log("");

  while (true) {
    try {
      // ================================================
      // BTC REGIME
      // ================================================

      const btcRegime =
        await getBTCRegime();

      const btc4h =
        await getKlines(
          "BTCUSDT",
          "4h",
          20
        );

      const btcCloses = btc4h.map((x) =>
        num(x[4])
      );

      const btc4hReturn = pct(
        btcCloses.at(-1),
        btcCloses.at(-7)
      );

      // ================================================
      // PAIRS
      // ================================================

      const pairs =
        await getEligiblePairs();

      const limit =
        pLimit(CONCURRENCY);

      const jobs = pairs.map((p) =>
        limit(() =>
          analyzeSymbol(
            p,
            btcRegime,
            btc4hReturn
          )
        )
      );

      const results = (
        await Promise.all(jobs)
      )
        .filter(Boolean)
        .filter(
          (x) => Number(x.score) >= 55
        )
        .sort(
          (a, b) =>
            Number(b.score) -
            Number(a.score)
        )
        .slice(0, TOP_RESULTS);

      // ================================================
      // OUTPUT
      // ================================================

      console.clear();

      console.log(
        `=== LONG TREND TRACKER | ${new Date().toLocaleTimeString()} ===`
      );

      console.log("");

      console.log(
        `BTC REGIME: ${
          btcRegime.bullish
            ? "BULLISH"
            : "WEAK"
        }`
      );

      console.log("");

      if (!results.length) {
        console.log(
          "No strong multi-day trend candidates."
        );
      } else {
        console.table(results);
      }
    } catch (err) {
      console.log(
        "Loop error:",
        err.message
      );
    }

    await sleep(LOOP_MS);
  }
}

runScanner();
