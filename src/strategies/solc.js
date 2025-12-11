// ctwl-pro.js
// Full CTWL-Pro patched with CHOP MODE, preserving original logic and behavior.
// Drop-in replacement for your engine file.
// Requirements: ccxt, technicalindicators, node-fetch, dotenv

import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// ==================== CONFIG ====================
const symbol = "SOL/USDT";
const DEFAULT_SYMBOL = "SOL/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.5;

const ENTRY_WINDOWS_UTC = [0,4,8,12,16,20];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("Warning: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not set. Alerts will be skipped.");
}

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
      const delay = baseDelay * attempt;
      await new Promise((res) => setTimeout(res, delay));
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

// ==================== TREND DETECTION (3-LAYER) ====================
function detectTrend(daily) {
  const closes = daily.map((c) => c.c);
  const needed = Math.max(...EMA_STACK);
  if (closes.length < needed) return { trend: "invalid", reason: "Not enough data" };

  const emaArr = {};
  EMA_STACK.forEach((p) => {
    try {
      emaArr[p] = EMA.calculate({ period: p, values: closes });
    } catch (e) {
      emaArr[p] = [];
    }
  });

  const lastClose = closes[closes.length - 1];

  const lastEMA = EMA_STACK.every((p) => {
    const arr = emaArr[p];
    if (!arr || arr.length === 0) return false;
    const lastEMAValue = arr.slice(-1)[0];
    return lastClose > lastEMAValue;
  });

  const lastEMA_bear = EMA_STACK.every((p) => {
    const arr = emaArr[p];
    if (!arr || arr.length === 0) return false;
    const lastEMAValue = arr.slice(-1)[0];
    return lastClose < lastEMAValue;
  });

  const last5 = closes.slice(-6);
  const hhhl = last5.length >= 2 && last5.every((c, i, arr) => (i === 0 ? true : c > arr[i - 1]));
  const lllh = last5.length >= 2 && last5.every((c, i, arr) => (i === 0 ? true : c < arr[i - 1]));

  const ema20 = emaArr[20] || [];
  const slope20 = ema20.length >= 2 ? ema20.slice(-1)[0] - ema20.slice(-2)[0] : 0;
  const bullishMomentum = slope20 > 0;
  const bearishMomentum = slope20 < 0;

  const bullishLayers = [lastEMA, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers = [lastEMA_bear, lllh, bearishMomentum].filter(Boolean).length;

  const ema200 = (emaArr[200] && emaArr[200].length) ? emaArr[200].slice(-1)[0] : null;

  if (bullishLayers >= 2) return { trend: "bull", ema200, layers: bullishLayers };
  if (bearishLayers >= 2) return { trend: "bear", ema200, layers: bearishLayers };

  // Not aligned - potential chop candidate; but we still return invalid so calling code can decide.
  return { trend: "invalid", reason: "Layers not aligned", layers: { bullish: bullishLayers, bearish: bearishLayers } };
}

// ==================== HTF LEVEL DETECTION (OB/FVG) ====================
function detectOBFVG(candles, polarity = "bull") {
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const opens = candles.map((c) => c.o);
  const vols = candles.map((c) => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const lastATR = atrArr.slice(-1)[0];

  // volume baseline: avg over last ATR_PERIOD candles (simple)
  const volSlice = vols.slice(-ATR_PERIOD);
  const volAvg = volSlice.reduce((a, b) => a + b, 0) / Math.max(1, volSlice.length);

  for (let i = candles.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    if (lastATR && body > lastATR && volStrong) {
      if (polarity === "bull" && isBullish) {
        return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };
      }
      if (polarity === "bear" && isBearish) {
        return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };
      }
    }
  }
  return null;
}

// ==================== VALIDATE RETEST ====================
function validateRetest(intraday, zone, polarity = "bull") {
  const lookback = 10;
  const c = intraday;
  for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
    const candle = c[i];
    const touched = candle.h >= zone.min && candle.l <= zone.max;
    if (!touched) continue;
    if (polarity === "bear") {
      const upperWick = candle.h - Math.max(candle.o, candle.c);
      const body = Math.abs(candle.c - candle.o);
      const rejected = upperWick > 0.4 * (candle.h - candle.l) && candle.c < candle.o;
      if (rejected) return { index: i, candle };
    } else {
      const lowerWick = Math.min(candle.o, candle.c) - candle.l;
      const body = Math.abs(candle.c - candle.o);
      const rejected = lowerWick > 0.4 * (candle.h - candle.l) && candle.c > candle.o;
      if (rejected) return { index: i, candle };
    }
  }
  return null;
}

