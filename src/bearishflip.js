// index.js
import fs from "fs";
import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const FILE_PATH = "./pairs.txt";

const TOP_LIMIT = 5;
const INTERVAL = "15m";
const CANDLE_LIMIT = 50;

const DISCOVERY_INTERVAL = 10 * 60 * 1000; // 10 mins
const MONITOR_INTERVAL = 60 * 1000; // 1 min

// In-memory state (prevents spam alerts)
const flippedPairs = new Set();

// ----------------------------
// FILE HELPERS
// ----------------------------
function readPairs() {
  if (!fs.existsSync(FILE_PATH)) return [];
  return fs.readFileSync(FILE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean);
}

function savePairs(pairs) {
  fs.writeFileSync(FILE_PATH, pairs.join("\n"));
}

// ----------------------------
// 1. FETCH TOP GAINERS
// ----------------------------
async function fetchTopGainers() {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`);

    return res.data
      .filter(p => p.symbol.endsWith("USDT"))
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, TOP_LIMIT)
      .map(p => p.symbol);

  } catch (err) {
    console.error("❌ Fetch error:", err.message);
    return [];
  }
}

// ----------------------------
// 2. MERGE PAIRS (NO DUPLICATES)
// ----------------------------
function mergePairs(existing, incoming) {
  return [...new Set([...existing, ...incoming])];
}

// ----------------------------
// 3. FETCH CANDLES
// ----------------------------
async function fetchCandles(symbol) {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: {
        symbol,
        interval: INTERVAL,
        limit: CANDLE_LIMIT
      }
    });

    return res.data.map(c => ({
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4])
    }));

  } catch (err) {
    console.error(`❌ Candle error ${symbol}:`, err.message);
    return [];
  }
}

// ----------------------------
// 4. SWING LOW DETECTION
// ----------------------------
function findSwingLows(candles) {
  const lows = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i + 1].low
    ) {
      lows.push({ index: i, price: candles[i].low });
    }
  }

  return lows;
}

// ----------------------------
// 5. LAST HIGHER LOW
// ----------------------------
function getLastHigherLow(lows) {
  if (lows.length < 2) return null;

  for (let i = lows.length - 1; i > 0; i--) {
    if (lows[i].price > lows[i - 1].price) {
      return lows[i];
    }
  }

  return null;
}

// ----------------------------
// 6. BEARISH FLIP CHECK
// ----------------------------
function isBearishFlip(candles) {
  const lows = findSwingLows(candles);
  const lastHL = getLastHigherLow(lows);

  if (!lastHL) return false;

  const currentPrice = candles[candles.length - 1].close;

  return currentPrice < lastHL.price;
}

// ----------------------------
// 🔵 DISCOVERY LOOP
// ----------------------------
async function discoveryLoop() {
  console.log("\n🔍 Running discovery...");

  const newPairs = await fetchTopGainers();
  const existingPairs = readPairs();

  const merged = mergePairs(existingPairs, newPairs);

  savePairs(merged);

  console.log("📈 Updated Pairs:", merged);
}

// ----------------------------
// 🔴 MONITOR LOOP
// ----------------------------
async function monitorLoop() {
  const pairs = readPairs();

  for (const symbol of pairs) {
    const candles = await fetchCandles(symbol);
    if (!candles.length) continue;

    const flipped = isBearishFlip(candles);

    if (flipped && !flippedPairs.has(symbol)) {
      console.log(`🚨 BEARISH FLIP: ${symbol}`);
      flippedPairs.add(symbol);
    } else if (!flipped) {
      console.log(`✅ ${symbol} intact`);
    }
  }
}

// ----------------------------
// MAIN
// ----------------------------
async function main() {
  console.log("🚀 System Started");

  // Run immediately
  await discoveryLoop();
  await monitorLoop();

  // Schedule loops
  setInterval(discoveryLoop, DISCOVERY_INTERVAL);
  setInterval(monitorLoop, MONITOR_INTERVAL);
}

main();
