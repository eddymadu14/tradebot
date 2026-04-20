// marubozu-opposite-scanner.js
// Scan Binance Futures USDT pairs for DAILY opposite-direction Marubozu candles
// Conditions:
// - USDT perpetual futures only
// - 24h quote volume >= 20,000,000 USDT
// - Latest CLOSED daily candle opposite direction of previous day
// - Latest candle body move >= 5%
// - Tiny wick tolerance = 5% of total candle range
// - Ignore previous doji candles
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

const MIN_VOLUME = 20_000_000;
const MIN_MOVE = 5; // %
const WICK_TOLERANCE = 0.05; // 5% of total range

const limit = pLimit(CONCURRENCY);

// ---------------------------
// Helpers
// ---------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeGet(url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      return res.data;
    } catch (err) {
      if (i === retries) throw err;
      await sleep(700 * i);
    }
  }
}

function direction(open, close) {
  if (close > open) return "bullish";
  if (close < open) return "bearish";
  return "doji";
}

function pct(a, b) {
  return ((b - a) / a) * 100;
}

function num(x) {
  return Number(x);
}

function formatMillions(v) {
  return (v / 1_000_000).toFixed(2) + "M";
}

// ---------------------------
// Binance Data
// ---------------------------

async function getUsdtPairs() {
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

async function get24hTickers() {
  return await safeGet(`${BASE}/fapi/v1/ticker/24hr`);
}

async function getKlines(symbol) {
  return await safeGet(
    `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=3`
  );
}

// ---------------------------
// Pattern Detection
// ---------------------------

function analyze(symbol, klines, volume) {
  if (!klines || klines.length < 3) return null;

  const prev = klines[1];
  const cur = klines[2];

  const prevOpen = num(prev[1]);
  const prevHigh = num(prev[2]);
  const prevLow = num(prev[3]);
  const prevClose = num(prev[4]);

  const curOpen = num(cur[1]);
  const curHigh = num(cur[2]);
  const curLow = num(cur[3]);
  const curClose = num(cur[4]);

  const prevDir = direction(prevOpen, prevClose);
  if (prevDir === "doji") return null;

  const curDir = direction(curOpen, curClose);
  if (curDir === "doji") return null;

  // Must be opposite direction
  if (
    (prevDir === "bullish" && curDir !== "bearish") ||
    (prevDir === "bearish" && curDir !== "bullish")
  ) {
    return null;
  }

  // Body move >= 5%
  const move = Math.abs(pct(curOpen, curClose));
  if (move < MIN_MOVE) return null;

  // Candle range
  const range = curHigh - curLow;
  if (range <= 0) return null;

  // Wick sizes
  let upperWick = 0;
  let lowerWick = 0;

  if (curDir === "bullish") {
    upperWick = curHigh - curClose;
    lowerWick = curOpen - curLow;
  } else {
    upperWick = curHigh - curOpen;
    lowerWick = curClose - curLow;
  }

  const maxAllowedWick = range * WICK_TOLERANCE;

  if (upperWick > maxAllowedWick || lowerWick > maxAllowedWick) {
    return null;
  }

  return {
    symbol,
    prevDir,
    curDir,
    move,
    volume,
    open: curOpen,
    close: curClose,
    high: curHigh,
    low: curLow,
  };
}

// ---------------------------
// Main
// ---------------------------

async function main() {
  console.log("Fetching Binance Futures pairs...");

  const pairs = await getUsdtPairs();
  const tickers = await get24hTickers();

  const volMap = {};
  for (const t of tickers) {
    volMap[t.symbol] = Number(t.quoteVolume);
  }

  const filteredPairs = pairs.filter(
    (s) => (volMap[s] || 0) >= MIN_VOLUME
  );

  console.log(`Total USDT Perpetual Pairs: ${pairs.length}`);
  console.log(`Pairs with >= $20M volume: ${filteredPairs.length}`);
  console.log("Scanning...\n");

  let done = 0;
  const hits = [];

  const tasks = filteredPairs.map((symbol) =>
    limit(async () => {
      try {
        const klines = await getKlines(symbol);
        const result = analyze(symbol, klines, volMap[symbol]);

        if (result) hits.push(result);
      } catch (e) {
        // silent fail
      }

      done++;
      process.stdout.write(
        `Scanned ${done}/${filteredPairs.length}\r`
      );
    })
  );

  await Promise.all(tasks);

  console.log("\n");

  hits.sort((a, b) => b.move - a.move);

  if (!hits.length) {
    console.log("No qualifying pairs found.");
    return;
  }

  console.log("=== QUALIFYING PAIRS ===\n");

  for (const h of hits) {
    const sign = h.curDir === "bullish" ? "+" : "-";

    console.log(
      `${h.symbol.padEnd(12)} | ${h.curDir.toUpperCase().padEnd(7)} | Prev: ${h.prevDir.padEnd(7)} | ${sign}${h.move.toFixed(2)}% | Vol: ${formatMillions(h.volume)}`
    );
  }

  console.log(`\nTotal Hits: ${hits.length}`);
}

main().catch(console.error);