// ==================== ZONE COMPUTATION (BUY/SELL) ====================
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

  const origin = intraday[ob.originIndex];
  const subsequent = origin ? intraday.slice(ob.originIndex + 1) : [];
  const invalidatingSubsequent = origin ? subsequent.some((c) => c.h > origin.h + atr * 0.25) : false;
  if (invalidatingSubsequent) {
    return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, note: "origin may be invalidated by later HH" };
  }

  const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, "bear");

  return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, retest: retest ? true : false };
}

// ==================== SL/TP CALCULATION ====================
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

// ==================== CHOP DETECTION (symbol-aware) ====================
function getChopParams(symbol) {
  const base = {
    bodyVsAtrFactor: 0.40,       // light chop if avg body < 40% ATR
    weakMovementFactor: 0.25,    // net move < 25% of ATR*N = chop
    overlapReq: 2,               // % overlap-based, not strict inside bars
    lookbackWindow: 8,
    requireMinCandles: 30,
    lowVolumeFactor: 0.85,
  };

  if (symbol && symbol.toUpperCase().startsWith("SOL")) {
    return {
      ...base,
      bodyVsAtrFactor: 0.45,     // SOL prints large bodies normally
      weakMovementFactor: 0.28,  // SOL trends fast, allow more movement
      overlapReq: 2,             // SOL wicks often → lower requirement
      lowVolumeFactor: 0.80,     // slightly stricter low-volume test
    };
  }

  return base;
}

function isChop(candles, symbol = "DEFAULT") {
  const params = getChopParams(symbol);

  if (!candles || candles.length < params.requireMinCandles)
    return { isChop: false, reason: "insufficient candles" };

  const H = candles.map(c => c.h);
  const L = candles.map(c => c.l);
  const C = candles.map(c => c.c);
  const O = candles.map(c => c.o);
  const V = candles.map(c => c.v);

  const atrArr = ATR.calculate({ high: H, low: L, close: C, period: ATR_PERIOD });
  if (!atrArr || atrArr.length < ATR_PERIOD)
    return { isChop: false, reason: "insufficient ATR" };

  const N = params.lookbackWindow;
  const lastN = candles.slice(-N);
  const atrLastN = atrArr.slice(-N);
  if (atrLastN.length < N)
    return { isChop: false, reason: "insufficient ATR slice" };

  const atrAvg = atrLastN.reduce((a, b) => a + b, 0) / atrLastN.length;

  // ============================
  // CONDITION 1: Body vs ATR
  // ============================
  const bodySizes = lastN.map(c => Math.abs(c.c - c.o));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;
  const condBodyVsAtr = avgBody < params.bodyVsAtrFactor * atrAvg;

  // ============================
  // CONDITION 2: Weak Net Move
  // ============================
  const netMove = Math.abs(lastN[lastN.length - 1].c - lastN[0].o);
  const atrTotal = atrAvg * N;
  const condWeakMovement = netMove < params.weakMovementFactor * atrTotal;

  // ============================
  // CONDITION 3: Overlap (percentage-based)
  // ============================
  let overlapCount = 0;
  for (let i = candles.length - N; i < candles.length - 1; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];

    // Compute overlap size relative to average ATR
    const overlapHigh = Math.min(c1.h, c2.h);
    const overlapLow = Math.max(c1.l, c2.l);
    const overlap = overlapHigh > overlapLow ? (overlapHigh - overlapLow) : 0;

    if (overlap > 0.15 * atrAvg) overlapCount++; // 15% ATR overlap threshold
  }
  const condOverlap = overlapCount >= params.overlapReq;

  // ============================
  // CONDITION 4: Low Volume
  // ============================
  const baselinePeriod = Math.max(50, N);
  const volBaseline =
    V.slice(-baselinePeriod).reduce((a, b) => a + b, 0) /
    Math.max(1, Math.min(baselinePeriod, V.length));

  const avgVolN = lastN.map(c => c.v).reduce((a, b) => a + b, 0) / lastN.length;
  const condLowVolume = avgVolN < volBaseline * params.lowVolumeFactor;

  // ============================
  // SCORING SYSTEM
  // ============================
  const conditions = [condBodyVsAtr, condWeakMovement, condOverlap, condLowVolume];
  const chopScore = conditions.filter(Boolean).length;

  const isChoppy = chopScore >= 2;

  // ============================
  // RANGE / DEVIATION
  // ============================
  const highs = lastN.map(c => c.h);
  const lows = lastN.map(c => c.l);
  const rangeWidth = Math.max(...highs) - Math.min(...lows);
  const deviation = atrAvg > 0 ? rangeWidth / atrAvg : null;

  return {
    isChop: isChoppy,
    chopScore,
    conditions: {
      condBodyVsAtr,
      condWeakMovement,
      condOverlap,
      condLowVolume
    },
    atrAvg,
    rangeWidth,
    deviation,
    overlapCount,
    paramsUsed: params,
  };
}





