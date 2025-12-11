// ctwl-pro-sol.js
// Full CTWL-Pro engine for SOL/USDT with SOL-tuned ATR integration
// Requires: ccxt, technicalindicators, node-fetch, dotenv

import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ==================== CONFIG ====================
const SYMBOL = "SOL/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h" };
const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.5;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
  console.warn("Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set.");

// ==================== EXCHANGE ====================
const exchange = new ccxt.binance({
  apiKey: BINANCE_API_KEY || undefined,
  secret: BINANCE_SECRET || undefined,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "future" },
});

// ==================== UTILITIES ====================
async function safeFetch(exchangeInstance, method, ...args) {
  const maxRetries = 4;
  const baseDelay = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await method.apply(exchangeInstance, args);
    } catch (err) {
      console.warn(`[safeFetch] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise((res) => setTimeout(res, baseDelay * attempt));
    }
  }
}

async function fetchCandles(symbol, timeframe, limit = 400) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

function fmt(n) {
  if (typeof n !== "number") return String(n);
  if (n >= 1000) return n.toFixed(2);
  return parseFloat(n.toFixed(6)).toString();
}

// ==================== TREND DETECTION ====================
function detectTrend(candles) {
  const closes = candles.map((c) => c.c);
  const needed = Math.max(...EMA_STACK);
  if (closes.length < needed) return { trend: "invalid", reason: "Not enough data" };

  const emaArr = {};
  EMA_STACK.forEach((p) => {
    try { emaArr[p] = EMA.calculate({ period: p, values: closes }); }
    catch (e) { emaArr[p] = []; }
  });

  const lastClose = closes[closes.length - 1];
  const lastEMA = EMA_STACK.every((p) => lastClose > (emaArr[p]?.slice(-1)[0] || 0));
  const lastEMA_bear = EMA_STACK.every((p) => lastClose < (emaArr[p]?.slice(-1)[0] || 0));

  const last5 = closes.slice(-6);
  const hhhl = last5.length >= 2 && last5.every((c, i, arr) => i === 0 || c > arr[i - 1]);
  const lllh = last5.length >= 2 && last5.every((c, i, arr) => i === 0 || c < arr[i - 1]);

  const ema20 = emaArr[20] || [];
  const slope20 = ema20.length >= 2 ? ema20.slice(-1)[0] - ema20.slice(-2)[0] : 0;

  const bullishMomentum = slope20 > 0;
  const bearishMomentum = slope20 < 0;

  const bullishLayers = [lastEMA, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers = [lastEMA_bear, lllh, bearishMomentum].filter(Boolean).length;

  const ema200 = emaArr[200]?.slice(-1)[0] || null;

  if (bullishLayers >= 2) return { trend: "bull", ema200, layers: bullishLayers };
  if (bearishLayers >= 2) return { trend: "bear", ema200, layers: bearishLayers };

  return { trend: "invalid", reason: "Layers not aligned", layers: { bullish: bullishLayers, bearish: bearishLayers } };
}

// ==================== ATR & OB/FVG DETECTION ====================
function detectOBFVG(candles, polarity = "bull") {
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const opens = candles.map((c) => c.o);
  const vols = candles.map((c) => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const lastATR = atrArr.slice(-1)[0];

  const volSlice = vols.slice(-ATR_PERIOD);
  const volAvg = volSlice.reduce((a, b) => a + b, 0) / Math.max(1, volSlice.length);

  for (let i = candles.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    if (!lastATR || !volStrong) continue;

    if (polarity === "bull" && isBullish && body > lastATR) {
      return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };
    }
    if (polarity === "bear" && isBearish && body > lastATR) {
      return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };
    }
  }
  return null;
}

// ==================== RETEST VALIDATION ====================
function validateRetest(candles, zone, polarity = "bull") {
  const lookback = 10;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - lookback); i--) {
    const candle = candles[i];
    const touched = candle.h >= zone.min && candle.l <= zone.max;
    if (!touched) continue;

    const wickSize = polarity === "bull"
      ? Math.min(candle.o, candle.c) - candle.l
      : candle.h - Math.max(candle.o, candle.c);

    const candleRange = candle.h - candle.l;
    const body = Math.abs(candle.c - candle.o);
    if (wickSize > 0.4 * candleRange) return { index: i, candle };
  }
  return null;
}

// ==================== BUY/SELL ZONES ====================
function computeBuyZone(daily, intraday) {
  const ob = detectOBFVG(intraday, "bull");
  if (!ob) return null;

  const highs = intraday.map((c) => c.h);
  const lows = intraday.map((c) => c.l);
  const closes = intraday.map((c) => c.c);

  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atr = atrArr.slice(-1)[0] || 0;

  const zoneMin = ob.obLow - 0.25 * atr;
  const zoneMax = ob.obHigh + 0.1 * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  const origin = intraday[ob.originIndex];
  const last = intraday[intraday.length - 1];
  if (origin && last && last.o < origin.c && last.c > origin.o) {
    return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, note: "origin overlap suspicious" };
  }

  return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength };
}

function computeSellZone(daily, intraday) {
  const ob = detectOBFVG(intraday, "bear");
  if (!ob) return null;

  const highs = intraday.map((c) => c.h);
  const lows = intraday.map((c) => c.l);
  const closes = intraday.map((c) => c.c);

  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atr = atrArr.slice(-1)[0] || 0;

  const zoneMin = ob.obLow - 0.1 * atr;
  const zoneMax = ob.obHigh + 0.25 * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, "bear");

  return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, retest: retest ? true : false };
}

// ==================== SL/TP ====================
function computeSLTP(zone, trend) {
  if (!zone) return null;
  const sl = trend === "bull" ? zone.min * 0.995 : zone.max * 1.005;
  const risk = trend === "bull" ? zone.midpoint - sl : sl - zone.midpoint;

  return {
    sl,
    tp1: trend === "bull" ? zone.midpoint + risk : zone.midpoint - risk,
    tp2: trend === "bull" ? zone.midpoint + 2 * risk : zone.midpoint - 2 * risk,
    tp3: trend === "bull" ? zone.midpoint + 3 * risk : zone.midpoint - 3 * risk,
    risk,
  };
}

// ==================== CHOP DETECTION ====================
function getChopParams(symbol) {
  const base = { bodyVsAtrFactor: 0.40, weakMovementFactor: 0.25, overlapReq: 2, lookbackWindow: 8, requireMinCandles: 30, lowVolumeFactor: 0.85 };
  if (symbol.toUpperCase().startsWith("SOL")) {
    return { ...base, bodyVsAtrFactor: 0.45, weakMovementFactor: 0.28, overlapReq: 2, lowVolumeFactor: 0.80 };
  }
  return base;
}

function isChop(candles, symbol = "SOL/USDT") {
  const params = getChopParams(symbol);
  if (!candles || candles.length < params.requireMinCandles) return { isChop: false, reason: "insufficient candles" };

  const H = candles.map(c => c.h);
  const L = candles.map(c => c.l);
  const C = candles.map(c => c.c);
  const O = candles.map(c => c.o);
  const V = candles.map(c => c.v);

  const atrArr = ATR.calculate({ high: H, low: L, close: C, period: ATR_PERIOD });
  const atrAvg = atrArr.slice(-params.lookbackWindow).reduce((a, b) => a + b, 0) / params.lookbackWindow;

  const lastN = candles.slice(-params.lookbackWindow);
  const bodySizes = lastN.map(c => Math.abs(c.c - c.o));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / lastN.length;
  const condBodyVsAtr = avgBody < params.bodyVsAtrFactor * atrAvg;

  const netMove = Math.abs(lastN[lastN.length - 1].c - lastN[0].o);
  const condWeakMovement = netMove < params.weakMovementFactor * atrAvg * params.lookbackWindow;

  let overlapCount = 0;
  for (let i = candles.length - params.lookbackWindow; i < candles.length - 1; i++) {
    const overlap = Math.min(candles[i].h, candles[i + 1].h) - Math.max(candles[i].l, candles[i + 1].l);
    if (overlap > 0.15 * atrAvg) overlapCount++;
  }
  const condOverlap = overlapCount >= params.overlapReq;

  const volBaseline = V.slice(-Math.max(50, params.lookbackWindow)).reduce((a, b) => a + b, 0) / Math.max(1, Math.max(50, params.lookbackWindow));
  const avgVolN = lastN.map(c => c.v).reduce((a, b) => a + b, 0) / lastN.length;
  const condLowVolume = avgVolN < volBaseline * params.lowVolumeFactor;

  const chopScore = [condBodyVsAtr, condWeakMovement, condOverlap, condLowVolume].filter(Boolean).length;
  const isChoppy = chopScore >= 2;

  return { isChop: isChoppy, chopScore, conditions: { condBodyVsAtr, condWeakMovement, condOverlap, condLowVolume }, atrAvg, overlapCount, paramsUsed: params };
}

// ==================== TELEGRAM ====================
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!data.ok) throw new Error(JSON.stringify(data));
      return data;
    } catch (err) {
      if (i === 3) console.error("[telegram] all attempts failed:", err.message);
      else await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

function buildZoneMessage({ symbol, trend, zone, sltp, strength, note, mode }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend?.toUpperCase() || "N/A"}\n*When:* ${nowUTC}\n`;
  if (zone) {
    msg += `\n*Mode:* ${mode || "SNIPER"}\n*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n*Strength:* ${fmt(strength)}\n`;
    if (zone.retest) msg += `*Retest observed:* yes\n`;
    if (note || zone.note) msg += `*Note:* ${note || zone.note}\n`;
    if (sltp) msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}  *TP2:* ${fmt(sltp.tp2)}  *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
  } else msg += "*No zone computed.*\n";
  msg += `\n_Source: CTWL-Pro (no lookahead enforced)_`;
  return msg;
}

