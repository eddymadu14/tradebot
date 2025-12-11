import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// ========================================
// CONFIGURATION
// ========================================
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h", ltf: "1h" }; // Added 1H for minor trend bias
const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.5;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("Warning: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID should be set in .env to receive alerts.");
}

// ========================================
// EXCHANGE SETUP
// ========================================
const exchange = new ccxt.binance({
  apiKey: BINANCE_API_KEY || undefined,
  secret: BINANCE_SECRET || undefined,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "future" },
});

// --- SAFE FETCH WITH RETRY ---
async function safeFetch(exchangeInstance, method, ...args) {
  const maxRetries = 4;
  const baseDelay = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await method.apply(exchangeInstance, args);
    } catch (err) {
      console.warn(`[safeFetch] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(res => setTimeout(res, baseDelay * attempt));
    }
  }
}

// --- FETCH OHLCV CANDLES ---
async function fetchCandles(symbol, timeframe, limit = 200) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ========================================
// TREND DETECTION
// ========================================
function detectTrend(candles) {
  const closes = candles.map(c => c.c);
  if (closes.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough data" };

  const emaArr = {};
  EMA_STACK.forEach(p => { emaArr[p] = EMA.calculate({ period: p, values: closes }); });

  const lastClose = closes[closes.length - 1];
  const lastEMA = EMA_STACK.reduce((acc, p) => {
    const arr = emaArr[p];
    if (!arr || arr.length === 0) return false;
    return acc && lastClose > arr.slice(-1)[0];
  }, true);

  const lastEMA_bear = EMA_STACK.reduce((acc, p) => {
    const arr = emaArr[p];
    if (!arr || arr.length === 0) return false;
    return acc && lastClose < arr.slice(-1)[0];
  }, true);

  const last5 = closes.slice(-6);
  const hhhl = last5.every((c, i, arr) => (i === 0 ? true : c > arr[i - 1]));
  const lllh = last5.every((c, i, arr) => (i === 0 ? true : c < arr[i - 1]));

  const ema20 = emaArr[20];
  const slope20 = ema20.slice(-1)[0] - ema20.slice(-2)[0];
  const bullishMomentum = slope20 > 0;
  const bearishMomentum = slope20 < 0;

  const bullishLayers = [lastEMA, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers = [lastEMA_bear, lllh, bearishMomentum].filter(Boolean).length;

  if (bullishLayers >= 2) return { trend: "bull", ema200: emaArr[200].slice(-1)[0] };
  if (bearishLayers >= 2) return { trend: "bear", ema200: emaArr[200].slice(-1)[0] };

  return { trend: "invalid", reason: "Layers not aligned" };
}

// ========================================
// LTF BIAS DETECTION
// ========================================
function detectLTFBias(ltfCandles) {
  // Using same EMA + slope logic as HTF but for 1H
  const closes = ltfCandles.map(c => c.c);
  if (closes.length < EMA_STACK[1]) return "invalid";

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const slope = ema20.slice(-1)[0] - ema20.slice(-2)[0];

  if (slope > 0) return "bull";
  if (slope < 0) return "bear";
  return "neutral";
}

// ========================================
// HYBRID SNIPER MODE: MICRO IMPULSE + STRUCTURE + OB
// ========================================
function detectHybridZone(intraday, polarity = "bear") {
  const highs = intraday.map(c => c.h);
  const lows = intraday.map(c => c.l);
  const closes = intraday.map(c => c.c);
  const opens = intraday.map(c => c.o);
  const vols = intraday.map(c => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const lastATR = atrArr.slice(-1)[0];

  for (let i = intraday.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const volAvg = vols.slice(Math.max(0, i - ATR_PERIOD), i).reduce((a, b) => a + b, 0) / Math.max(1, ATR_PERIOD);
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;

    const bullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const bearish = closes[i] < opens[i] && closes[i] < closes[i - 1];

    if (polarity === "bull" && bullish && body > lastATR && volStrong) {
      const zoneMin = lows[i] - 0.25 * lastATR;
      const zoneMax = highs[i] + 0.1 * lastATR;
      const midpoint = (zoneMin + zoneMax) / 2;
      return { min: zoneMin, max: zoneMax, midpoint, originIndex: i, strength: body / lastATR, type: "bull" };
    }

    if (polarity === "bear" && bearish && body > lastATR && volStrong) {
      const zoneMin = lows[i] - 0.1 * lastATR;
      const zoneMax = highs[i] + 0.25 * lastATR;
      const midpoint = (zoneMin + zoneMax) / 2;
      return { min: zoneMin, max: zoneMax, midpoint, originIndex: i, strength: body / lastATR, type: "bear" };
    }
  }
  return null;
}

// ========================================
// VALIDATE STRENGTH FOR REVERSAL VS CONTINUATION
// ========================================
function isStrengthValid(strength, trendDirection, ltfBias) {
  if (trendDirection === ltfBias) {
    // trend continuation
    return strength >= 1.4;
  } else {
    // trend reversal
    return strength >= 2.5;
  }
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runBTCltf() {
  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);
    const ltf = await fetchCandles(SYMBOL, TIMEFRAMES.ltf, 200); // added LTF

    const chopDetails = computeChopDetails(daily);
    const trendObj = detectTrend(daily);
    const trend = trendObj.trend;
    if (trend === "invalid") { console.log("Trend invalid:", trendObj.reason); return; }

    const ltfBias = detectLTFBias(ltf);

    const sniperWindow = isInSniperWindow(Date.now());
    let zone = null;

    if (trend === "bull") zone = detectHybridZone(intraday, "bull");
    else if (trend === "bear") zone = detectHybridZone(intraday, "bear");

    if (!zone) { console.log("No fresh zone detected — waiting for impulse."); return; }

    // Validate strength vs LTF
    const strengthValid = isStrengthValid(zone.strength, trend, ltfBias);
    if (!strengthValid) zone.note = `⚠️ Strength insufficient for ${trend !== ltfBias ? "reversal" : "continuation"} (LTF: ${ltfBias})`;

    const sltp = computeSLTP(zone, trend);
    let label = `${trend.toUpperCase()} ZONE — VALID`;

    if (chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (OUTSIDE SNIPER WINDOW)`;
    else if (chopDetails.isChop && sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (SNIPER WINDOW OPEN, CAUTION)`;
    else if (!chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — OUTSIDE SNIPER WINDOW (manual discretion)`;

    const retest = validateRetest(intraday, zone, trend === "bull" ? "bull" : "bear");
    if (retest) zone.retest = true;

    const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label, note: zone.note, chopDetails, sniperWindow });
    console.log("=== CTWL-Pro HYBRID SNIPER OUTPUT ===", label, zone, "LTF Bias:", ltfBias);
    await sendTelegramMessage(msg);

  } catch (err) {
    console.error("CTWL-Pro ERROR:", err.message || err);
    try { await sendTelegramMessage(`CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}`); } catch (e) {}
  }
}
