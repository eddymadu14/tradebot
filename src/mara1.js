// marubozu-opposite-scanner.js
// MODIFIED VERSION
// Outputs:
//
// A-Class:
// Closed candle body >= 5%
//
// B-Class:
// Candle reached >= 5% intraday but closed below 5%
//
// Conditions remain:
// - Opposite to previous day direction
// - Latest closed daily candle
// - Tiny wick tolerance 5%
// - Volume >= $20M
//
// Install:
// npm install axios p-limit
//
// Run:
// node marubozu-opposite-scanner.js

import axios from "axios";
import pLimit from "p-limit";

const BASE = "https://fapi.binance.com";
const CONCURRENCY = 8;

const MIN_VOLUME = 1_000_000;
const THRESHOLD = 5;
const WICK_TOLERANCE = 0.2;

const limit = pLimit(CONCURRENCY);

// ------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeGet(url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      return res.data;
    } catch {
      if (i === retries) throw new Error("failed");
      await sleep(700 * i);
    }
  }
}

function num(x) {
  return Number(x);
}

function dir(o, c) {
  if (c > o) return "bullish";
  if (c < o) return "bearish";
  return "doji";
}

function pct(a, b) {
  return ((b - a) / a) * 100;
}

function fmtVol(v) {
  return (v / 1_000_000).toFixed(2) + "M";
}

// ------------------

async function getPairs() {
  const data = await safeGet(`${BASE}/fapi/v1/exchangeInfo`);

  return data.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING"
    )
    .map((s) => s.symbol);
}

async function getTickers() {
  return await safeGet(`${BASE}/fapi/v1/ticker/24hr`);
}

async function getKlines(symbol) {
  return await safeGet(
    `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=3`
  );
}

// ------------------

function analyze(symbol, klines, volume) {
  if (klines.length < 3) return null;

  const prev = klines[1];
  const cur = klines[2];

  const po = num(prev[1]);
  const pc = num(prev[4]);

  const o = num(cur[1]);
  const h = num(cur[2]);
  const l = num(cur[3]);
  const c = num(cur[4]);

  const prevDir = dir(po, pc);
  const curDir = dir(o, c);

  if (prevDir === "doji" || curDir === "doji") return null;

  // opposite direction
  if (
    (prevDir === "bullish" && curDir !== "bearish") ||
    (prevDir === "bearish" && curDir !== "bullish")
  ) {
    return null;
  }

  // wick check
  const range = h - l;
  if (range <= 0) return null;

  let upper = 0;
  let lower = 0;

  if (curDir === "bullish") {
    upper = h - c;
    lower = o - l;
  } else {
    upper = h - o;
    lower = c - l;
  }

  const maxWick = range * WICK_TOLERANCE;

  if (upper > maxWick || lower > maxWick) return null;

  // close body move
  const closeMove = Math.abs(pct(o, c));

  // max intraday move
  let peakMove = 0;

  if (curDir === "bullish") {
    peakMove = pct(o, h);
  } else {
    peakMove = Math.abs(pct(o, l));
  }

  let grade = null;

  if (closeMove >= THRESHOLD) {
    grade = "A";
  } else if (peakMove >= THRESHOLD && closeMove < THRESHOLD) {
    grade = "B";
  } else {
    return null;
  }

  return {
    symbol,
    prevDir,
    curDir,
    closeMove,
    peakMove,
    grade,
    volume,
  };
}

// ------------------

async function main() {
  console.log("Loading markets...");

  const pairs = await getPairs();
  const tickers = await getTickers();

  const volMap = {};
  for (const t of tickers) {
    volMap[t.symbol] = Number(t.quoteVolume);
  }

  const filtered = pairs.filter(
    (s) => (volMap[s] || 0) >= MIN_VOLUME
  );

  console.log(`Pairs after volume filter: ${filtered.length}`);
  console.log("Scanning...\n");

  let done = 0;
  const hits = [];

  const jobs = filtered.map((symbol) =>
    limit(async () => {
      try {
        const klines = await getKlines(symbol);
        const r = analyze(symbol, klines, volMap[symbol]);
        if (r) hits.push(r);
      } catch {}

      done++;
      process.stdout.write(`Scanned ${done}/${filtered.length}\r`);
    })
  );

  await Promise.all(jobs);

  console.log("\n");

  if (!hits.length) {
    console.log("No signals found.");
    return;
  }

  hits.sort((a, b) => {
    if (a.grade !== b.grade) return a.grade.localeCompare(b.grade);
    return b.peakMove - a.peakMove;
  });

  console.log("=== SIGNALS ===\n");

  for (const h of hits) {
    const sign = h.curDir === "bullish" ? "+" : "-";

    console.log(
      `${h.symbol.padEnd(12)} | ${h.grade}-Class | ${h.curDir.toUpperCase().padEnd(7)} | Prev:${h.prevDir.padEnd(7)} | Close:${sign}${h.closeMove.toFixed(2)}% | Peak:${sign}${h.peakMove.toFixed(2)}% | Vol:${fmtVol(h.volume)}`
    );
  }

  console.log(`\nA = Closed >=5%`);
  console.log(`B = Hit >=5%, closed below 5%`);
  console.log(`Total Hits: ${hits.length}`);
}

main().catch(console.error);
