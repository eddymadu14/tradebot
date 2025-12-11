import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// ========================================
// CONFIGURATION
// ========================================
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h", ltf: "1h" }; // 1H for minor trend bias

// ATR architecture parameters
const ATR_SHORT = 20;           // ATR used for execution and stops
const ATR_LONG = 30;            // ATR used for compression detection
const ATR_PERIOD = 14;          // original ATR period kept for legacy calculations
const ENTRY_MULT = 2.0;         // Entry = open ± ENTRY_MULT * ATR_SHORT
const STOP_MULT = 0.5;          // Stop = STOP_MULT * ATR_SHORT
const TAKE_PROFIT_MULT = 3.0;   // optional: TP = ENTRY ± TAKE_PROFIT_MULT * ATR_SHORT

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
// ATR UTILITIES
// ========================================
function computeATRSeries(candles, period) {
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  if (closes.length < period + 1) return [];
  return ATR.calculate({ high: highs, low: lows, close: closes, period });
}

function detectATRCompression(candles) {
  // ATR_SHORT vs ATR_LONG compression detection (ATR(20) < ATR(30))
  const atrShort = computeATRSeries(candles, ATR_SHORT);
  const atrLong = computeATRSeries(candles, ATR_LONG);
  if (!atrShort.length || !atrLong.length) return { compressed: false, atrShort: null, atrLong: null };
  const lastShort = atrShort.slice(-1)[0];
  const lastLong = atrLong.slice(-1)[0];
  return {
    compressed: lastShort < lastLong,
    atrShort: lastShort,
    atrLong: lastLong
  };
}

// ========================================
// TREND DETECTION (kept largely intact, tightened)
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
// LTF BIAS DETECTION (1H)
// ========================================
function detectLTFBias(ltfCandles) {
  const closes = ltfCandles.map(c => c.c);
  if (closes.length < EMA_STACK[1]) return "invalid";
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const slope = ema20.slice(-1)[0] - ema20.slice(-2)[0];
  if (slope > 0) return "bull";
  if (slope < 0) return "bear";
  return "neutral";
}

// ========================================
// HYBRID SNIPER MODE: MICRO IMPULSE + STRUCTURE + ATR ARCHITECTURE
// ========================================
function detectHybridZone(intraday, polarity = "bear") {
  const highs = intraday.map(c => c.h);
  const lows = intraday.map(c => c.l);
  const closes = intraday.map(c => c.c);
  const opens = intraday.map(c => c.o);
  const vols = intraday.map(c => c.v);

  // ATR series: short used for execution/stop, long used for compression detection
  const atrShortSeries = computeATRSeries(intraday, ATR_SHORT);
  if (!atrShortSeries.length) return null;
  const lastATRshort = atrShortSeries.slice(-1)[0];

  // compression flag and atrLong
  const atrCmp = detectATRCompression(intraday);
  const isCompressed = !!atrCmp.compressed;

  // Walk backward for the impulse candle (same as original but with ATR gating)
  for (let i = intraday.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const volAvg = vols.slice(Math.max(0, i - ATR_PERIOD), i).reduce((a, b) => a + b, 0) / Math.max(1, ATR_PERIOD);
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;

    const bullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const bearish = closes[i] < opens[i] && closes[i] < closes[i - 1];

    // Strength measured in ATR units (more robust than raw body/ATR_PERIOD)
    const strength = lastATRshort ? (body / lastATRshort) : (body / Math.max(1, (closes[i] * 0.001)));

    // Only accept impulses that are meaningful relative to current volatility
    const minStrengthForContinuation = 1.4; // kept consistent with your earlier function
    const minStrengthForReversal = 2.5;

    if (polarity === "bull" && bullish && volStrong && strength >= 1.0) {
      // ATR-based entry and stop
      const entry = opens[i] + ENTRY_MULT * lastATRshort; // wait for breakout above open + multiple ATR
      const stop = entry - STOP_MULT * lastATRshort;
      const tp = entry + TAKE_PROFIT_MULT * lastATRshort;

      // zone sized around the impulse with ATR padding
      const zoneMin = Math.min(lows[i] - 0.25 * lastATRshort, stop);
      const zoneMax = Math.max(highs[i] + 0.25 * lastATRshort, entry + 0.1 * lastATRshort);
      const midpoint = (zoneMin + zoneMax) / 2;

      return {
        min: zoneMin,
        max: zoneMax,
        midpoint,
        originIndex: i,
        strength,
        type: "bull",
        atrShort: lastATRshort,
        atrLong: atrCmp.atrLong,
        isCompressed,
        entry,
        stop,
        tp
      };
    }

    if (polarity === "bear" && bearish && volStrong && strength >= 1.0) {
      const entry = opens[i] - ENTRY_MULT * lastATRshort; // wait for breakout below open - multiple ATR
      const stop = entry + STOP_MULT * lastATRshort;
      const tp = entry - TAKE_PROFIT_MULT * lastATRshort;

      const zoneMin = Math.min(lows[i] - 0.25 * lastATRshort, entry - 0.1 * lastATRshort);
      const zoneMax = Math.max(highs[i] + 0.25 * lastATRshort, stop);
      const midpoint = (zoneMin + zoneMax) / 2;

      return {
        min: zoneMin,
        max: zoneMax,
        midpoint,
        originIndex: i,
        strength,
        type: "bear",
        atrShort: lastATRshort,
        atrLong: atrCmp.atrLong,
        isCompressed,
        entry,
        stop,
        tp
      };
    }
  }
  return null;
}

