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
  console.warn("⚠ Telegram not configured — alerts will log only");
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
      console.warn(`[safeFetch] attempt ${attempt}: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelay * attempt));
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
  return ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period
  });
}

function detectATRCompressionFromSeries(shortArr, longArr) {
  if (!shortArr.length || !longArr.length) return { compressed: false };
  const s = shortArr.at(-1);
  const l = longArr.at(-1);
  return { compressed: s < l, atrShort: s, atrLong: l };
}

// ========================================
// TREND DETECTION
// ========================================
function detectTrend(daily) {
  const closes = daily.map(c => c.c);
  const ema = {};
  EMA_STACK.forEach(p => ema[p] = EMA.calculate({ period: p, values: closes }));

  const last = closes.at(-1);
  const bull = EMA_STACK.every(p => last > ema[p].at(-1));
  const bear = EMA_STACK.every(p => last < ema[p].at(-1));

  if (bull) return { trend: "bull" };
  if (bear) return { trend: "bear" };
  return { trend: "invalid", reason: "EMA conflict" };
}

// ========================================
// LTF BIAS
// ========================================
function detectLTFBias(ltf) {
  const closes = ltf.map(c => c.c);
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const slope = ema20.at(-1) - ema20.at(-2);
  if (slope > 0) return "bull";
  if (slope < 0) return "bear";
  return "neutral";
}

// ========================================
// IMPULSE ZONE (UNCHANGED CORE LOGIC)
// ========================================
function detectImpulseOriginZone(intraday, polarity) {
  const atrShort = computeATRSeries(intraday, ATR_SHORT);
  const atrLong = computeATRSeries(intraday, ATR_LONG);
  const atrCmp = detectATRCompressionFromSeries(atrShort, atrLong);
  const atr = atrShort.at(-1);

  for (let i = intraday.length - 2; i >= 1; i--) {
    const c = intraday[i];
    const body = Math.abs(c.c - c.o);
    const impulse = body / atr;
    if (impulse < 1) continue;

    const zoneMin = c.l - 0.25 * atr;
    const zoneMax = c.h + 0.25 * atr;

    return {
      min: zoneMin,
      max: zoneMax,
      midpoint: (zoneMin + zoneMax) / 2,
      latentStrength: impulse,   // 🔴 latent only
      atrShort: atrCmp.atrShort,
      atrLong: atrCmp.atrLong,
      isCompressed: atrCmp.compressed,
      entry: polarity === "bull"
        ? c.o + ENTRY_MULT * atr
        : c.o - ENTRY_MULT * atr
    };
  }
  return null;
}

// ========================================
// RETEST VALIDATION
// ========================================
function validateRetest(intraday, zone, polarity) {
  for (let i = intraday.length - 10; i < intraday.length; i++) {
    const c = intraday[i];
    if (c.h >= zone.min && c.l <= zone.max) {
      if (polarity === "bear" && c.c < c.o) return true;
      if (polarity === "bull" && c.c > c.o) return true;
    }
  }
  return false;
}

// ========================================
// CHOP DETECTION
// ========================================
function computeChopDetails(candles) {
  if (candles.length < 30) return { isChop: false };
  const atr = ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period: ATR_PERIOD
  });
  const avgATR = atr.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const range =
    Math.max(...candles.slice(-8).map(c => c.h)) -
    Math.min(...candles.slice(-8).map(c => c.l));
  return { isChop: range < 2 * avgATR };
}

// ========================================
// 🧠 ACTIVE STRENGTH (NEW — additive)
// ========================================
function computeActiveStrength({ zone, trend, ltfBias, chopDetails, sniperWindow }) {
  let s = Math.min(zone.latentStrength, 1.5);
  if (ltfBias !== "neutral" && ltfBias !== trend) s -= 0.7;
  if (zone.retest && ltfBias === trend) s += 0.4;
  if (zone.isCompressed && ltfBias === trend) s += 0.3;
  if (chopDetails?.isChop) s -= 0.6;
  if (!sniperWindow) s = Math.min(s, 1.2);
  return Math.max(0, s);
}

// ========================================
// 🔒 PERMISSION GATE (NEW)
// ========================================
function computePermission({ trend, ltfBias, sniperWindow, chopDetails }) {
  if (ltfBias !== trend) return "WAIT_LTF_ALIGNMENT";
  if (chopDetails?.isChop) return "WAIT_CHOP_RESOLUTION";
  if (!sniperWindow) return "SNIPER_ONLY";
  return "TRADE";
}

// ========================================
// SL / TP
// ========================================
function computeSLTP(zone, trend) {
  const atr = zone.atrShort;
  const entry = zone.entry;
  const sl = trend === "bull"
    ? entry - atr * STOP_MULT
    : entry + atr * STOP_MULT;
  const risk = Math.abs(entry - sl);
  return {
    sl,
    tp1: trend === "bull" ? entry + risk : entry - risk,
    tp2: trend === "bull" ? entry + 2 * risk : entry - 2 * risk,
    tp3: trend === "bull" ? entry + 3 * risk : entry - 3 * risk,
    risk
  };
}

// ========================================
// TELEGRAM
// ========================================
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram disabled]\n", text);
    return;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
  });
}

// ========================================
// RUN ENGINE
// ========================================
export async function runBTCmod(symbol = SYMBOL) {
  const daily = await fetchCandles(symbol, TIMEFRAMES.daily);
  const intraday = await fetchCandles(symbol, TIMEFRAMES.intraday);
  const ltf = await fetchCandles(symbol, TIMEFRAMES.ltf);

  const trendData = detectTrend(daily);
  if (trendData.trend === "invalid") return;

  const ltfBias = detectLTFBias(ltf);
  const chopDetails = computeChopDetails(intraday);
  const sniperWindow = ENTRY_WINDOWS_UTC.includes(new Date().getUTCHours());

  const zone = detectImpulseOriginZone(intraday, trendData.trend);
  if (!zone) return;

  zone.retest = validateRetest(intraday, zone, trendData.trend);

  zone.strength = computeActiveStrength({
    zone,
    trend: trendData.trend,
    ltfBias,
    chopDetails,
    sniperWindow
  });

  const permission = computePermission({
    trend: trendData.trend,
    ltfBias,
    sniperWindow,
    chopDetails
  });

  const sltp =
    permission === "TRADE" || permission === "SNIPER_ONLY"
      ? computeSLTP(zone, trendData.trend)
      : null;

  const msg = `
*CTWL-Pro v4.0 Hybrid Alert*

*Symbol:* ${symbol}
*Trend:* ${trendData.trend.toUpperCase()}
*LTF Bias:* ${ltfBias}
*Strength:* ${zone.strength.toFixed(2)}
*Permission:* ${permission}

*Zone:* ${zone.min.toFixed(2)} — ${zone.max.toFixed(2)}

${sltp ? `
*Entry:* ${zone.entry.toFixed(2)}
*SL:* ${sltp.sl.toFixed(2)}
*TP1:* ${sltp.tp1.toFixed(2)}  *TP2:* ${sltp.tp2.toFixed(2)}  *TP3:* ${sltp.tp3.toFixed(2)}
` : "_Waiting for alignment_"}
`;

  await sendTelegramMessage(msg);
}
