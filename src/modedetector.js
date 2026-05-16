// btc-master-switch.js
// npm install axios
// Run: node btc-master-switch.js
//
// Detects which scanner to run:
// PUMP MODE
// DUMP MODE
// BOTH SELECTIVELY
// STAY OUT

import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";

const LOOP_MS = 30_000;

// Timeframes
const TF_FAST = "15m";
const TF_MAIN = "1h";
const TF_HTF = "4h";

// Lookbacks
const LB_FAST = 80;
const LB_MAIN = 120;
const LB_HTF = 120;

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

function sma(arr, len) {
  if (arr.length < len) return null;
  return avg(arr.slice(-len));
}

function recentHigh(arr, bars = 20) {
  return Math.max(...arr.slice(-bars - 1, -1));
}

function recentLow(arr, bars = 20) {
  return Math.min(...arr.slice(-bars - 1, -1));
}

// -----------------------------
// FETCHERS
// -----------------------------
async function getKlines(symbol, interval, limit) {
  const { data } = await api.get("/fapi/v1/klines", {
    params: { symbol, interval, limit },
  });
  return data;
}

async function getBreadth() {
  try {
    const { data } = await api.get("/fapi/v1/ticker/24hr");

    const pairs = data.filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("_") &&
        Number(x.quoteVolume) > 10_000_000
    );

    const green = pairs.filter(
      (x) => Number(x.priceChangePercent) > 1
    ).length;

    const red = pairs.filter(
      (x) => Number(x.priceChangePercent) < -1
    ).length;

    return { green, red, total: pairs.length };
  } catch {
    return { green: 0, red: 0, total: 0 };
  }
}

// -----------------------------
// ANALYZE BTC
// -----------------------------
async function analyzeBTC() {
  const [k15, k1h, k4h, breadth] = await Promise.all([
    getKlines(SYMBOL, TF_FAST, LB_FAST),
    getKlines(SYMBOL, TF_MAIN, LB_MAIN),
    getKlines(SYMBOL, TF_HTF, LB_HTF),
    getBreadth(),
  ]);

  // 15m
  const c15 = k15.map((x) => num(x[4]));
  const h15 = k15.map((x) => num(x[2]));
  const l15 = k15.map((x) => num(x[3]));

  // 1h
  const c1 = k1h.map((x) => num(x[4]));
  const h1 = k1h.map((x) => num(x[2]));
  const l1 = k1h.map((x) => num(x[3]));

  // 4h
  const c4 = k4h.map((x) => num(x[4]));

  const price = c15.at(-1);

  // --------------------------------
  // Trend Structure
  // --------------------------------
  const sma20_1h = sma(c1, 20);
  const sma50_1h = sma(c1, 50);

  const sma20_4h = sma(c4, 20);
  const sma50_4h = sma(c4, 50);

  const above1hTrend = price > sma20_1h && sma20_1h > sma50_1h;
  const below1hTrend = price < sma20_1h && sma20_1h < sma50_1h;

  const above4hTrend = price > sma20_4h && sma20_4h > sma50_4h;
  const below4hTrend = price < sma20_4h && sma20_4h < sma50_4h;

  // --------------------------------
  // Momentum
  // --------------------------------
  const move15 = pct(c15.at(-1), c15.at(-2));
  const move1h = pct(c1.at(-1), c1.at(-2));
  const move4h = pct(c4.at(-1), c4.at(-2));

  // --------------------------------
  // Breakout / Breakdown
  // --------------------------------
  const rHigh15 = recentHigh(h15, 20);
  const rLow15 = recentLow(l15, 20);

  const breakout = price > rHigh15;
  const breakdown = price < rLow15;

  // --------------------------------
  // Candle Structure
  // --------------------------------
  const hh =
    h1.at(-3) < h1.at(-2) &&
    h1.at(-2) < h1.at(-1);

  const ll =
    l1.at(-3) > l1.at(-2) &&
    l1.at(-2) > l1.at(-1);

  // --------------------------------
  // Breadth
  // --------------------------------
  const breadthBull =
    breadth.green > breadth.red * 1.3 &&
    breadth.green > 20;

  const breadthBear =
    breadth.red > breadth.green * 1.3 &&
    breadth.red > 20;

  // --------------------------------
  // Volatility Chop Detection
  // --------------------------------
  const last10Range = avg(
    h15.slice(-10).map((h, i) =>
      pct(h, l15.slice(-10)[i])
    )
  );

  const tinyMove =
    Math.abs(move15) < 0.15 &&
    Math.abs(move1h) < 0.25;

  const violentWhipsaw =
    last10Range > 1.5 &&
    Math.abs(move15) < 0.2;

  // --------------------------------
  // SCORE SYSTEM
  // --------------------------------
  let bull = 0;
  let bear = 0;
  let reasons = [];

  // Bull
  if (above1hTrend) {
    bull += 2;
    reasons.push("Above 1H trend");
  }

  if (above4hTrend) {
    bull += 3;
    reasons.push("Above 4H trend");
  }

  if (move15 > 0.25) {
    bull += 1;
    reasons.push("Positive intraday momentum");
  }

  if (move1h > 0.4) {
    bull += 2;
    reasons.push("Strong 1H momentum");
  }

  if (breakout) {
    bull += 2;
    reasons.push("Fresh breakout");
  }

  if (hh) {
    bull += 1;
    reasons.push("Higher highs");
  }

  if (breadthBull) {
    bull += 2;
    reasons.push("Bullish market breadth");
  }

  // Bear
  if (below1hTrend) {
    bear += 2;
    reasons.push("Below 1H trend");
  }

  if (below4hTrend) {
    bear += 3;
    reasons.push("Below 4H trend");
  }

  if (move15 < -0.25) {
    bear += 1;
    reasons.push("Negative intraday momentum");
  }

  if (move1h < -0.4) {
    bear += 2;
    reasons.push("Strong 1H weakness");
  }

  if (breakdown) {
    bear += 2;
    reasons.push("Fresh breakdown");
  }

  if (ll) {
    bear += 1;
    reasons.push("Lower lows");
  }

  if (breadthBear) {
    bear += 2;
    reasons.push("Bearish market breadth");
  }

  // --------------------------------
  // Decide Mode
  // --------------------------------
  let mode = "STAY OUT";
  let confidence = 50;

  if (violentWhipsaw) {
    mode = "STAY OUT";
    confidence = 80;
    reasons.push("Violent whipsaw detected");
  } else if (bull >= 8 && bull >= bear + 3) {
    mode = "PUMP MODE";
    confidence = clamp(55 + bull * 4, 55, 96);
  } else if (bear >= 8 && bear >= bull + 3) {
    mode = "DUMP MODE";
    confidence = clamp(55 + bear * 4, 55, 96);
  } else if (bull >= 5 || bear >= 5) {
    mode = "BOTH SELECTIVELY";
    confidence = clamp(
      55 + Math.max(bull, bear) * 3,
      55,
      88
    );
  } else if (tinyMove) {
    mode = "STAY OUT";
    confidence = 78;
    reasons.push("Low volatility dead zone");
  }

  return {
    price,
    bull,
    bear,
    mode,
    confidence,
    move15: move15.toFixed(2),
    move1h: move1h.toFixed(2),
    move4h: move4h.toFixed(2),
    breadth,
    reasons,
  };
}

