import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();
// ========================================
// CONFIGURATION (secrets in .env)
// ========================================
const SYMBOL = "SOL/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.5; // how much stronger volume must be than average to count as strong impulse

// Sniper entry windows - aligned with 4h candles (UTC)
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

// Telegram / Binance credentials
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Provide Binance API keys to ccxt if present (allows higher rate or authenticated endpoints if later needed)
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
      const delay = baseDelay * attempt;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// --- FETCH OHLCV CANDLES ---
async function fetchCandles(symbol, timeframe, limit = 200) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ========================================
// TREND DETECTION (3-LAYER)
// ========================================
function detectTrend(daily) {
  const closes = daily.map((c) => c.c);

  const needed = Math.max(...EMA_STACK);
  if (closes.length < needed) return { trend: "invalid", reason: "Not enough data" };

  // --- EMA STACK ---
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

  // --- Structure check (HH/HL or LL/LH) ---
  const last5 = closes.slice(-6);
  const hhhl = last5.length >= 2 && last5.every((c, i, arr) => (i === 0 ? true : c > arr[i - 1]));
  const lllh = last5.length >= 2 && last5.every((c, i, arr) => (i === 0 ? true : c < arr[i - 1]));

  // --- Momentum (EMA20 slope) ---
  const ema20 = emaArr[20] || [];
  const slope20 = ema20.length >= 2 ? ema20.slice(-1)[0] - ema20.slice(-2)[0] : 0;
  const bullishMomentum = slope20 > 0;
  const bearishMomentum = slope20 < 0;

  const bullishLayers = [lastEMA, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers = [lastEMA_bear, lllh, bearishMomentum].filter(Boolean).length;

  const ema200 = (emaArr[200] && emaArr[200].length) ? emaArr[200].slice(-1)[0] : null;

  if (bullishLayers >= 2) return { trend: "bull", ema200 };
  if (bearishLayers >= 2) return { trend: "bear", ema200 };

  return { trend: "invalid", reason: "Layers not aligned" };
}

// ========================================
// HTF LEVEL DETECTION (OB/FVG) - BULL & BEAR
// ========================================
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

  // Walk backwards looking for a strong directional impulse matching polarity
  for (let i = candles.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    // require body > ATR and direction matching polarity, and volume impulse
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

// ========================================
// VALIDATE RETEST (NO LOOKAHEAD, REJECTION CHECK)
// ========================================
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

// ========================================
// COMPUTE BUY ZONE
// ========================================
function computeBuyZone(daily, intraday, trend) {
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

// ========================================
// COMPUTE SELL ZONE (mirror)
// ========================================
function computeSellZone(daily, intraday, trend) {
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

// ========================================
// SL/TP CALCULATION
// ========================================
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

// ========================================
// CHOP DETECTION
// ========================================
function isChop(candles) {
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });

  const last8 = atrArr.slice(-8);
  if (last8.length < 8) return false;
  const atrAvg = last8.reduce((a, b) => a + b, 0) / 8;
  const bodySizes = candles.slice(-8).map((c) => Math.abs(c.c - c.o));
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / 8;
  return avgBody < 0.5 * atrAvg;
}

// ========================================
// TIME FILTER
// ========================================
function isInSniperWindow(ts = Date.now()) {
  const hourUTC = new Date(ts).getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ========================================
// TELEGRAM NOTIFIER (with retry)
// ========================================
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

// Helper to pretty format numbers
function fmt(n) {
  if (typeof n !== "number") return String(n);
  if (n >= 1000) return n.toFixed(2);
  // show up to 6 decimals for small prices; trim trailing zeros
  return parseFloat(n.toFixed(6)).toString();
}

// Build messages
function buildZoneMessage({ symbol, trend, zone, sltp, label, note }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Alert*\n`;
  msg += `\n*Symbol:* ${symbol}\n*Trend:* ${trend ? trend.toUpperCase() : "N/A"}\n*When:* ${nowUTC}\n\n`;
  if (zone) {
    msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
    msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
    if (zone.retest) msg += `*Retest observed:* yes\n`;
    if (note) msg += `*Note:* ${note}\n`;
    if (sltp) {
      msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n`;
      msg += `*Estimated risk:* ${fmt(sltp.risk)}\n`;
    }
    if (label) msg += `\n_${label}_\n`;
  } else {
    msg += `*No valid zone found.*\n`;
    if (note) msg += `*Note:* ${note}\n`;
    if (label) msg += `\n_${label}_\n`;
  }
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
  msg += `\n_This is an automated status provided every 4H boundary._`;
  return msg;
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runSOL() {
  try {
    await exchange.loadMarkets();
  } catch (e) {
    console.warn("Warning: failed to load markets:", e.message || e);
  }

  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);

    // Determine last price (safe)
    const lastPrice = intraday && intraday.length ? intraday[intraday.length - 1].c : (daily && daily.length ? daily[daily.length - 1].c : null);

    if (isChop(daily)) {
      console.log("Market in chop — skipping zones.");
      // Now: send status message (user requested always notify)
      return;
    }

    const trendObj = detectTrend(daily);
    const trend = trendObj.trend;
    if (trend === "invalid") {
      console.log("Trend invalid:", trendObj.reason);
      // send status message
      return;
    }

    // Time filter sanity (should always pass when scheduler aligned, but keep it)
    const now = Date.now();
    if (!isInSniperWindow(now)) {
      console.log("Outside sniper entry window (redundant check) — skipping.");
      return;
    }

    if (trend === "bull") {
      const zone = computeBuyZone(daily, intraday, trend);
      const sltp = computeSLTP(zone, "bull");
      if (!zone) {
        console.log("No valid buy origin/OB found — waiting for impulse.");
       
      } else {
        console.log("=== CTWL-Pro BUY OUTPUT ===");
        console.log({ symbol: SYMBOL, trend, zone, sltp });
        const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label: "VALID BUY ZONE" });
        await sendTelegramMessage(msg);
      }
    } else if (trend === "bear") {
      console.log("Trend appears BEAR. Measuring sell-side...");
      const zone = computeSellZone(daily, intraday, trend);
      const sltp = computeSLTP(zone, "bear");
      if (!zone) {
        console.log("No valid sell origin/OB found — measuring continues.");
      
      } else {
        const label = zone.retest ? "VALID SELL ZONE (retest observed)" : "VALID SELL ZONE (no retest)";
        console.log("=== CTWL-Pro SELL OUTPUT ===");
        console.log(label);
        console.log({ symbol: SYMBOL, trend, zone, sltp });
        const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label, note: zone.note });
        await sendTelegramMessage(msg);
      }
    } else {
      console.log("Unhandled trend state:", trend);
    }
  } catch (err) {
    console.error("CTWL-Pro ERROR:", err.message || err);
    // Attempt to send the error to telegram if configured
    try {
      await sendTelegramMessage(`CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}`);
    } catch (e) {
      // swallow
    }
  }
}


// ==========
// Allow module usage too: default immediate start
// NOTE: this will run scheduler automatically when file is imported/run without flags

