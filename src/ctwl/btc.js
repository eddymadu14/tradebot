/**
 * CTWL-1H PRO — Directional Predictive Engine (BTC)
 * -------------------------------------------------
 * CTWL conservative HTF integration
 * ONE file, ONE async call
 */

import fetch from "node-fetch";

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";

// ======================
// TELEGRAM CONFIG
// ======================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

// ======================
// FETCH CANDLES
// ======================
async function fetchCandles(symbol, interval, limit) {
  const url = `${BINANCE_BASE}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error ${res.status}`);
  const data = await res.json();
  return data.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
    timestamp: c[0]
  })).filter(c => c.open && c.high && c.low && c.close);
}

// ======================
// MAIN
// ======================
export async function runCTWL1H_PREDICT(symbol = "BTCUSDT") {
  const [c5m, c15m, c1h, c4h] = await Promise.all([
    fetchCandles(symbol, "5m", 120),
    fetchCandles(symbol, "15m", 120),
    fetchCandles(symbol, "1h", 150),
    fetchCandles(symbol, "4h", 80)
  ]);

  if (c5m.length < 50 || c15m.length < 50 || c1h.length < 100 || c4h.length < 50)
    return noTrade("INSUFFICIENT_DATA");

  const htf = analyzeHTF(c4h);
  const ltf1h = analyzeTrend(c1h);
  const ltf15m = analyzeTrend(c15m);
  const flip = detectExecutionFlip(c5m);
  const volatility = volatilityGate(c1h);

  const direction = flip.flipped ? flip.direction : htf.trend;
  if (direction === "RANGE") return noTrade("NO_CLEAR_DIRECTION");

  const zone = buildEntryZone(c5m, direction);
  if (!zone) return noTrade("ZONE_INVALID");

  const currentPrice = c1h.at(-1).close;
  if (
    (direction === "BULL" && currentPrice < zone.invalidation) ||
    (direction === "BEAR" && currentPrice > zone.invalidation)
  ) {
    return noTrade("PRICE_PAST_INVALID_BOUNDARY");
  }

  const probability = computeProbability({
    htf,
    ltf1h,
    ltf15m,
    flip,
    volatility,
    direction,
    currentPrice,
    zone
  });

  // ======================
  // HARD TELEGRAM GATE
  // ======================
  if (probability < 65) {
    return noTrade("PROBABILITY_TOO_LOW");
  }

  const result = {
    permission: "TRADE",
    symbol,
    timeframe: "1H",
    direction,
    valid_boundary: zone.entry,
    invalid_boundary: zone.invalidation,
    probability,
    context: {
      htf: htf.trend,
      ltf1h,
      ltf15m,
      volatility: volatility.state
    },
    timestamp: Date.now()
  };

  await sendToTelegram(formatTelegramMessage(result));

  return result;
}

// ======================
// HTF — CTWL Conservative Logic
// ======================
function analyzeHTF(candles) {
  if (candles.length < 50) return { trend: "RANGE" };

  const closes = candles.map(c => c.close);

  const EMA = (period) => {
    if (closes.length < period) return [];
    let k = 2 / (period + 1);
    const emaArr = [closes.slice(0, period).reduce((a, b) => a + b) / period];
    for (let i = period; i < closes.length; i++) {
      emaArr.push(closes[i] * k + emaArr.at(-1) * (1 - k));
    }
    return emaArr;
  };

  const ema20 = EMA(20).slice(-1)[0];
  const ema50 = EMA(50).slice(-1)[0];
  const ema100 = EMA(100).slice(-1)[0];
  const ema200 = EMA(200).slice(-1)[0];
  const lastClose = closes.at(-1);

  const slope20 = EMA(20).slice(-1)[0] - EMA(20).slice(-2)[0] || 0;

  const last5 = closes.slice(-6);
  const hhhl = last5.every((c, i, a) => (i === 0 ? true : c > a[i - 1]));
  const lllh = last5.every((c, i, a) => (i === 0 ? true : c < a[i - 1]));

  const bullishLayers = [
    lastClose > ema20 && lastClose > ema50 && lastClose > ema100 && lastClose > ema200,
    hhhl,
    slope20 > 0
  ].filter(Boolean).length;

  const bearishLayers = [
    lastClose < ema20 && lastClose < ema50 && lastClose < ema100 && lastClose < ema200,
    lllh,
    slope20 < 0
  ].filter(Boolean).length;

  if (bullishLayers >= 2) return { trend: "BULL" };
  if (bearishLayers >= 2) return { trend: "BEAR" };
  return { trend: "RANGE" };
}

