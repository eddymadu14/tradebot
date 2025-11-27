import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();
// ========================================
// CONFIGURATION (secrets in .env)
// ========================================
const SYMBOL = "SUI/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h" };
const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.3;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
console.warn("Warning: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID should be set to receive alerts.");
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
// UTILITIES
// ========================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : parseFloat(n.toFixed(6)).toString());

// ========================================
// SAFE FETCH WITH RETRY
// ========================================
async function safeFetch(exchangeInstance, method, ...args) {
const maxRetries = 4;
const baseDelay = 1500;
for (let attempt = 1; attempt <= maxRetries; attempt++) {
try {
return await method.apply(exchangeInstance, args);
} catch (err) {
console.warn("[safeFetch] Attempt ${attempt} failed: ${err.message}");
if (attempt === maxRetries) throw err;
await sleep(baseDelay * attempt);
}
}
}

// ========================================
// FETCH CANDLES
// ========================================
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

const emaArr = {};
EMA_STACK.forEach((p) => {
try { emaArr[p] = EMA.calculate({ period: p, values: closes }); } catch { emaArr[p] = []; }
});

const lastClose = closes[closes.length - 1];
const lastEMA = EMA_STACK.every((p) => emaArr[p]?.length && lastClose > emaArr[p].slice(-1)[0]);
const lastEMA_bear = EMA_STACK.every((p) => emaArr[p]?.length && lastClose < emaArr[p].slice(-1)[0]);

const lastSlice = closes.slice(-4);
const hhhl = lastSlice.every((c, i, arr) => i === 0 || c > arr[i - 1]);
const lllh = lastSlice.every((c, i, arr) => i === 0 || c < arr[i - 1]);

const ema20 = emaArr[20] || [];
const slope20 = ema20.length >= 2 ? ema20.slice(-1)[0] - ema20.slice(-2)[0] : 0;
const bullishMomentum = slope20 > 0;
const bearishMomentum = slope20 < 0;

const bullishLayers = [lastEMA, hhhl, bullishMomentum].filter(Boolean).length;
const bearishLayers = [lastEMA_bear, lllh, bearishMomentum].filter(Boolean).length;

const ema200 = emaArr[200]?.slice(-1)[0] || null;

if (bullishLayers >= 2) return { trend: "bull", ema200 };
if (bearishLayers >= 2) return { trend: "bear", ema200 };
return { trend: "invalid", reason: "Layers not aligned" };
}

// ========================================
// OB/FVG DETECTION
// ========================================
function detectOBFVG(candles, polarity = "bull") {
if (candles.length < ATR_PERIOD + 2) return null;

const highs = candles.map((c) => c.h);
const lows = candles.map((c) => c.l);
const closes = candles.map((c) => c.c);
const opens = candles.map((c) => c.o);
const vols = candles.map((c) => c.v);

const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const lastATR = atrArr.slice(-1)[0];
const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;

for (let i = candles.length - 2; i >= 1; i--) {
const body = Math.abs(closes[i] - opens[i]);
const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
if (!lastATR || !volStrong) continue;

if ((polarity === "bull" && isBullish) || (polarity === "bear" && isBearish)) {  
  return { obLow: lows[i], obHigh: highs[i], originIndex: i, strength: body / lastATR, type: polarity };  
}  

}
return null;
}

// ========================================
// RETEST VALIDATION
// ========================================
function validateRetest(intraday, zone, polarity = "bull") {
const lookback = 10;
const c = intraday;
for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
const candle = c[i];
const touched = candle.h >= zone.min && candle.l <= zone.max;
if (!touched) continue;
const upperWick = candle.h - Math.max(candle.o, candle.c);
const lowerWick = Math.min(candle.o, candle.c) - candle.l;
if ((polarity === "bear" && upperWick > 0.33 * (candle.h - candle.l) && candle.c < candle.o) ||
(polarity === "bull" && lowerWick > 0.33 * (candle.h - candle.l) && candle.c > candle.o)) {
return { index: i, candle };
}
}
return null;
}

