// index.js
import fs from "fs";
import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const FILE_PATH = "./pairs.txt";

const TOP_LIMIT = 5;
const CANDLE_LIMIT = 50;
const DISCOVERY_INTERVAL = 10 * 60 * 1000; // 10 mins
const MONITOR_INTERVAL = 60 * 1000; // 1 min
const MIN_QUOTE_VOLUME = 10_000_000; // liquidity filter

// Timeframes to confirm flips
const TIMEFRAMES = ["15m", "1h", "4h"];
const CONFIRM_THRESHOLD = 2; // Minimum timeframes that must confirm

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

// ----------------------------
// LOAD USDT PERP SYMBOLS
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
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, TOP_LIMIT);
    return sorted.map(p => p.symbol);
  } catch (err) {
    console.error("❌ Fetch error:", err.message);
    return [];
  }
}

// ----------------------------
// MERGE PAIRS
// ----------------------------
function mergePairs(existing, incoming) {
  return [...new Set([...existing, ...incoming])];
}

// ----------------------------
// FETCH CANDLES
// ----------------------------
async function fetchCandles(symbol, interval) {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval, limit: CANDLE_LIMIT }
    });
    return res.data.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (err) {
    console.error(`❌ Candle error ${symbol} ${interval}:`, err.message);
    return [];
  }
}

// ----------------------------
// SWING LOWS / LAST HIGHER LOW
// ----------------------------
function findSwingLows(candles) {
  const lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low) {
      lows.push({ index: i, price: candles[i].low });
    }
  }
  return lows;
}

function getLastHigherLow(lows) {
  if (lows.length < 2) return null;
  for (let i = lows.length - 1; i > 0; i--) {
    if (lows[i].price > lows[i-1].price) return lows[i];
  }
  return null;
}

// ----------------------------
// ELITE BEARISH FLIP LOGIC
// ----------------------------
function isBearishFlip(candles) {
  if (candles.length < 10) return false;

  const lows = findSwingLows(candles);
  const lastHL = getLastHigherLow(lows);
  if (!lastHL) return false;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];

  // 1️⃣ Confirmed break (2 closes below HL)
  if (!(last.close < lastHL.price && prev.close < lastHL.price)) return false;

  // 2️⃣ Strong bearish candle
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (body / range < 0.6) return false;

  // 3️⃣ Volume spike
  const volLast = last.volume;
  const volAvg = candles.slice(-20, -1).reduce((sum,c) => sum+c.volume, 0)/19;
  if (volLast < volAvg * 1.3) return false;

  // 4️⃣ Optional: lower high formation
  const recentHigh = Math.max(...candles.slice(-5).map(c => c.high));
  const prevHigh = Math.max(...candles.slice(-10,-5).map(c => c.high));
  if (recentHigh >= prevHigh) return false;

  return true;
}

// ----------------------------
// MULTI-TIMEFRAME CONFIRMATION
// ----------------------------
async function multiTFFlip(symbol) {
  let confirmed = 0;
  for (const tf of TIMEFRAMES) {
    const candles = await fetchCandles(symbol, tf);
    if (!candles.length) continue;
    if (isBearishFlip(candles)) confirmed++;
  }
  return confirmed >= CONFIRM_THRESHOLD;
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
  for (const symbol of pairs) {
    const flipped = await multiTFFlip(symbol);

    if (flipped && !flippedPairs.has(symbol)) {
      console.log(`🚨 BEARISH FLIP CONFIRMED: ${symbol}`);
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

  await loadPerpSymbols(); // critical step
  await discoveryLoop();
  await monitorLoop();

  setInterval(discoveryLoop, DISCOVERY_INTERVAL);
  setInterval(monitorLoop, MONITOR_INTERVAL);
}

main();