// ==================== RUN SOL FUNCTION ====================
export async function runSOLatr() {
  try {
    await exchange.loadMarkets();
  } catch (e) {
    console.warn("Failed to load markets:", e.message);
  }

  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);
    const lastPrice = intraday.slice(-1)[0]?.c || daily.slice(-1)[0]?.c;

    // Chop detection and trend
    const chopDiag = isChop(daily);
    const trendObj = detectTrend(daily);
    let trend = trendObj.trend;
    if (trend === "invalid" && chopDiag?.isChop) trend = "chop";

    const lastDir = intraday.slice(-1)[0]?.c > intraday.slice(-1)[0]?.o ? "bull" : "bear";

    // Compute zones and SL/TP
    let zone = null;
    let sltp = null;

    if (trend === "bull") {
      zone = computeBuyZone(daily, intraday);
      sltp = computeSLTP(zone, "bull");
    } else if (trend === "bear") {
      zone = computeSellZone(daily, intraday);
      sltp = computeSLTP(zone, "bear");
    } else if (trend === "chop") {
      const atrVal = ATR.calculate({
        high: intraday.map(c => c.h),
        low: intraday.map(c => c.l),
        close: intraday.map(c => c.c),
        period: ATR_PERIOD
      }).slice(-1)[0] || 0;

      if (lastDir === "bull") {
        zone = computeBuyZone(daily, intraday) || computeVolatilityZone(intraday, atrVal);
        sltp = computeSLTP(zone, "bull");
      } else {
        zone = computeSellZone(daily, intraday) || computeVolatilityZone(intraday, atrVal);
        sltp = computeSLTP(zone, "bear");
      }
    }

    // Build Telegram message
    const msg = buildZoneMessage({
      symbol: SYMBOL,
      trend,
      zone,
      sltp,
      strength: zone?.strength || 0,
      note: chopDiag?.isChop ? "Choppy conditions detected" : "",
      mode: "SNIPER"
    });

    // Send Telegram alert
    await sendTelegramMessage(msg);

    console.log("[CTWL-Pro SOL] Alert sent successfully.\n", msg);

    return { trend, zone, sltp, lastPrice, chopDiag };
  } catch (err) {
    console.error("[runSOL] Error:", err.message);
    return { trend: null, zone: null, sltp: null, lastPrice: null, error: err.message };
  }
}
