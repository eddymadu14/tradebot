import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// ========================================
// CONFIGURATION
// ========================================
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h", ltf: "1h" }; // added 1h LTF
const ATR_PERIOD = 14;
const ATR_SHORT = 20;    // ATR used for execution/stop
const ATR_LONG = 30;     // ATR used for compression detection
const ENTRY_MULT = 2.0;
const STOP_MULT = 0.5;
const TAKE_PROFIT_MULT = 3.0;

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
// ATR UTILITIES & COMPRESSION
// ========================================
function computeATRSeries(candles, period) {
  if (!candles || candles.length < period + 1) return [];
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  try {
    return ATR.calculate({ high: highs, low: lows, close: closes, period });
  } catch (err) {
    return [];
  }
}

function detectATRCompressionFromSeries(atrSeriesShort, atrSeriesLong) {
  if (!atrSeriesShort.length || !atrSeriesLong.length) return { compressed: false, atrShort: null, atrLong: null, ratio: null };
  const lastShort = atrSeriesShort.slice(-1)[0];
  const lastLong = atrSeriesLong.slice(-1)[0];
  return { compressed: lastShort < lastLong, atrShort: lastShort, atrLong: lastLong, ratio: lastShort / lastLong };
}

// ========================================
// TREND DETECTION (kept intact)
// ========================================
function detectTrend(daily) {
  const closes = daily.map(c => c.c);
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
  if (!ema20 || ema20.length < 2) return "neutral";
  const slope = ema20.slice(-1)[0] - ema20.slice(-2)[0];
  if (slope > 0) return "bull";
  if (slope < 0) return "bear";
  return "neutral";
}

