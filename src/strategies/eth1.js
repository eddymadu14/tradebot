import ccxt from "ccxt";
import { EMA, ATR, SMA } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();
// =====================================================
// CTWL-Pro — ETH stand-alone sniper (1H-dominant, 4H bias)
// Converted from your BTC engine and aggressively tuned
// for ETH behaviour (faster entries, tighter SLs, liquidity sweeps)
// =====================================================

// ----------------- CONFIG -----------------
const SYMBOL = "ETH/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "1h", bias: "4h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
// ETH needs lower volume requirement for impulse detection (more frequent impulses)
const IMPULSE_VOLUME_FACTOR = 1.2;
// ETH uses tighter ATR padding for zones
const ZONE_ATR_PAD = { min: 0.15, max: 0.15 };

// Sniper window settings — ETH is 1H-dominant so allow hourly checks; you can tighten if noisy
const SNIPER_WINDOW_STRICT = false; // false => allow checks every run; true => only on ENTRY_WINDOWS_UTC
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20]; // still supported if strict mode enabled

// Telegram / Binance creds
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("Warning: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID should be set in .env to receive alerts.");
}

// ----------------- EXCHANGE -----------------
const exchange = new ccxt.binance({
  apiKey: BINANCE_API_KEY || undefined,
  secret: BINANCE_SECRET || undefined,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "future" },
});

