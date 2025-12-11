import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ========================================
// CONFIGURATION
// ========================================
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h", ltf: "1h" };
const ATR_PERIOD = 14;
const ATR_SHORT = 20;
const ATR_LONG = 30;
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

// ========================================
// SAFE FETCH
// ========================================
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

// ========================================
// FETCH OHLCV
// ========================================
async function fetchCandles(symbol, timeframe, limit = 200) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ========================================
// ATR UTILITIES
// ========================================
function computeATRSeries(candles, period) {
  if (!candles || candles.length < period + 1) return [];
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  try { return ATR.calculate({ high: highs, low: lows, close: closes, period }); }
  catch { return []; }
}

function detectATRCompressionFromSeries(atrShortSeries, atrLongSeries) {
  if (!atrShortSeries.length || !atrLongSeries.length) return { compressed: false, atrShort: null, atrLong: null, ratio: null };
  const lastShort = atrShortSeries.slice(-1)[0];
  const lastLong = atrLongSeries.slice(-1)[0];
  return { compressed: lastShort < lastLong, atrShort: lastShort, atrLong: lastLong, ratio: lastShort / lastLong };
}

// ========================================
// TREND DETECTION
// ========================================
function detectTrend(daily) {
  const closes = daily.map(c => c.c);
  if (closes.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough data" };
  const emaArr = {};
  EMA_STACK.forEach(p => { emaArr[p] = EMA.calculate({ period: p, values: closes }); });
  const lastClose = closes[closes.length - 1];

  const lastEMA = EMA_STACK.reduce((acc, p) => acc && lastClose > emaArr[p].slice(-1)[0], true);
  const lastEMA_bear = EMA_STACK.reduce((acc, p) => acc && lastClose < emaArr[p].slice(-1)[0], true);

  const last5 = closes.slice(-6);
  const hhhl = last5.every((c, i, arr) => i === 0 ? true : c > arr[i - 1]);
  const lllh = last5.every((c, i, arr) => i === 0 ? true : c < arr[i - 1]);

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
// LTF BIAS
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
// IMPULSE-ORIGIN ZONE DETECTION
// ========================================
function detectImpulseOriginZone(intraday, polarity = "bear") {
  const highs = intraday.map(c => c.h);
  const lows = intraday.map(c => c.l);
  const closes = intraday.map(c => c.c);
  const opens = intraday.map(c => c.o);
  const vols = intraday.map(c => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = computeATRSeries(intraday, ATR_PERIOD);
  const lastATR = atrArr.slice(-1)[0];

  const atrShortSeries = computeATRSeries(intraday, ATR_SHORT);
  const atrLongSeries = computeATRSeries(intraday, ATR_LONG);
  const atrCmp = detectATRCompressionFromSeries(atrShortSeries, atrLongSeries);
  const isCompressed = atrCmp.compressed;
  const lastATRshort = atrCmp.atrShort || lastATR || 0;

  for (let i = intraday.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const volAvg = vols.slice(Math.max(0, i - ATR_PERIOD), i).reduce((a, b) => a + b, 0) / Math.max(1, ATR_PERIOD);
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    const bullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const bearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const strength = lastATRshort ? (body / lastATRshort) : (body / Math.max(1, closes[i] * 0.001));

    const prevATR = atrShortSeries.length >= 2 ? atrShortSeries[atrShortSeries.length - 2] : lastATRshort;
    const atrStrength = prevATR && prevATR > 0 ? (lastATRshort / prevATR) : 1.0;
    if (atrStrength < 1.01 && strength < 1.2) continue;

    if ((polarity === "bull" && bullish) || (polarity === "bear" && bearish)) {
      if (!volStrong || strength < 1.0) continue;

      const entry = polarity === "bull" ? opens[i] + ENTRY_MULT * lastATRshort : opens[i] - ENTRY_MULT * lastATRshort;
      const stop = polarity === "bull" ? entry - STOP_MULT * lastATRshort : entry + STOP_MULT * lastATRshort;
      const tp = polarity === "bull" ? entry + TAKE_PROFIT_MULT * lastATRshort : entry - TAKE_PROFIT_MULT * lastATRshort;
      const zoneMin = Math.min(lows[i] - 0.25 * lastATRshort, stop, entry - 0.1 * lastATRshort);
      const zoneMax = Math.max(highs[i] + 0.25 * lastATRshort, stop, entry + 0.1 * lastATRshort);
      const midpoint = (zoneMin + zoneMax) / 2;
      const zoneWidth = zoneMax - zoneMin;

      if (zoneWidth < 0.5 * lastATRshort || zoneWidth > 4 * lastATRshort) continue;

      return {
        min: zoneMin, max: zoneMax, midpoint, originIndex: i,
        strength, type: polarity, atrShort: lastATRshort, atrLong: atrCmp.atrLong,
        isCompressed, entry, stop, tp
      };
    }
  }
  return null;
}

// ========================================
// RETEST VALIDATION
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
// SL/TP CALCULATION
// ========================================
function computeSLTP(zone, trend) {
  if (!zone) return null;
  const atr = zone.atrShort || 0;
  const entry = typeof zone.entry === "number" ? zone.entry : zone.midpoint;
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
// CHOP DETECTION
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
  const condBodyVsAtr = avgBody < 0.30 * atrAvg;

  const netMove = Math.abs(last8[last8.length - 1].c - last8[0].o);
  const condWeakMovement = netMove < 0.20 * atrAvg * 8;

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
// SNIPER WINDOW
// ========================================
function isInSniperWindow(ts = Date.now()) {
  const hourUTC = new Date(ts).getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ========================================
// TELEGRAM
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
// MESSAGE BUILD
// ========================================
function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : n.toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note, chopDetails, sniperWindow, ltfBias }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro v4.0 Hybrid Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n*LTF Bias:* ${ltfBias}\n\n`;
  if (!zone) msg += "_No zone available_\n";
  else {
    msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
    msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
    if (zone.isCompressed) msg += `*ATR Compression:* YES (short ${zone.atrShort ? zone.atrShort.toFixed(4) : "n/a"} / long ${zone.atrLong ? zone.atrLong.toFixed(4) : "n/a"})\n`;
    if (zone.retest) msg += "*Retest observed:* yes\n";
    if (note) msg += `*Note:* ${note}\n`;
    if (sltp) msg += `\n*Entry:* ${fmt(zone.entry || sltp.sl)}\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
  }
  msg += `\n*Sniper window:* ${sniperWindow ? "YES" : "NO (use discretion)"}\n`;
  if (chopDetails) {
    msg += `*Chop:* ${chopDetails.isChop ? "YES" : "NO"}  (score ${chopDetails.chopScore}/3)\n`;
    msg += `*Chop range:* ${fmt(chopDetails.lowest)} — ${fmt(chopDetails.highest)} (width ${fmt(chopDetails.rangeWidth)})\n`;
    msg += `*Deviation:* ${chopDetails.deviation ? chopDetails.deviation.toFixed(3) : "n/a"} ATR\n`;
    msg += `*Cond body<0.3ATR:* ${chopDetails.conditions.condBodyVsAtr ? "1" : "0"}  *Weak move:* ${chopDetails.conditions.condWeakMovement ? "1" : "0"}  *Overlap:* ${chopDetails.conditions.condOverlap ? "1" : "0"}\n`;
  }
  if (label) msg += `\n_${label}_\n`;
  return msg;
}

// ========================================
// RUN CTWL-PRO
// ========================================

export async function runBTCin(symbol = SYMBOL) {
  try {
    // --- Fetch candles ---
    const daily = await fetchCandles(symbol, TIMEFRAMES.daily);
    const intraday = await fetchCandles(symbol, TIMEFRAMES.intraday);
    const ltf = await fetchCandles(symbol, TIMEFRAMES.ltf);

    // --- Trend & LTF bias ---
    const trendData = detectTrend(daily);
    if (trendData.trend === "invalid") {
      console.warn(`[CTWL-Pro] Trend invalid: ${trendData.reason}`);
      return;
    }
    const ltfBias = detectLTFBias(ltf);

    // --- Chop Detection ---
    const chopDetails = computeChopDetails(intraday);

    // --- Sniper window check ---
    const sniperWindow = isInSniperWindow();

    // --- Impulse-Origin Zone Detection ---
    const zone = detectImpulseOriginZone(intraday, trendData.trend);

    if (!zone) {
      console.log(`[CTWL-Pro] No valid zone detected for ${symbol}`);
      return;
    }

    // --- Retest validation ---
    const retest = validateRetest(intraday, zone, trendData.trend);
    zone.retest = !!retest;

    // --- SL/TP Calculation ---
    const sltp = computeSLTP(zone, trendData.trend);

    // --- Build Telegram message ---
    const msg = buildZoneMessage({
      symbol,
      trend: trendData.trend,
      zone,
      sltp,
      label: "Hybrid Model A",
      note: chopDetails.isChop ? "Chop detected — higher noise" : null,
      chopDetails,
      sniperWindow,
      ltfBias
    });

    // --- Send Telegram alert ---
    await sendTelegramMessage(msg);

    console.log(`[CTWL-Pro] Alert sent for ${symbol}`);
  } catch (err) {
    console.error(`[CTWL-Pro] Error for ${symbol}: ${err.message}`);
  }
}