// ========================================
// BUY/SELL ZONE COMPUTATION
// ========================================
function computeZone(daily, intraday, trend) {
const polarity = trend === "bull" ? "bull" : "bear";
const ob = detectOBFVG(intraday, polarity);
if (!ob) return null;

const highs = intraday.map((c) => c.h);
const lows = intraday.map((c) => c.l);
const closes = intraday.map((c) => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0] || 0;

const zoneMin = polarity === "bull" ? ob.obLow - 0.2 * atr : ob.obLow - 0.06 * atr;
const zoneMax = polarity === "bull" ? ob.obHigh + 0.06 * atr : ob.obHigh + 0.2 * atr;
const midpoint = (zoneMin + zoneMax) / 2;

const origin = intraday[ob.originIndex];
const subsequent = origin ? intraday.slice(ob.originIndex + 1) : [];
const invalidatingSubsequent = origin && trend === "bear" ? subsequent.some((c) => c.h > origin.h + 0.25 * atr) : false;
const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, polarity);

const note = trend === "bull" && origin && intraday[intraday.length - 1].o < origin.c && intraday[intraday.length - 1].c > origin.o
? "origin overlap suspicious"
: invalidatingSubsequent ? "origin may be invalidated by later HH" : null;

return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, retest: retest ? true : false, note };
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
const atrArr = ATR.calculate({ high: candles.map(c => c.h), low: candles.map(c => c.l), close: candles.map(c => c.c), period: ATR_PERIOD });
const last8 = atrArr.slice(-8);
if (last8.length < 8) return false;
const atrAvg = last8.reduce((a, b) => a + b, 0) / 8;
const avgBody = candles.slice(-8).map(c => Math.abs(c.c - c.o)).reduce((a, b) => a + b, 0) / 8;
return avgBody < 0.35 * atrAvg;
}

// ========================================
// TELEGRAM MESSAGING
// ========================================
async function sendTelegramMessage(text) {
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || DRY_RUN) {
console.log("[telegram] Dry-run or missing token/chat — skipping send.");
return;
}
const url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage";
const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
for (let i = 1; i <= 3; i++) {
try {
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
const data = await res.json();
if (!data.ok) throw new Error(JSON.stringify(data));
return data;
} catch (err) {
console.warn("[telegram] attempt ${i} failed: ${err.message}");
if (i < 3) await sleep(1000 * i); else console.error("[telegram] all attempts failed.");
}
}
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runSUI() {
try { await exchange.loadMarkets(); } catch (e) { console.warn("Failed to load markets:", e.message); }

try {
const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);
if (!daily.length || !intraday.length) return console.error("Not enough data.");
if (isChop(daily)) return console.log("Market in chop — skipping.");

const trendObj = detectTrend(daily);  
if (trendObj.trend === "invalid") return console.log("Trend invalid:", trendObj.reason);  

const nowUTC = new Date().getUTCHours();  
if (!ENTRY_WINDOWS_UTC.includes(nowUTC)) return console.log("Outside sniper window.");  

const zone = computeZone(daily, intraday, trendObj.trend);  
if (!zone) return console.log(`No valid ${trendObj.trend} zone found.`);  
const sltp = computeSLTP(zone, trendObj.trend);  

const msg = `*CTWL-Pro Alert*\n\nSymbol: ${SYMBOL}\nTrend: ${trendObj.trend.toUpperCase()}\nZone: ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\nStrength: ${zone.strength.toFixed(2)}\n${zone.retest ? "*Retest observed: yes\n" : ""}${zone.note ? "*Note: " + zone.note + "\n" : ""}SL: ${fmt(sltp.sl)}\nTP1: ${fmt(sltp.tp1)} TP2: ${fmt(sltp.tp2)} TP3: ${fmt(sltp.tp3)}\nRisk: ${fmt(sltp.risk)}`;  
await sendTelegramMessage(msg);  

console.log("=== CTWL-Pro OUTPUT ===");  
console.log({ symbol: SYMBOL, trend: trendObj.trend, zone, sltp });  

} catch (err) {
console.error("CTWL-Pro ERROR:", err.message);
}
}

// ========================================
// SCHEDULER
// ========================================