// ---------- SAFE FETCH ----------
async function safeFetch(exchangeInstance, method, ...args) {
  const maxRetries = 4;
  const baseDelay = 1200;
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

async function fetchCandles(symbol, timeframe, limit = 500) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ---------- TREND DETECTION (1H-dominant, 4H bias) ----------
function detectTrend(intraday1h, bias4h) {
  // intraday1h is prioritized for structure/momentum
  const closes1h = intraday1h.map((c) => c.c);
  if (closes1h.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough 1H data" };

  const emaArr1h = {};
  EMA_STACK.forEach((p) => {
    emaArr1h[p] = EMA.calculate({ period: p, values: closes1h });
  });

  const lastClose1h = closes1h[closes1h.length - 1];
  const emaAbove1h = EMA_STACK.every((p) => {
    const arr = emaArr1h[p];
    return arr && arr.length > 0 && lastClose1h > arr.slice(-1)[0];
  });
  const emaBelow1h = EMA_STACK.every((p) => {
    const arr = emaArr1h[p];
    return arr && arr.length > 0 && lastClose1h < arr.slice(-1)[0];
  });

  // 1H structure check (last 5 candles)
  const last5 = closes1h.slice(-6);
  const hhhl = last5.every((c, i, arr) => (i === 0 ? true : c > arr[i - 1]));
  const lllh = last5.every((c, i, arr) => (i === 0 ? true : c < arr[i - 1]));

  // EMA20 slope on 1H
  const ema20 = emaArr1h[20];
  const slope20 = ema20.slice(-1)[0] - ema20.slice(-2)[0];
  const bullishMomentum = slope20 > 0;
  const bearishMomentum = slope20 < 0;

  const bullishLayers = [emaAbove1h, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers = [emaBelow1h, lllh, bearishMomentum].filter(Boolean).length;

  // 4H bias: use ema200 from 4h as directional bias only
  let bias = null;
  try {
    const closes4h = bias4h.map((c) => c.c);
    const ema200_4h = EMA.calculate({ period: 200, values: closes4h }).slice(-1)[0];
    const last4hClose = closes4h[closes4h.length - 1];
    bias = last4hClose > ema200_4h ? 'bull' : 'bear';
  } catch (e) {
    bias = null;
  }

  if (bullishLayers >= 2) return { trend: "bull", bias };
  if (bearishLayers >= 2) return { trend: "bear", bias };
  return { trend: "invalid", reason: "1H layers not aligned", bias };
}

// ---------- HTF OB/FVG detection adapted for 1H ----------
function detectOBFVG(candles, polarity = "bull") {
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const closes = candles.map((c) => c.c);
  const opens = candles.map((c) => c.o);
  const vols = candles.map((c) => c.v);

  if (closes.length < ATR_PERIOD + 2) return null;
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const lastATR = atrArr.slice(-1)[0];

  const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-ATR_PERIOD).length);

  for (let i = candles.length - 2; i >= 1; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    if (body > lastATR * 0.9 && volStrong) { // slightly relaxed body > ATR
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

// ---------- Liquidity sweep detector ----------
function detectLiquiditySweep(candles, polarity = 'bull') {
  // look for quick wick sweeps beyond local structure then reclaim
  const recent = candles.slice(-12);
  for (let i = recent.length - 3; i >= 2; i--) {
    const c = recent[i];
    const prev = recent[i - 1];
    if (polarity === 'bull') {
      const swept = c.l < prev.l && prev.l < recent[i - 2].l;
      const reclaimed = recent.slice(i + 1).some(x => x.c > c.o);
      if (swept && reclaimed) return true;
    } else {
      const swept = c.h > prev.h && prev.h > recent[i - 2].h;
      const reclaimed = recent.slice(i + 1).some(x => x.c < c.o);
      if (swept && reclaimed) return true;
    }
  }
  return false;
}

// ---------- VALIDATE RETEST (tightened for ETH) ----------
function validateRetest(intraday, zone, polarity = "bull") {
  const lookback = 8; // ETH quicker — shorter lookback
  const c = intraday;
  for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
    const candle = c[i];
    const touched = candle.h >= zone.min && candle.l <= zone.max;
    if (!touched) continue;
    if (polarity === "bear") {
      const upperWick = candle.h - Math.max(candle.o, candle.c);
      const rejected = upperWick > 0.45 * (candle.h - candle.l) && candle.c < candle.o;
      if (rejected) return { index: i, candle };
    } else {
      const lowerWick = Math.min(candle.o, candle.c) - candle.l;
      const rejected = lowerWick > 0.45 * (candle.h - candle.l) && candle.c > candle.o;
      if (rejected) return { index: i, candle };
    }
  }
  return null;
}

// ---------- COMPUTE BUY/SELL ZONE (tighter pads) ----------
function computeBuyZone(intraday, trend) {
  const ob = detectOBFVG(intraday, "bull");
  if (!ob) return null;

  const highs = intraday.map((c) => c.h);
  const lows = intraday.map((c) => c.l);
  const closes = intraday.map((c) => c.c);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atr = atrArr.slice(-1)[0];

  const zoneMin = ob.obLow - ZONE_ATR_PAD.min * atr;
  const zoneMax = ob.obHigh + ZONE_ATR_PAD.max * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  // quick liquidity sweep check — accept earlier reclaim entries
  const sweep = detectLiquiditySweep(intraday, 'bull');
  const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, 'bull');

  return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false };
}

function computeSellZone(intraday, trend) {
  const ob = detectOBFVG(intraday, "bear");
  if (!ob) return null;

  const highs = intraday.map((c) => c.h);
  const lows = intraday.map((c) => c.l);
  const closes = intraday.map((c) => c.c);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atr = atrArr.slice(-1)[0];

  const zoneMin = ob.obLow - ZONE_ATR_PAD.min * atr;
  const zoneMax = ob.obHigh + ZONE_ATR_PAD.max * atr;
  const midpoint = (zoneMin + zoneMax) / 2;

  const sweep = detectLiquiditySweep(intraday, 'bear');
  const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, 'bear');

  return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false };
}

// ---------- SL/TP calculation (ATR-adaptive) ----------
function computeSLTP(zone, trend, intraday) {
  if (!zone) return null;
  // SL tighter: place just beyond zone edge + small ATR fraction
  const highs = intraday.map((c) => c.h);
  const lows = intraday.map((c) => c.l);
  const closes = intraday.map((c) => c.c);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const atr = atrArr.slice(-1)[0];

  const sl = trend === "bull" ? zone.min - 0.05 * atr : zone.max + 0.05 * atr;
  const risk = trend === "bull" ? zone.midpoint - sl : sl - zone.midpoint;

  // adaptive targets: use measured move multiples but cap to realistic ETH ranges
  return {
    sl,
    tp1: trend === "bull" ? zone.midpoint + 1 * risk : zone.midpoint - 1 * risk,
    tp2: trend === "bull" ? zone.midpoint + 2 * risk : zone.midpoint - 2 * risk,
    tp3: trend === "bull" ? zone.midpoint + 3 * risk : zone.midpoint - 3 * risk,
    risk,
  };
}