// ========================================
// HYBRID SNIPER MODE: MICRO IMPULSE + STRUCTURE + ATR GATING
// ========================================
function detectHybridZone(intraday, polarity = "bear") {
  const highs = intraday.map(c => c.h);
  const lows = intraday.map(c => c.l);
  const closes = intraday.map(c => c.c);
  const opens = intraday.map(c => c.o);
  const vols = intraday.map(c => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = computeATRSeries(intraday, ATR_PERIOD);
  const lastATR = atrArr.length ? atrArr.slice(-1)[0] : null;

  // ATR short/long for compression & gating
  const atrShortSeries = computeATRSeries(intraday, ATR_SHORT);
  const atrLongSeries = computeATRSeries(intraday, ATR_LONG);
  const atrCmp = detectATRCompressionFromSeries(atrShortSeries, atrLongSeries);
  const isCompressed = atrCmp.compressed;
  const lastATRshort = atrCmp.atrShort || lastATR || 0;

  // iterate backwards to find latest displacement candle
  for (let i = intraday.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const volAvg = vols.slice(Math.max(0, i - ATR_PERIOD), i).reduce((a, b) => a + b, 0) / Math.max(1, ATR_PERIOD);
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;

    const bullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const bearish = closes[i] < opens[i] && closes[i] < closes[i - 1];

    // Strength measured in ATR units (robust)
    const strength = lastATRshort ? (body / lastATRshort) : (body / Math.max(1, (closes[i] * 0.001)));

    // ATR impulse gating: require observable ATR expansion at the candle
    // compare candle ATR proxy vs previous
    const prevATR = atrShortSeries.length >= 2 ? atrShortSeries[atrShortSeries.length - 2] : lastATRshort;
    const atrStrength = prevATR && prevATR > 0 ? (lastATRshort / prevATR) : 1.0;

    // ignore weak impulses if ATR hasn't expanded meaningfully (prevents fakeouts)
    if (atrStrength < 1.01 && strength < 1.2) continue;

    // Zone construction uses ATR padding and ENTRY/STOP multipliers
    if (polarity === "bull" && bullish && body > 0 && volStrong && strength >= 1.0) {
      const entry = opens[i] + ENTRY_MULT * lastATRshort;
      const stop = entry - STOP_MULT * lastATRshort;
      const tp = entry + TAKE_PROFIT_MULT * lastATRshort;

      const zoneMin = Math.min(lows[i] - 0.25 * lastATRshort, stop);
      const zoneMax = Math.max(highs[i] + 0.25 * lastATRshort, entry + 0.1 * lastATRshort);
      const midpoint = (zoneMin + zoneMax) / 2;
      const zoneWidth = zoneMax - zoneMin;

      // zone width sanity: ignore zones that are ridiculously narrow or wide relative to ATR
      if (zoneWidth < 0.5 * lastATRshort || zoneWidth > 4 * lastATRshort) continue;

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

    if (polarity === "bear" && bearish && body > 0 && volStrong && strength >= 1.0) {
      const entry = opens[i] - ENTRY_MULT * lastATRshort;
      const stop = entry + STOP_MULT * lastATRshort;
      const tp = entry - TAKE_PROFIT_MULT * lastATRshort;

      const zoneMin = Math.min(lows[i] - 0.25 * lastATRshort, entry - 0.1 * lastATRshort);
      const zoneMax = Math.max(highs[i] + 0.25 * lastATRshort, stop);
      const midpoint = (zoneMin + zoneMax) / 2;
      const zoneWidth = zoneMax - zoneMin;

      if (zoneWidth < 0.5 * lastATRshort || zoneWidth > 4 * lastATRshort) continue;

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
// VALIDATE RETEST / REJECTION (kept intact)
// ========================================
function validateRetest(intraday, zone, polarity = "bear") {
  const lookback = 10;
  for (let i = intraday.length - 1; i >= Math.max(0, intraday.length - lookback); i--) {
    const candle = intraday[i];
    const touched = candle.h >= zone.min && candle.l <= zone.max;
    if (!touched) continue;

    if (polarity === "bear") {
      const upperWick = candle.h - Math.max(candle.o, candle.c);
      const rejected = upperWick > 0.4 * (candle.h - candle.l) && candle.c < candle.o;
      if (rejected) return { index: i, candle };
    } else {
      const lowerWick = Math.min(candle.o, candle.c) - candle.l;
      const rejected = lowerWick > 0.4 * (candle.h - candle.l) && candle.c > candle.o;
      if (rejected) return { index: i, candle };
    }
  }
  return null;
}

// ========================================
// SL/TP CALCULATION (ATR-safe)
// ========================================
function computeSLTP(zone, trend) {
  if (!zone) return null;

  // prefer explicit ATR-backed entries if present
  const atr = zone.atrShort || 0;
  const entry = typeof zone.entry === "number" ? zone.entry : zone.midpoint;
  // ATR-scaled SL: use STOP_MULT * atr but floor to small value if atr is zero
  const atrSL = atr ? (STOP_MULT * atr) : Math.max(1, Math.abs(entry * 0.005));
  const sl = trend === "bull" ? (entry - atrSL) : (entry + atrSL);
  const risk = Math.abs(entry - sl);

  return {
    sl,
    tp1: trend === "bull" ? (entry + risk) : (entry - risk),
    tp2: trend === "bull" ? (entry + 2 * risk) : (entry - 2 * risk),
    tp3: trend === "bull" ? (entry + 3 * risk) : (entry - 3 * risk),
    risk
  };
}

// ========================================
// CHOP DETECTION (kept intact)
// ========================================
function computeChopDetails(candles) {
  if (candles.length < 30) return { isChop: false, reason: "insufficient candles" };
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atrLast8 = atrArr.slice(-8);
  const atrAvg = atrLast8.reduce((a, b) => a + b, 0) / atrLast8.length;

  const last8 = candles.slice(-8);
  const bodySizes = last8.map(c => Math.abs(c.c - c.o));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  const condBodyVsAtr = (avgBody < 0.30 * atrAvg);

  const netMove = Math.abs(last8[last8.length - 1].c - last8[0].o);
  const condWeakMovement = (netMove < 0.20 * atrAvg * 8);

  let overlapCount = 0;
  for (let i = candles.length - 8; i < candles.length - 1; i++) {
    if (candles[i + 1].h <= candles[i].h && candles[i + 1].l >= candles[i].l) overlapCount++;
  }
  const condOverlap = overlapCount >= 4;

  const chopScore = [condBodyVsAtr, condWeakMovement, condOverlap].filter(Boolean).length;
  const isChop = chopScore >= 2;

  const window = candles.slice(-8);
  const highest = Math.max(...window.map(c => c.h));
  const lowest = Math.min(...window.map(c => c.l));
  const rangeWidth = highest - lowest;
  const deviation = atrAvg > 0 ? rangeWidth / atrAvg : null;

  return { isChop, chopScore, conditions: { condBodyVsAtr, condWeakMovement, condOverlap }, atrAvg, rangeWidth, deviation, highest, lowest };
}

// ========================================
// TIME FILTER
// ========================================
function isInSniperWindow(ts = Date.now()) {
  const hourUTC = new Date(ts).getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ========================================
// TELEGRAM NOTIFIER (kept robust)
// ========================================
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram disabled] Message:\n", text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };

  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!data.ok) throw new Error(JSON.stringify(data));
      return data;
    } catch (err) {
      console.warn(`[telegram] attempt ${i} failed: ${err.message}`);
      if (i < 3) await new Promise(r => setTimeout(r, 1000 * i));
      else console.error("[telegram] all attempts failed.");
    }
  }
}

// ========================================
// BUILD MESSAGE (kept intact, minor ATR additions)
// ========================================
function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : n.toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note, chopDetails, sniperWindow, ltfBias }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n*LTF Bias:* ${ltfBias}\n\n`;

  if (!zone) msg += "_No zone available_\n";
  else {
    msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
    msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
    if (zone.isCompressed) msg += `*ATR Compression:* YES (short ${zone.atrShort ? zone.atrShort.toFixed(4) : "n/a"} / long ${zone.atrLong ? zone.atrLong.toFixed(4) : "n/a"})\n`;
    if (zone.retest) msg += "*Retest observed:* yes\n";
    if (note) msg += `*Note:* ${note}\n`;
    if (sltp) msg += `\n*Entry:* ${fmt(sltp ? (zone.entry || sltp.sl) : zone.midpoint)}\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
  }

  msg += `\n*Sniper window:* ${sniperWindow ? "YES" : "NO (use discretion)"}\n`;
  if (chopDetails) {
    msg += `*Chop:* ${chopDetails.isChop ? "YES" : "NO"}  (score ${chopDetails.chopScore}/3)\n`;
    msg += `*Chop range:* ${fmt(chopDetails.lowest)} — ${fmt(chopDetails.highest)} (width ${fmt(chopDetails.rangeWidth)})\n`;
    msg += `*Deviation:* ${chopDetails.deviation ? chopDetails.deviation.toFixed(3) : "n/a"} ATR\n`;
    msg += `*Cond body<0.3ATR:* ${chopDetails.conditions.condBodyVsAtr ? "1" : "0"}  *Weak move:* ${chopDetails.conditions.condWeakMovement ? "1" : "0"}  *Overlap:* ${chopDetails.conditions.condOverlap ? "1" : "0"}\n`;
  }

  if (label) msg += `\n_${label}_\n`;
  msg += `\n_Source: CTWL-Pro (Hybrid Sniper Mode — ATR gated)_`;
  return msg;
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runBTCatr() {
  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);
    const ltf = await fetchCandles(SYMBOL, TIMEFRAMES.ltf, 200);

    // compute ATRs and attach to objects (helpful for debugging & downstream)
    daily.atr = computeATRSeries(daily, ATR_PERIOD);
    intraday.atr = computeATRSeries(intraday, ATR_PERIOD);

    const chopDetails = computeChopDetails(daily);

    const trendObj = detectTrend(daily);
    const trend = trendObj.trend;
    if (trend === "invalid") { console.log("Trend invalid:", trendObj.reason); return; }

    const ltfBias = detectLTFBias(ltf);

    const sniperWindow = isInSniperWindow(Date.now());
    let zone = null;

    // ATR compression info (intraday short vs long)
    const atrShortSeries = computeATRSeries(intraday, ATR_SHORT);
    const atrLongSeries = computeATRSeries(intraday, ATR_LONG);
    const atrCmp = detectATRCompressionFromSeries(atrShortSeries, atrLongSeries);

    if (trend === "bull") zone = detectHybridZone(intraday, "bull");
    else if (trend === "bear") zone = detectHybridZone(intraday, "bear");

    if (!zone) { console.log("No fresh zone detected — waiting for impulse."); return; }

    // Validate strength vs LTF
    const strengthValid = (typeof zone.strength === "number") ? ( (trend === ltfBias) ? zone.strength >= 1.4 : zone.strength >= 2.5 ) : true;
    if (!strengthValid) zone.note = `⚠️ Strength insufficient for ${trend !== ltfBias ? "reversal" : "continuation"} (LTF: ${ltfBias})`;

    // annotate compression state
    if (zone.isCompressed) {
      zone.note = (zone.note ? zone.note + " | " : "") + "ATR compression detected — breakout higher-prob.";
    } else {
      zone.note = (zone.note ? zone.note + " | " : "") + "ATR expanding — higher chop & noise possible.";
    }

    // compute SL/TP using ATR-safe helper
    const sltp = computeSLTP(zone, trend);

    // extra label rules: incorporate ATR safe window vs ema200
    const atrSafe = (zone.atrShort && trendObj.ema200) ? (zone.atrShort < trendObj.ema200 * 0.015) : true;

    let label = `${trend.toUpperCase()} ZONE — VALID`;
    if (!atrSafe) label += " — HIGH VOL (reduce risk)";

    if (chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (OUTSIDE SNIPER WINDOW)`;
    else if (chopDetails.isChop && sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (SNIPER WINDOW OPEN, CAUTION)`;
    else if (!chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — OUTSIDE SNIPER WINDOW (manual discretion)`;

    const retest = validateRetest(intraday, zone, trend === "bull" ? "bull" : "bear");
    if (retest) zone.retest = true;

    const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label, note: zone.note, chopDetails, sniperWindow, ltfBias });
    console.log("=== CTWL-Pro HYBRID SNIPER OUTPUT ===", label, zone, "LTF Bias:", ltfBias);
    await sendTelegramMessage(msg);

  } catch (err) {
    console.error("CTWL-Pro ERROR:", err.message || err);
    try { await sendTelegramMessage(`CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}`); } catch (e) {}
  }
}
