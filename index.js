import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ========================================
// CONFIGURATION (secrets in .env)
// ========================================
const SYMBOL = "BTC/USDT";
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

  if (closes.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough data" };

  // --- EMA STACK ---
  const emaArr = {};
  EMA_STACK.forEach((p) => {
    emaArr[p] = EMA.calculate({ period: p, values: closes });
  });

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

  // --- Structure check (HH/HL or LL/LH) ---
  const last5 = closes.slice(-6);
  const hhhl = last5.every((c, i, arr) => (i === 0 ? true : c > arr[i - 1]));
  const lllh = last5.every((c, i, arr) => (i === 0 ? true : c < arr[i - 1]));

  // --- Momentum (EMA20 slope) ---
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
  const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-ATR_PERIOD).length);

  // Walk backwards looking for a strong directional impulse matching polarity
  for (let i = candles.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    // require body > ATR and direction matching polarity, and volume impulse
    if (body > lastATR && volStrong) {
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
    // For sell (polarity='bear') we expect a bearish rejection (wick up then rejection).
    if (polarity === "bear") {
      const upperWick = candle.h - Math.max(candle.o, candle.c);
      const body = Math.abs(candle.c - candle.o);
      const rejected = upperWick > 0.4 * (candle.h - candle.l) && candle.c < candle.o;
      if (rejected) return { index: i, candle };
    } else {
      // For buy zone, expect lower-wick rejection and close higher
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
  const atr = atrArr.slice(-1)[0];

  const zoneMin = ob.obLow - 0.25 * atr;
  const zoneMax = ob.obHigh + 0.1 * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  const origin = intraday[ob.originIndex];
  const last = intraday[intraday.length - 1];
  if (last.o < origin.c && last.c > origin.o) {
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
  const atr = atrArr.slice(-1)[0];

  const zoneMin = ob.obLow - 0.1 * atr;
  const zoneMax = ob.obHigh + 0.25 * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  const origin = intraday[ob.originIndex];
  const subsequent = intraday.slice(ob.originIndex + 1);
  const invalidatingSubsequent = subsequent.some((c) => c.h > origin.h + atr * 0.25);
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
  return n.toFixed(6);
}

// Build the telegram-friendly message for zone
function buildZoneMessage({ symbol, trend, zone, sltp, label, note }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro Alert*\n`;
  msg += `\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n`;
  msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
  msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
  if (zone.retest) msg += `*Retest observed:* yes\n`;
  if (note) msg += `*Note:* ${note}\n`;
  if (sltp) {
    msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n`;
    msg += `*Estimated risk:* ${fmt(sltp.risk)}\n`;
  }
  if (label) msg += `\n_${label}_\n`;
  msg += `\n_Source: CTWL-Pro (no lookahead checks enforced)_`;
  return msg;
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runCTWLPro() {
  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);

    if (isChop(daily)) {
      console.log("Market in chop — skipping zones.");
      // You may want to notify but default is skip to avoid spam
      return;
    }

    const trendObj = detectTrend(daily);
    const trend = trendObj.trend;
    if (trend === "invalid") {
      console.log("Trend invalid:", trendObj.reason);
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
    // Optional: send error to telegram if configured
    try {
      await sendTelegramMessage(`CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}`);
    } catch (e) {
      // swallow
    }
  }
}

// ========================================
// SCHEDULER: align to Binance 4H candle boundaries (UTC)
// ========================================
function msUntilNext4HBoundary() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const second = now.getUTCSeconds();
  // next boundary is the next hour that is divisible by 4
  const nextBoundaryHour = Math.floor(hour / 4) * 4 + 4;
  let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextBoundaryHour, 0, 5));
  if (nextBoundaryHour >= 24) {
    // wrap to next day
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
  }
  const ms = next.getTime() - now.getTime();
  return ms > 0 ? ms : 0;
}

// Start scheduler
async function startScheduler() {
  // If we happen to be exactly at boundary (minute 0, second small), run immediately
  const now = new Date();
  if (now.getUTCMinutes() === 0) {
    // allow immediate run if within first 10 seconds of boundary
    if (now.getUTCSeconds() <= 10 && ENTRY_WINDOWS_UTC.includes(now.getUTCHours())) {
      console.log("At boundary — running immediately.");
      runCTWLPro();
    }
  }

  const delay = msUntilNext4HBoundary();
  console.log(`Scheduler: waiting ${Math.round(delay / 1000)}s until next 4H boundary (UTC).`);
  setTimeout(() => {
    // run at boundary
    (async () => {
      try {
        await runCTWLPro();
      } catch (e) {
        console.error("Run at scheduled boundary failed:", e);
      }
    })();

    // schedule repeated runs every 4 hours (exact multiple)
    const fourHours = 4 * 3600 * 1000;
    setInterval(() => {
      (async () => {
        try {
          await runCTWLPro();
        } catch (e) {
          console.error("Scheduled run failed:", e);
        }
      })();
    }, fourHours);
  }, delay);
}

// If run directly (node ctwl-pro.js) start scheduler
if (typeof process !== "undefined" && process.argv && process.argv.includes("--run")) {
  startScheduler();
}

// Allow module usage too: default immediate start
// NOTE: this will run scheduler automatically when file is imported/run without flags
startScheduler();


