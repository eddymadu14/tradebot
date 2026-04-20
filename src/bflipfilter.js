// entryFilter.js
import fs from "fs";
import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const FILE_PATH = "./flip.txt";

const LTF = "15m";
const HTF = "4h";
const LIMIT = 80;

// ----------------------------
// READ PAIRS
// ----------------------------
function readPairs() {
  if (!fs.existsSync(FILE_PATH)) return [];
  return fs.readFileSync(FILE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean);
}

// ----------------------------
// FETCH CANDLES
// ----------------------------
async function fetchCandles(symbol, interval) {
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval, limit: LIMIT }
    });

    return res.data.map(c => ({
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5]
    }));

  } catch (err) {
    console.error(`❌ ${symbol} ${interval}`, err.message);
    return [];
  }
}

// ----------------------------
// SWING LOWS / HL
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

function getLastHL(lows) {
  if (lows.length < 2) return null;

  for (let i = lows.length - 1; i > 0; i--) {
    if (lows[i].price > lows[i - 1].price) return lows[i];
  }

  return null;
}

// ----------------------------
// HTF BIAS (MUST BE BEARISH)
// ----------------------------
function isHTFBearish(candles) {
  const last = candles[candles.length - 1].close;
  const prev = candles[candles.length - 10].close;

  return last < prev; // simple downward bias
}

// ----------------------------
// ENTRY FILTER LOGIC
// ----------------------------
function isValidEntry(candles) {
  const lows = findSwingLows(candles);
  const hl = getLastHL(lows);
  if (!hl) return false;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // ------------------------
  // 1. RETEST (price returns near HL)
  // ------------------------
  const tolerance = hl.price * 0.002;

  const retest =
    candles.slice(-5).some(c =>
      c.high >= hl.price - tolerance &&
      c.high <= hl.price + tolerance
    );

  if (!retest) return false;

  // ------------------------
  // 2. REJECTION
  // ------------------------
  if (!(last.close < hl.price && last.open > last.close)) return false;

  // ------------------------
  // 3. LOWER HIGH
  // ------------------------
  const recentHigh = Math.max(...candles.slice(-5).map(c => c.high));
  const prevHigh = Math.max(...candles.slice(-10, -5).map(c => c.high));

  if (recentHigh >= prevHigh) return false;

  // ------------------------
  // 4. MOMENTUM (strong bearish candle)
  // ------------------------
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (body / range < 0.6) return false;

  // ------------------------
  // 5. VOLUME LOGIC
  // ------------------------
  const volLast = last.volume;

  const volAvg = candles
    .slice(-20, -1)
    .reduce((a, b) => a + b.volume, 0) / 19;

  if (volLast < volAvg * 1.2) return false;

  return true;
}

// ----------------------------
// MAIN FILTER LOOP
// ----------------------------
async function run() {
  console.log("\n🎯 Running Entry Filter...");

  const pairs = readPairs();

  for (const symbol of pairs) {

    const ltf = await fetchCandles(symbol, LTF);
    const htf = await fetchCandles(symbol, HTF);

    if (!ltf.length || !htf.length) continue;

    const htfBearish = isHTFBearish(htf);
    if (!htfBearish) {
      console.log(`⛔ ${symbol} HTF not bearish`);
      continue;
    }

    const valid = isValidEntry(ltf);

    if (valid) {
      console.log(`🎯 VALID SETUP: ${symbol}`);
    } else {
      console.log(`❌ ${symbol} no entry`);
    }
  }
}

run();