// ========================================
// VALIDATE STRENGTH FOR REVERSAL VS CONTINUATION (now uses ATR-normalised strength)
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
// SAFE LEVERAGE ESTIMATOR (volatility normalized suggestion)
// ========================================
// This function returns a recommended MAX leverage based on volatility (ATR) and a target risk percent.
// It's a heuristic: you should adapt to account size, margin rules, and actual position-sizing code.
function estimateSafeLeverage(lastPrice, atrShort) {
  if (!atrShort || !lastPrice) return 1;
  // Stop distance (in price units) using STOP_MULT * ATR
  const stopDistance = STOP_MULT * atrShort;
  // risk per unit price movement relative to price
  const stopPct = stopDistance / lastPrice; // e.g. 0.01 = 1%
  const targetRiskPct = 0.02; // risk 2% of account per trade (configurable)
  // naive leverage estimate: how much notional you can hold such that a stop will cost ~ targetRiskPct of account
  // leverage ≈ targetRiskPct / stopPct. Bound it to sane range.
  let leverage = Math.floor(targetRiskPct / Math.max(stopPct, 0.0001));
  if (leverage < 1) leverage = 1;
  if (leverage > 50) leverage = 50; // cap as a safety
  return leverage;
}

// ========================================
// Helper: compute SL/TP bundles if not present elsewhere
// (You can replace this with your production computeSLTP if you have one)
// ========================================
function computeSLTP(zone, trend) {
  // If zone includes explicit entry/stop/tp (we created them using ATR) use them.
  if (zone && zone.entry && zone.stop) {
    const entry = zone.entry;
    const stop = zone.stop;
    const tp = zone.tp || (trend === "bull" ? (entry + TAKE_PROFIT_MULT * zone.atrShort) : (entry - TAKE_PROFIT_MULT * zone.atrShort));
    return { entry, stop, tp };
  }
  // fallback: create from zone midpoint and ATR if available
  const entryFallback = zone.midpoint;
  const stopFallback = zone.midpoint + (trend === "bull" ? -STOP_MULT * (zone.atrShort || ATR_PERIOD) : STOP_MULT * (zone.atrShort || ATR_PERIOD));
  const tpFallback = zone.midpoint + (trend === "bull" ? TAKE_PROFIT_MULT * (zone.atrShort || ATR_PERIOD) : -TAKE_PROFIT_MULT * (zone.atrShort || ATR_PERIOD));
  return { entry: entryFallback, stop: stopFallback, tp: tpFallback };
}

