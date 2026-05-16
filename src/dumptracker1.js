// dump-tracker.js
// npm install axios p-limit
// Run: node dump-tracker.js

import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const CONCURRENCY = 8;

const INTERVAL = "5m";
const LOOKBACK = 50;

const MIN_24H_VOLUME = 20_000_000; // 20M USDT minimum
const TOP_RESULTS = 15;
const LOOP_MS = 30_000;

// -----------------------------
// WEIGHTS (100 TOTAL)
// -----------------------------
const WEIGHTS = {
  negMomentum: 25,   // price falling fast
  volumeSpike: 25,   // abnormal sell activity
  breakdown: 20,     // support break
  oiBehavior: 20,    // new shorts or long liquidations
  fundingShift: 10,  // neutral/negative funding
};

// -----------------------------
// AXIOS
// -----------------------------
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 12000,
});

// -----------------------------
// HELPERS
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => Number(v || 0);

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

// -----------------------------
// FETCHERS
// -----------------------------
async function get24hTickers() {
  const { data } = await api.get("/fapi/v1/ticker/24hr");
  return data;
}

async function getKlines(symbol, interval = INTERVAL, limit = LOOKBACK) {
  const { data } = await api.get("/fapi/v1/klines", {
    params: { symbol, interval, limit },
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

// -----------------------------
// ELIGIBLE PAIRS
// -----------------------------
async function getEligiblePairs() {
  const tickers = await get24hTickers();

  return tickers
    .filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("_") &&
        num(x.quoteVolume) >= MIN_24H_VOLUME
    )
    .map((x) => ({
      symbol: x.symbol,
      quoteVolume: num(x.quoteVolume),
    }));
}

// -----------------------------
// ANALYZE SYMBOL
// Implements the six detects:
//
// 1. Negative momentum expansion
// 2. Sell volume aggression
// 3. Open interest behavior
// 4. Breakdown of support
// 5. Funding shifts
// 6. Liquidation cascade potential
// -----------------------------
async function analyzeSymbol(meta) {
  const symbol = meta.symbol;

  try {
    const oi1 = await getOpenInterest(symbol);
    await sleep(250);

    const [klines, funding] = await Promise.all([
      getKlines(symbol),
      getFunding(symbol),
    ]);

    await sleep(250);
    const oi2 = await getOpenInterest(symbol);

    if (!klines || klines.length < 25) return null;

    const opens = klines.map((k) => num(k[1]));
    const highs = klines.map((k) => num(k[2]));
    const lows = klines.map((k) => num(k[3]));
    const closes = klines.map((k) => num(k[4]));
    const vols = klines.map((k) => num(k[5]));

    const lastOpen = opens.at(-1);
    const lastHigh = highs.at(-1);
    const lastLow = lows.at(-1);
    const lastClose = closes.at(-1);
    const prevClose = closes.at(-2);

    const lastVol = vols.at(-1);
    const avgVol = avg(vols.slice(0, -1));

    // -----------------------------
    // 1. Negative momentum expansion
    // -----------------------------
    const momentumPct = pct(lastClose, prevClose); // negative is bearish
    const bearishMove = Math.abs(Math.min(momentumPct, 0));

    // -----------------------------
    // 2. Sell volume aggression
    // -----------------------------
    const relVol = avgVol ? lastVol / avgVol : 0;
    const redCandle = lastClose < lastOpen;

    // -----------------------------
    // 3. Open interest behavior
    // price down + OI up   = new shorts
    // price down + OI down = long liquidation
    // -----------------------------
    const oiChangePct = pct(oi2, oi1);

    // -----------------------------
    // 4. Breakdown of support
    // use previous 20-candle low
    // -----------------------------
    const recentLow = Math.min(...lows.slice(-21, -1));
    const breakdown = lastClose < recentLow;

    // -----------------------------
    // 5. Funding shifts
    // neutral to negative preferred
    // -----------------------------

    // -----------------------------
    // 6. Liquidation cascade potential
    // strong red candle + large range + price down + OI down
    // -----------------------------
    const rangePct = pct(lastHigh, lastLow);

    // =============================
    // SUB SCORES
    // =============================

    // Negative Momentum
    const momentumScore =
      momentumPct < 0
        ? clamp(
            (bearishMove / 2.5) * WEIGHTS.negMomentum,
            0,
            WEIGHTS.negMomentum
          )
        : 0;

    // Volume Spike
    let volumeScore = 0;
    if (redCandle) {
      volumeScore = clamp(
        (relVol / 4) * WEIGHTS.volumeSpike,
        0,
        WEIGHTS.volumeSpike
      );
    }

    // Breakdown
    const breakdownScore = breakdown ? WEIGHTS.breakdown : 0;

    // OI Behavior
    let oiScore = 0;

    // new shorts entering
    if (momentumPct < 0 && oiChangePct > 0) {
      oiScore = clamp(
        (oiChangePct / 2) * WEIGHTS.oiBehavior,
        0,
        WEIGHTS.oiBehavior
      );
    }

    // long liquidation dump
    if (momentumPct < 0 && oiChangePct < 0) {
      oiScore = clamp(
        (Math.abs(oiChangePct) / 3) * (WEIGHTS.oiBehavior * 0.8),
        0,
        WEIGHTS.oiBehavior
      );
    }

    // Funding
    let fundingScore = 0;

    if (funding <= 0 && funding >= -0.0012) {
      fundingScore = WEIGHTS.fundingShift;
    } else if (funding < -0.0012 && funding >= -0.003) {
      fundingScore = WEIGHTS.fundingShift * 0.5;
    }

    // Liquidation cascade booster
    let cascadeBonus = 0;
    if (
      momentumPct < -1 &&
      rangePct > 1.5 &&
      oiChangePct < 0 &&
      relVol > 2
    ) {
      cascadeBonus = 8;
    }

    const total =
      momentumScore +
      volumeScore +
      breakdownScore +
      oiScore +
      fundingScore +
      cascadeBonus;

    return {
      symbol,
      score: total.toFixed(2),
      dropPct: momentumPct.toFixed(2),
      relVol: relVol.toFixed(2),
      oiPct: oiChangePct.toFixed(2),
      funding: funding.toFixed(6),
      rangePct: rangePct.toFixed(2),
      breakdown,
      type:
        momentumPct < 0 && oiChangePct > 0
          ? "NEW SHORTS"
          : momentumPct < 0 && oiChangePct < 0
          ? "LONG LIQ"
          : "MIXED",
      vol24h: Math.round(meta.quoteVolume),
    };
  } catch {
    return null;
  }
}

// -----------------------------
// MAIN LOOP
// -----------------------------
async function run() {
  console.clear();
  console.log("=== BINANCE FUTURES DUMP TRACKER ===");
  console.log("Min 24h Volume:", MIN_24H_VOLUME.toLocaleString(), "USDT");
  console.log("Scanning every", LOOP_MS / 1000, "sec...\n");

  while (true) {
    try {
      const pairs = await getEligiblePairs();

      const limit = pLimit(CONCURRENCY);

      const jobs = pairs.map((p) => limit(() => analyzeSymbol(p)));

      const results = (await Promise.all(jobs))
        .filter(Boolean)
        .filter((x) => Number(x.score) >= 45)
        .sort((a, b) => Number(b.score) - Number(a.score))
        .slice(0, TOP_RESULTS);

      console.clear();
      console.log(
        `=== LIVE DUMP TRACKER | ${new Date().toLocaleTimeString()} ===`
      );
      console.log("");

      if (!results.length) {
        console.log("No strong dump setups detected.");
      } else {
        console.table(results);
      }
    } catch (err) {
      console.log("Loop Error:", err.message);
    }

    await sleep(LOOP_MS);
  }
}

run();