// ======================
// LTF TREND
// ======================
function analyzeTrend(candles) {
  if (candles.length < 2) return "RANGE";
  const a = candles.at(-1), b = candles.at(-2);
  if (a.close > b.close) return "BULL";
  if (a.close < b.close) return "BEAR";
  return "RANGE";
}

// ======================
// EXECUTION FLIP
// ======================
function detectExecutionFlip(candles) {
  if (candles.length < 2) return { flipped: false, direction: null };
  const a = candles.at(-1), b = candles.at(-2);
  if (a.close > b.high && a.low > b.low) return { flipped: true, direction: "BULL" };
  if (a.close < b.low && a.high < b.high) return { flipped: true, direction: "BEAR" };
  return { flipped: false, direction: null };
}

// ======================
// VOLATILITY
// ======================
function volatilityGate(candles) {
  if (candles.length < 50) return { expand: false, state: "COMPRESSED" };
  const fast = ATR(candles.slice(-14));
  const slow = ATR(candles.slice(-50));
  const expand = fast > slow * 1.1;
  return { expand, state: expand ? "EXPANDING" : "COMPRESSED" };
}

// ======================
// ENTRY ZONE
// ======================
function buildEntryZone(candles, direction) {
  const c = candles.at(-1);
  if (direction === "BULL") return { entry: (c.low + c.close) / 2, invalidation: c.low };
  if (direction === "BEAR") return { entry: (c.high + c.close) / 2, invalidation: c.high };
  return null;
}

// ======================
// PROBABILITY
// ======================
function computeProbability({ htf, ltf1h, ltf15m, flip, volatility, direction, currentPrice, zone }) {
  if (
    (direction === "BULL" && currentPrice < zone.invalidation) ||
    (direction === "BEAR" && currentPrice > zone.invalidation)
  ) return 0;

  let score = 0;
  if (htf.trend === direction) score += 40;
  if (ltf1h === direction) score += 20;
  if (ltf15m === direction) score += 15;
  if (flip.flipped && flip.direction === direction) score += 15;
  if (volatility.expand) score += 10;

  return Math.min(score, 100);
}

// ======================
// ATR
// ======================
function ATR(candles) {
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i], b = candles[i - 1];
    sum += Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close));
  }
  return sum / (candles.length - 1);
}

// ======================
// TELEGRAM
// ======================
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(TELEGRAM_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
}

function formatTelegramMessage(r) {
  return `
🚨 *CTWL-1H TRADE ALERT*
*Symbol:* ${r.symbol}
*Direction:* ${r.direction}
*Probability:* ${r.probability}%

*Entry:* ${r.valid_boundary.toFixed(2)}
*Invalidation:* ${r.invalid_boundary.toFixed(2)}

*HTF:* ${r.context.htf}
*LTF 1H:* ${r.context.ltf1h}
*LTF 15M:* ${r.context.ltf15m}
*Volatility:* ${r.context.volatility}
  `;
}

// ======================
// UTIL
// ======================
function noTrade(reason) {
  return { permission: "NO_TRADE", reason, timestamp: Date.now() };
}

// ======================
// AUTO RUN
// ======================
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const res = await runCTWL1H_PREDICT("BTCUSDT");
    console.log("CTWL RESULT ↓↓↓");
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("CTWL ERROR:", err.message);
  }
}