// ==================== FALLBACK ZONE (simple volatility zone) ====================
function computeVolatilityZone(candles, atr) {
  const last = candles[candles.length - 1];
  const mid = last.c || ((last.o + last.h + last.l) / 3);
  // Tuned multipliers — matches prior code's conservative zone sizing but independent
  const upper = mid + atr * 2.4;
  const lower = mid - atr * 2.4;
  return { min: lower, max: upper, midpoint: mid, note: "volatility fallback zone" };
}

// ==================== STRENGTH CALCULATOR (real + fallback) ====================
function computeRealStrengthFromOB(zone) {
  // prefer zone.strength if provided (from OB detection)
  if (!zone) return null;
  if (zone.strength && typeof zone.strength === 'number') return zone.strength;
  return null;
}

function computeStrength(realStrength, atr, price) {
  if (realStrength && realStrength > 0) return Number(realStrength.toFixed(2));

  // fallback: ATR as percentage of price -> continuity with CTWL approach
  if (atr && price && price > 0) {
    const fallback = (atr / price) * 100; // e.g. 0.5% -> 0.5
    if (fallback > 0.6) return Number(fallback.toFixed(2));
  }

  // minimum guaranteed strength
  return 0.80;
}

// ==================== TIME FILTER ====================
function isInSniperWindow(ts = Date.now()) {
  const hourUTC = new Date(ts).getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ==================== TELEGRAM ====================
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID; skipping send.");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };

  const maxAttempts = 3;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(JSON.stringify(data));
      return data;
    } catch (err) {
      console.warn(`[telegram] attempt ${i} failed: ${err.message}`);
      if (i === maxAttempts) {
        console.error("[telegram] all attempts failed.");
      } else {
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }
}

// ==================== MESSAGES ====================
function buildZoneMessage({ symbol, trend, zone, sltp, label, note, strength, mode }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Alert*\n`;
  msg += `\n*Symbol:* ${symbol}\n*Trend:* ${trend ? trend.toUpperCase() : "N/A"}\n*When:* ${nowUTC}\n\n`;
  if (zone) {
    msg += `*Mode:* ${mode || "SNIPER"}\n`;
    msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
    msg += `*Strength:* ${fmt(strength)}\n`;
    if (zone.retest) msg += `*Retest observed:* yes\n`;
    if (note || zone.note) msg += `*Note:* ${note || zone.note}\n`;
    if (sltp) {
      msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n`;
      msg += `*Estimated risk:* ${fmt(sltp.risk)}\n`;
    }
  } else {
    msg += `*No zone computed.*\n`;
    if (note) msg += `*Note:* ${note}\n`;
  }
  if (label) msg += `\n_${label}_\n`;
  msg += `\n_Source: CTWL-Pro (no lookahead enforced)_`;
  return msg;
}