// -----------------------------
// DISPLAY
// -----------------------------
function printResult(r) {
  console.clear();

  console.log("=== BTC MASTER SWITCH ===");
  console.log("Symbol:", SYMBOL);
  console.log("Price:", r.price);
  console.log("");

  console.log("MODE:", r.mode);
  console.log("CONFIDENCE:", r.confidence + "%");
  console.log("");

  console.log("Bull Score:", r.bull);
  console.log("Bear Score:", r.bear);
  console.log("");

  console.log("15m:", r.move15 + "%");
  console.log("1h :", r.move1h + "%");
  console.log("4h :", r.move4h + "%");
  console.log("");

  console.log(
    "Breadth:",
    `Green ${r.breadth.green} | Red ${r.breadth.red}`
  );
  console.log("");

  console.log("Scanner Action:");

  if (r.mode === "PUMP MODE") {
    console.log("-> Run Pump Scanner");
    console.log("-> Dump Scanner OFF");
  } else if (r.mode === "DUMP MODE") {
    console.log("-> Run Dump Scanner");
    console.log("-> Pump Scanner OFF");
  } else if (r.mode === "BOTH SELECTIVELY") {
    console.log("-> Run Both");
    console.log("-> Raise score thresholds");
    console.log("-> Lower position size");
  } else {
    console.log("-> Preserve capital");
    console.log("-> Observe only");
  }

  console.log("");
  console.log("Reasons:");
  r.reasons.slice(0, 8).forEach((x) => console.log("-", x));

  console.log("");
  console.log(
    "Updated:",
    new Date().toLocaleString()
  );
}

// -----------------------------
// LOOP
// -----------------------------
async function run() {
  while (true) {
    try {
      const result = await analyzeBTC();
      printResult(result);
    } catch (err) {
      console.clear();
      console.log("Error:", err.message);
    }

    await sleep(LOOP_MS);
  }
}

run();
