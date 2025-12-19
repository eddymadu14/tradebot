import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

/* ======================
   CONFIG
====================== */
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", htf: "4h", ltf: "1h" };
const EMA_STACK = [20, 50, 100, 200];
const ATR_PERIOD = 14;
const STOP_MULT = 0.5;
const TP_MULT = 3.0;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* ======================
   EXCHANGE
====================== */
const exchange = new ccxt.binance({
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "future" }
});

/* ======================
   SAFE FETCH
====================== */
async function safeFetch(method, ...args) {
  for (let i = 1; i <= 4; i++) {
    try {
      return await method(...args);
    } catch (e) {
      if (i === 4) throw e;
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

/* ======================
   CANDLES
====================== */
async function fetchCandles(symbol, tf, limit = 200) {
  const raw = await safeFetch(exchange.fetchOHLCV, symbol, tf, undefined, limit);
  return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

/* ======================
   TREND (DAILY)
====================== */
function detectTrend(candles) {
  const closes = candles.map(c => c.c);
  if (closes.length < 200) return "invalid";

  const ema = {};
  EMA_STACK.forEach(p => ema[p] = EMA.calculate({ period: p, values: closes }).slice(-1)[0]);

  const last = closes.at(-1);
  if (EMA_STACK.every(p => last > ema[p])) return "bull";
  if (EMA_STACK.every(p => last < ema[p])) return "bear";
  return "invalid";
}

/* ======================
   CHOP FILTER (4H)
====================== */
function isChop(candles) {
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  if (atr.length < 10) return true;

  const lastATR = atr.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const bodies = candles.slice(-8).map(c => Math.abs(c.c - c.o));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;

  return avgBody < 0.3 * lastATR;
}

/* ======================
   FVG DETECTION
====================== */
function detectFVG(candles, direction) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];

    if (direction === "bull" && c.l > a.h) {
      fvgs.push({ type: "bull", min: a.h, max: c.l, midpoint: (a.h + c.l) / 2, index: i });
    }
    if (direction === "bear" && c.h < a.l) {
      fvgs.push({ type: "bear", min: c.h, max: a.l, midpoint: (c.h + a.l) / 2, index: i });
    }
  }
  return fvgs;
}

/* ======================
   CTWL IMPULSE ZONE
====================== */
function detectImpulseZone(candles, trend) {
  const atr = ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period: ATR_PERIOD
  }).slice(-1)[0];

  for (let i = candles.length - 2; i >= 0; i--) {
    const c = candles[i];
    const body = Math.abs(c.c - c.o);
    if (body < atr) continue;

    return {
      min: trend === "bull" ? c.l : c.h,
      max: trend === "bull" ? c.h : c.l,
      midpoint: (c.h + c.l) / 2,
      atr
    };
  }
  return null;
}

/* ======================
   ENTRY WINDOW
====================== */
function inSniperWindow() {
  return ENTRY_WINDOWS_UTC.includes(new Date().getUTCHours());
}

/* ======================
   TELEGRAM
====================== */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return console.log(text);
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
  });
}

/* ======================
   RUN ENGINE
====================== */
export async function runBTCin(symbol = SYMBOL) {
  const daily = await fetchCandles(symbol, TIMEFRAMES.daily);
  const htf = await fetchCandles(symbol, TIMEFRAMES.htf);
  const ltf = await fetchCandles(symbol, TIMEFRAMES.ltf);

  const trend = detectTrend(daily);
  if (trend === "invalid") return;

  if (isChop(htf)) return;
  if (!inSniperWindow()) return;

  const zone = detectImpulseZone(htf, trend);
  if (!zone) return;

  const htfFVGs = detectFVG(htf, trend);
  const ltfFVGs = detectFVG(ltf, trend);
  if (!htfFVGs.length || !ltfFVGs.length) return;

  const lastPrice = ltf.at(-1).c;
  const activeHTF = htfFVGs.find(f => lastPrice >= f.min && lastPrice <= f.max);
  if (!activeHTF) return;

  const entryFVG = ltfFVGs.at(-1);
  if (entryFVG.midpoint < zone.min || entryFVG.midpoint > zone.max) return;

  const entry = entryFVG.midpoint;
  const sl = trend === "bull" ? entry - zone.atr * STOP_MULT : entry + zone.atr * STOP_MULT;
  const tp = trend === "bull" ? entry + zone.atr * TP_MULT : entry - zone.atr * TP_MULT;

  await sendTelegram(
`*CTWL–FVG Hybrid Alert*
*Symbol:* ${symbol}
*Trend:* ${trend.toUpperCase()}
*Entry:* ${entry.toFixed(2)}
*SL:* ${sl.toFixed(2)}
*TP:* ${tp.toFixed(2)}
*Model:* CTWL–FVG Hybrid`
  );
}