// ========================================
// Retest validation (kept simple, replace with your robust logic)
// ========================================
function validateRetest(intraday, zone, polarity = "bear") {
  // If last candle touched the zone, mark as retest true.
  const last = intraday[intraday.length - 1];
  if (!last || !zone) return false;
  if (polarity === "bull") {
    return last.l <= zone.max && last.c > zone.midpoint;
  } else {
    return last.h >= zone.min && last.c < zone.midpoint;
  }
}

// ========================================
// Messaging builder & helpers (placeholders — replace with your production versions)
// ========================================
function buildZoneMessage({ symbol, trend, zone, sltp, label, note, chopDetails, sniperWindow }) {
  const safeLeverage = estimateSafeLeverage(sltp.entry || zone.midpoint, zone.atrShort || zone.atrLong);
  return `CTWL-Pro HYBRID SNIPER — ${label}
Symbol: ${symbol}
Trend: ${trend}
Zone: ${zone.min.toFixed(2)} — ${zone.max.toFixed(2)} (mid ${zone.midpoint.toFixed(2)})
Entry: ${sltp.entry.toFixed(2)} | Stop: ${sltp.stop.toFixed(2)} | TP: ${sltp.tp.toFixed(2)}
ATR(short=${ATR_SHORT}): ${zone.atrShort ? zone.atrShort.toFixed(2) : "n/a"} | compressed: ${zone.isCompressed}
Strength(ATR units): ${zone.strength.toFixed(2)} ${note ? `| Note: ${note}` : ""}
Retest: ${zone.retest ? "yes" : "no"} | Sniper window: ${sniperWindow}
Suggested max leverage (heuristic): x${safeLeverage}
${chopDetails && chopDetails.isChop ? "Chop detected — increase caution." : ""}
`;
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram disabled] Message:", text);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
    });
  } catch (err) {
    console.warn("sendTelegramMessage failed:", err.message || err);
  }
}

// ========================================
// Placeholder computeChopDetails (replace with your implementation)
// ========================================
function computeChopDetails(candles) {
  // Minimal chop detector: measure ATR / close ratio, if small => chop
  const atr = computeATRSeries(candles, ATR_SHORT);
  if (!atr.length) return { isChop: false };
  const lastAtr = atr.slice(-1)[0];
  const lastClose = candles[candles.length - 1].c;
  const atrPct = lastAtr / lastClose;
  return { isChop: atrPct < 0.012 }; // chop if ATR < 1.2% of price (heuristic)
}

// ========================================
// Sniper window checker (kept as per original intention)
// ========================================
function isInSniperWindow(nowTs) {
  const d = new Date(nowTs);
  const utcHour = d.getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(utcHour);
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

    // Detect ATR compression on intraday for additional info
    const atrCompressionInfo = detectATRCompression(intraday);

    if (trend === "bull") zone = detectHybridZone(intraday, "bull");
    else if (trend === "bear") zone = detectHybridZone(intraday, "bear");

    if (!zone) { console.log("No fresh zone detected — waiting for impulse."); return; }

    // Validate strength vs LTF (keeps your prior thresholds)
    const strengthValid = isStrengthValid(zone.strength, trend, ltfBias);
    if (!strengthValid) zone.note = `⚠️ Strength insufficient for ${trend !== ltfBias ? "reversal" : "continuation"} (LTF: ${ltfBias})`;

    // Compression gating: if market is compressed (ATR short < ATR long) prefer breakout entries
    if (zone.isCompressed) {
      // compression means higher probability for breakout — no action needed,
      // but annotate zone so downstream position sizing can prefer smaller SL and higher leverage suggestion.
      zone.note = (zone.note ? zone.note + " | " : "") + "ATR compression detected — breakout higher-prob.";
    } else {
      zone.note = (zone.note ? zone.note + " | " : "") + "ATR expanding — higher chop & noise possible.";
    }

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