function buildStatusMessage({ symbol, reason, lastPrice, trendObj }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Status*\n\n*Symbol:* ${symbol}\n*When:* ${nowUTC}\n*Status:* ${reason}\n`;
  if (lastPrice) msg += `*Last Price:* ${fmt(lastPrice)}\n`;
  if (trendObj) {
    msg += `*Trend state:* ${trendObj.trend || "N/A"}${trendObj.reason ? ` (${trendObj.reason})` : ""}\n`;
  }
  msg += `\n_This is an automated status message._`;
  return msg;
}

// ==================== MAIN FUNCTION (symbol-agnostic) ====================
export async function runSOL() {
  try {
    await exchange.loadMarkets();
  } catch (e) {
    console.warn("Warning: failed to load markets:", e.message || e);
  }

  try {
    const daily = await fetchCandles(symbol, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(symbol, TIMEFRAMES.intraday, 200);

    const lastPrice = intraday && intraday.length ? intraday[intraday.length - 1].c : (daily && daily.length ? daily[daily.length - 1].c : null);

    // --- CHOP DIAGNOSTIC (use daily by default) ---
    const chopDiag = isChop(daily);

    // Decide trend
    const trendObj = detectTrend(daily);
    let trend = trendObj.trend;
    // If trend invalid and chop detected, label CHOP to make decision explicit
    if (trend === "invalid" && chopDiag && chopDiag.isChop) {
      trend = "chop";
    }

    // Compute HTF OB / zones, but do NOT abort on chop - we ALWAYS compute a zone now
    let zone = null;
    let sltp = null;
    // Try normal sniper zones first
    if (trend === "bull") {
      zone = computeBuyZone(daily, intraday);
      if (zone) sltp = computeSLTP(zone, "bull");
    } else if (trend === "bear") {
      zone = computeSellZone(daily, intraday);
      if (zone) sltp = computeSLTP(zone, "bear");
    } else {
      // Trend is 'chop' or unknown => compute fallback OB-based zone if possible, else volatility zone
      // Try both sides: prefer buy or sell depending on last directional candle
      const lastIntraday = intraday[intraday.length - 1];
      const lastDir = lastIntraday && lastIntraday.c > lastIntraday.o ? "bull" : "bear";
      if (lastDir === "bull") {
        zone = computeBuyZone(daily, intraday);
        if (!zone) {
          // fallback: compute volatility zone from intraday candles
          const highs = intraday.map((c) => c.h);
          const lows = intraday.map((c) => c.l);
          const closes = intraday.map((c) => c.c);
          const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
          const atr = atrArr.slice(-1)[0] || 0;
          zone = computeVolatilityZone(intraday, atr);
        } else {
          sltp = computeSLTP(zone, "bull");
        }
      } else {
        zone = computeSellZone(daily, intraday);
        if (!zone) {
          const highs = intraday.map((c) => c.h);
          const lows = intraday.map((c) => c.l);
          const closes = intraday.map((c) => c.c);
          const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
          const atr = atrArr.slice(-1)[0] || 0;
          zone = computeVolatilityZone(intraday, atr);
        } else {
          sltp = computeSLTP(zone, lastDir === "bull" ? "bull" : "bear");
        }
      }
    }

    // Compute ATR for strength fallback
    const highsAll = intraday.map((c) => c.h);
    const lowsAll = intraday.map((c) => c.l);
    const closesAll = intraday.map((c) => c.c);
    const atrArrAll = ATR.calculate({ high: highsAll, low: lowsAll, close: closesAll, period: ATR_PERIOD });
    const atrLatest = atrArrAll.slice(-1)[0] || 0;

    // Compute strength (real first)
    const realStrength = computeRealStrengthFromOB(zone);
    const strength = computeStrength(realStrength, atrLatest, lastPrice || (closesAll[closesAll.length - 1] || 1));

    // Determine mode: SNIPER vs CHOP
    // Sniper if trend is bull|bear (not invalid/chop) AND strength >= threshold
    const SNIPER_MIN = Number(process.env.CTWL_SNIPER_MIN) || 1.4;
    let mode = "SNIPER";
    if (!zone || trend === "chop" || trend === "invalid" || strength < SNIPER_MIN || (chopDiag && chopDiag.isChop)) {
      mode = "CHOP";
    }

    // Build message and send ALWAYS (your requirement)
    const label = mode === "SNIPER" ? (trend === "bull" ? "VALID BUY ZONE" : "VALID SELL ZONE") : "CHOP MODE ZONE";
    const noteParts = [];
    if (chopDiag && chopDiag.isChop) {
      noteParts.push(`CHOP DETECTED (score=${chopDiag.chopScore})`);
    }
    if (zone && zone.note) noteParts.push(zone.note);
    const note = noteParts.join(" | ") || undefined;

    const msg = buildZoneMessage({
      symbol,
      trend,
      zone,
      sltp,
      label,
      note,
      strength,
      mode
    });

    // Send message (will be sent for CHOP and SNIPER)
    await sendTelegramMessage(msg);
    console.log(`[CTWL-Pro] Sent ${mode} message for ${symbol} | strength=${fmt(strength)} | trend=${trend}`);

    // Optionally send a status message (every run) - helpful for debugging
    const statusReason = mode === "SNIPER" ? "SNIPER signal emitted" : "CHOP mode signal emitted";
    const statusMsg = buildStatusMessage({ symbol, reason: statusReason, lastPrice, trendObj });
    await sendTelegramMessage(statusMsg);

    return {
      symbol,
      trend,
      mode,
      zone,
      sltp,
      strength,
      chopDiag
    };
  } catch (err) {
    console.error("CTWL-Pro ERROR:", err.message || err);
    try {
      await sendTelegramMessage(`CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}`);
    } catch (e) { /* swallow */ }
    throw err;
  }
}


