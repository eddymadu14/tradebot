import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// ========================================
// CONFIGURATION
// ========================================
const SYMBOL = "BTC/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "4h" };
const ATR_PERIOD = 14;
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
console.warn("[safeFetch] Attempt ${attempt} failed: ${err.message}");
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
// TREND DETECTION
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
// HYBRID SNIPER MODE: MICRO IMPULSE + STRUCTURE + OB
// ========================================
function detectHybridZone(intraday, polarity = "bear") {
const highs = intraday.map(c => c.h);
const lows = intraday.map(c => c.l);
const closes = intraday.map(c => c.c);
const opens = intraday.map(c => c.o);
const vols = intraday.map(c => c.v);

if (closes.length < ATR_PERIOD + 2) return null;
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const lastATR = atrArr.slice(-1)[0];

// iterate backwards to find latest displacement candle
for (let i = intraday.length - 2; i >= 1; i--) {
const body = Math.abs(closes[i] - opens[i]);
const volAvg = vols.slice(Math.max(0, i - ATR_PERIOD), i).reduce((a, b) => a + b, 0) / Math.max(1, ATR_PERIOD);
const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;

const bullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
const bearish = closes[i] < opens[i] && closes[i] < closes[i - 1];

if (polarity === "bull" && bullish && body > lastATR && volStrong) {
  const zoneMin = lows[i] - 0.25 * lastATR;
  const zoneMax = highs[i] + 0.1 * lastATR;
  const midpoint = (zoneMin + zoneMax) / 2;
  return { min: zoneMin, max: zoneMax, midpoint, originIndex: i, strength: body / lastATR, type: "bull" };
}

if (polarity === "bear" && bearish && body > lastATR && volStrong) {
  const zoneMin = lows[i] - 0.1 * lastATR;
  const zoneMax = highs[i] + 0.25 * lastATR;
  const midpoint = (zoneMin + zoneMax) / 2;
  return { min: zoneMin, max: zoneMax, midpoint, originIndex: i, strength: body / lastATR, type: "bear" };
}

}
return null;
}

// ========================================
// VALIDATE RETEST / REJECTION
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
// TELEGRAM NOTIFIER
// ========================================
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
console.warn("[telegram] attempt ${i} failed: ${err.message}");
if (i < 3) await new Promise(r => setTimeout(r, 1000 * i));
else console.error("[telegram] all attempts failed.");
}
}
}

// ========================================
// BUILD MESSAGE
// ========================================
function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : n.toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note, chopDetails, sniperWindow }) {
const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
let msg = `*CTWL-Pro Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n`;

if (!zone) msg += "_No zone available_\n";
else {
msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
if (zone.retest) msg += "*Retest observed:* yes\n";
if (note) msg += `*Note:* ${note}\n`;
if (sltp) msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
}

msg += `\n*Sniper window:* ${sniperWindow ? "YES" : "NO (use discretion)"}\n`;
if (chopDetails) {
msg += `*Chop:* ${chopDetails.isChop ? "YES" : "NO"}  (score ${chopDetails.chopScore}/3)\n`;
msg += `*Chop range:* ${fmt(chopDetails.lowest)} — ${fmt(chopDetails.highest)} (width ${fmt(chopDetails.rangeWidth)})\n`;
msg += `*Deviation:* ${chopDetails.deviation ? chopDetails.deviation.toFixed(3) : "n/a"} ATR\n`;
msg += `*Cond body<0.3ATR:* ${chopDetails.conditions.condBodyVsAtr ? "1" : "0"}  *Weak move:* ${chopDetails.conditions.condWeakMovement ? "1" : "0"}  *Overlap:* ${chopDetails.conditions.condOverlap ? "1" : "0"}\n`;
}

if (label) msg += `\n_${label}_\n`;
msg += `\n_Source: CTWL-Pro (Hybrid Sniper Mode — no lookahead checks enforced)_`;
return msg;
}

// ========================================
// MAIN EXECUTION
// ========================================
export async function runBTC() {
try {
const daily = await fetchCandles(SYMBOL, TIMEFRAMES.daily, 400);
const intraday = await fetchCandles(SYMBOL, TIMEFRAMES.intraday, 200);
const chopDetails = computeChopDetails(daily);

const trendObj = detectTrend(daily);
const trend = trendObj.trend;
if (trend === "invalid") { console.log("Trend invalid:", trendObj.reason); return; }

const sniperWindow = isInSniperWindow(Date.now());
let zone = null;

if (trend === "bull") zone = detectHybridZone(intraday, "bull");
else if (trend === "bear") zone = detectHybridZone(intraday, "bear");

if (!zone) { console.log("No fresh zone detected — waiting for impulse."); return; }

const sltp = computeSLTP(zone, trend);
let label = `${trend.toUpperCase()} ZONE — VALID`;

if (chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (OUTSIDE SNIPER WINDOW)`;
else if (chopDetails.isChop && sniperWindow) label = `${trend.toUpperCase()} ZONE — CHOP (SNIPER WINDOW OPEN, CAUTION)`;
else if (!chopDetails.isChop && !sniperWindow) label = `${trend.toUpperCase()} ZONE — OUTSIDE SNIPER WINDOW (manual discretion)`;

const retest = validateRetest(intraday, zone, trend === "bull" ? "bull" : "bear");
if (retest) zone.retest = true;

const msg = buildZoneMessage({ symbol: SYMBOL, trend, zone, sltp, label, note: zone.note, chopDetails, sniperWindow });
console.log("=== CTWL-Pro HYBRID SNIPER OUTPUT ===", label, zone);
await sendTelegramMessage(msg);

} catch (err) {
console.error("CTWL-Pro ERROR:", err.message || err);
try { await sendTelegramMessage("CTWL-Pro ERROR: ${err.message || JSON.stringify(err)}"); } catch (e) {}
}
}
