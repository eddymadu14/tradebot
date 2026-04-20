import fs from "fs";
import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const FILE_PATH = "./pairs.txt";
const FLIP_FILE_PATH = "./flip.txt"; // ✅ NEW FILE

const TOP_LIMIT = 5;
const INTERVAL = "15m";
const CANDLE_LIMIT = 50;

const DISCOVERY_INTERVAL = 10 * 60 * 1000;
const MONITOR_INTERVAL = 60 * 1000;

const MIN_QUOTE_VOLUME = 50_000_000;

// In-memory state
const flippedPairs = new Set();
let validPerpSymbols = new Set();

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

// ✅ NEW: Read flip file
function readFlipPairs() {
  if (!fs.existsSync(FLIP_FILE_PATH)) return [];
  return fs.readFileSync(FLIP_FILE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean);
}

// ✅ NEW: Save flip file
function saveFlipPairs(pairs) {
  fs.writeFileSync(FLIP_FILE_PATH, pairs.join("\n"));
}

// ----------------------------
// LOAD SYMBOLS
// ----------------------------
async function loadPerpSymbols() {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);

    validPerpSymbols = new Set(
      res.data.symbols
        .filter(s =>
          s.contractType === "PERPETUAL" &&
          s.quoteAsset === "USDT" &&
          s.status === "TRADING"
        )
        .map(s => s.symbol)
    );

    console.log(`✅ Loaded ${validPerpSymbols.size} USDT PERP symbols`);
  } catch (err) {
    console.error("❌ Failed to load symbols:", err.message);
  }
}

// ----------------------------
// FETCH TOP GAINERS
// ----------------------------
async function fetchTopGainers() {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`);

    const filtered = res.data.filter(p =>
      validPerpSymbols.has(p.symbol) &&
      parseFloat(p.quoteVolume) > MIN_QUOTE_VOLUME
    );

    const sorted = filtered
      .sort((a, b) =>
        parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent)
      )
      .slice(0, TOP_LIMIT);

    return sorted.map(p => p.symbol);

  } catch (err) {
    console.error("❌ Fetch error:", err.message);
    return [];
  }
}

// ----------------------------
// MERGE
// ----------------------------
function mergePairs(existing, incoming) {
  return [...new Set([...existing, ...incoming])];
}

// ----------------------------
// FETCH CANDLES
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
// SWING LOWS
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
// LAST HIGHER LOW
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
// BEARISH FLIP
// ----------------------------
function isBearishFlip(candles) {
  const lows = findSwingLows(candles);
  const lastHL = getLastHigherLow(lows);

  if (!lastHL) return false;

  const currentPrice = candles[candles.length - 1].close;

  return currentPrice < lastHL.price;
}

// ----------------------------
// DISCOVERY LOOP
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
// MONITOR LOOP
// ----------------------------
async function monitorLoop() {
  const pairs = readPairs();
  let flipFilePairs = readFlipPairs();

  for (const symbol of pairs) {
    const candles = await fetchCandles(symbol);
    if (!candles.length) continue;

    const flipped = isBearishFlip(candles);

    if (flipped && !flippedPairs.has(symbol)) {
      console.log(`🚨 BEARISH FLIP: ${symbol}`);

      flippedPairs.add(symbol);

      // ✅ SAVE TO flip.txt (no duplicates)
      flipFilePairs = mergePairs(flipFilePairs, [symbol]);
      saveFlipPairs(flipFilePairs);

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

  await loadPerpSymbols();

  await discoveryLoop();
  await monitorLoop();

  setInterval(discoveryLoop, DISCOVERY_INTERVAL);
  setInterval(monitorLoop, MONITOR_INTERVAL);
}

main();
