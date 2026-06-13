// pump-tracker.js
// npm install axios p-limit
// Run: node pump-tracker.js

import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const CONCURRENCY = 8;
const INTERVAL = "5m";
const LOOKBACK = 50;
const MIN_24H_VOLUME = 10_000_000; // 20M USDT
const TOP_RESULTS = 15;
const LOOP_MS = 30_000;

// ----------------------------
// WEIGHTS
// ----------------------------
const WEIGHTS = {
  volume: 30,
  oi: 25,
  momentum: 20,
  breakout: 15,
  funding: 10,
};

// ----------------------------
// HTTP
// ----------------------------
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 12000,
});

// ----------------------------
// HELPERS
// ----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function num(v) {
  return Number(v || 0);
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ----------------------------
// FETCHERS
// ----------------------------
async function getTickers24h() {
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

// ----------------------------
// FILTER PAIRS
// ----------------------------
async function getEligiblePairs() {
  const tickers = await getTickers24h();

  return tickers
    .filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        num(x.quoteVolume) >= MIN_24H_VOLUME &&
        !x.symbol.includes("_")
    )
    .map((x) => ({
      symbol: x.symbol,
      quoteVolume: num(x.quoteVolume),
      priceChangePercent: num(x.priceChangePercent),
    }));
}

// ----------------------------
// SCORE ENGINE
// ----------------------------
async function analyzeSymbol(meta) {
  const symbol = meta.symbol;

  try {
    const oi1 = await getOpenInterest(symbol);
    await sleep(300);
    const [klines, funding] = await Promise.all([
      getKlines(symbol),
      getFunding(symbol),
    ]);
    await sleep(300);
    const oi2 = await getOpenInterest(symbol);

    if (!klines || klines.length < 25) return null;

    const closes = klines.map((k) => num(k[4]));
    const highs = klines.map((k) => num(k[2]));
    const lows = klines.map((k) => num(k[3]));
    const volumes = klines.map((k) => num(k[5]));

    const lastClose = closes.at(-1);
    const prevClose = closes.at(-2);
    const lastHigh = highs.at(-1);
    const lastLow = lows.at(-1);
    const lastVol = volumes.at(-1);

    const avgVol = avg(volumes.slice(0, -1));
    const relVol = avgVol ? lastVol / avgVol : 0;

    const momentumPct = pct(lastClose, prevClose);

    const range = pct(lastHigh, lastLow); // candle range %

    const recentHigh = Math.max(...highs.slice(-21, -1));
    const breakout = lastClose > recentHigh;

    const oiChangePct = pct(oi2, oi1);

    // ----------------------------
    // SUB SCORES
    // ----------------------------
    const volumeScore = clamp((relVol / 5) * WEIGHTS.volume, 0, WEIGHTS.volume);

    const oiScore =
      oiChangePct > 0
        ? clamp((oiChangePct / 2) * WEIGHTS.oi, 0, WEIGHTS.oi)
        : 0;

    const momentumScore = clamp(
      (momentumPct / 2) * WEIGHTS.momentum,
      0,
      WEIGHTS.momentum
    );

    const breakoutScore = breakout ? WEIGHTS.breakout : 0;

    // lower funding is healthier for early pumps
    let fundingScore = 0;
    if (funding >= 0 && funding <= 0.0008) fundingScore = WEIGHTS.funding;
    else if (funding > 0.0008 && funding <= 0.0015)
      fundingScore = WEIGHTS.funding * 0.5;

    const total =
      volumeScore +
      oiScore +
      momentumScore +
      breakoutScore +
      fundingScore;

    return {
      symbol,
      score: total.toFixed(2),
      relVol: relVol.toFixed(2),
      oiChangePct: oiChangePct.toFixed(2),
      momentumPct: momentumPct.toFixed(2),
      rangePct: range.toFixed(2),
      breakout,
      funding: funding.toFixed(6),
      volume24h: Math.round(meta.quoteVolume),
    };
  } catch (err) {
    return null;
  }
}

// ----------------------------
// LOOP
// ----------------------------
async function runScanner() {
  console.clear();
  console.log("=== BINANCE FUTURES PUMP TRACKER ===");
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
        `=== LIVE PUMP TRACKER | ${new Date().toLocaleTimeString()} ===`
      );
      console.log("");

      if (!results.length) {
        console.log("No quality pump setups detected.");
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