// ---------- CHOP detection (ETH tuned) ----------
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
  // ETH in chop needs stricter rejection of tiny bodies
  return avgBody < 0.45 * atrAvg;
}

// ---------- TIME FILTER ----------
function isInSniperWindow(ts = Date.now()) {
  if (!SNIPER_WINDOW_STRICT) return true; // allow frequent checks for ETH
  const hourUTC = new Date(ts).getUTCHours();
  return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ---------- TELEGRAM ----------
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

function fmt(n) {
  if (typeof n !== "number") return String(n);
  if (n >= 1000) return n.toFixed(2);
  return n.toFixed(6);
}

function buildZoneMessage({ symbol, trend, zone, sltp, label, note, origin }) {
  const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  let msg = `*CTWL-Pro ETH Alert*\n`;
  msg += `\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n`;
  msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
  msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
  if (zone.retest) msg += `*Retest observed:* yes\n`;
  if (zone.sweep) msg += `*Liquidity sweep observed:* yes\n`;
  if (note) msg += `*Note:* ${note}\n`;
  if (sltp) {
    msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n`;
    msg += `*Estimated risk:* ${fmt(sltp.risk)}\n`;
  }
  if (label) msg += `\n_${label}_\n`;
  msg += `\n_Source: CTWL-Pro ETH (1H-dominant)_`;
  return msg;
}

// ---------- MAIN RUNNER ----------
export async function runETH() {
  try {
    const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
    const intraday1h = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 300);
    const bias4h = await fetchCandles(SYMBOL, TIMEFRAMES.bias, 200);

    if (isChop(daily)) {
      console.log("[ETH] Market in chop (daily) — skipping zones.");
      return;
    }

    if (!isInSniperWindow(Date.now())) {
      console.log("[ETH] Outside sniper entry window — skipping.");
      return;
    }

    const trendObj = detectTrend(intraday1h, bias4h);
    const trend = trendObj.trend;
    const bias = trendObj.bias;

    if (trend === "invalid") {
      console.log("[ETH] Trend invalid:", trendObj.reason);
      return;
    }

    // If bias exists, prefer signals that align with bias. If bias contradicts 1H trend, downweight strength.
    const biasMismatch = bias && bias !== trend;

    if (trend === "bull") {
      const zone = computeBuyZone(intraday1h, trend);
      const sltp = computeSLTP(zone, trend, intraday1h);
      if (!zone) {
        console.log("[ETH] No valid buy origin/OB found — waiting for impulse.");
      } else {
        // if bias mismatches, label as "contested" and require sweep or retest to be true
        const contested = biasMismatch && !zone.sweep && !zone.retest;
        if (contested) {
          console.log("[ETH] Buy zone found but contested by 4H bias — skipping until confirmation.");
          return;
        }

        console.log("=== CTWL-Pro ETH BUY OUTPUT ===");
        console.log({ symbol: SYMBOL, trend, bias, zone, sltp });
        const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label: "VALID BUY ZONE", note: contested ? 'Contested by 4H bias' : undefined });
        await sendTelegramMessage(msg);
      }
    } else if (trend === "bear") {
      const zone = computeSellZone(intraday1h, trend);
      const sltp = computeSLTP(zone, trend, intraday1h);
      if (!zone) {
        console.log("[ETH] No valid sell origin/OB found — measuring continues.");
      } else {
        const contested = biasMismatch && !zone.sweep && !zone.retest;
        if (contested) {
          console.log("[ETH] Sell zone found but contested by 4H bias — skipping until confirmation.");
          return;
        }
        console.log("=== CTWL-Pro ETH SELL OUTPUT ===");
        console.log({ symbol: SYMBOL, trend, bias, zone, sltp });
        const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label: zone.retest ? "VALID SELL ZONE (retest observed)" : "VALID SELL ZONE" });
        await sendTelegramMessage(msg);
      }
    } else {
      console.log("[ETH] Unhandled trend state:", trend);
    }
  } catch (err) {
    console.error("CTWL-Pro ETH ERROR:", err.message || err);
    try {
      await sendTelegramMessage(`CTWL-Pro ETH ERROR: ${err.message || JSON.stringify(err)}`);
    } catch (e) {
      // swallow
    }
  }
}
