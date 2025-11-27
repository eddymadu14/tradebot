import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ==========================
// CONFIGURATION
// ==========================
const TIMEFRAMES = { daily: "1d", intraday: "4h" };
const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.2; // tuned for SOL
const ENTRY_WINDOWS_UTC_SOL = [2, 6, 10, 14, 18, 22];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==========================
// FETCH CANDLES USING CCXT
// ==========================
async function fetchCandlesCCXT(symbol = "SOL/USDT", timeframe = "4h", limit = 200) {
const exchange = new ccxt.binance({ enableRateLimit: true });
const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
return ohlcv.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

// ==========================
// TREND DETECTION
// ==========================
function detectTrend(daily) {
const closes = daily.map(c => c.c);
if (closes.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough data" };

const emaArr = {};  
EMA_STACK.forEach(p => { emaArr[p] = EMA.calculate({ period: p, values: closes }); });  

const lastClose = closes[closes.length - 1];  
const lastEMA = EMA_STACK.reduce((acc, p) => acc && lastClose > emaArr[p].slice(-1)[0], true);  
const lastEMA_bear = EMA_STACK.reduce((acc, p) => acc && lastClose < emaArr[p].slice(-1)[0], true);  

const last5 = closes.slice(-6);  
const hhhl = last5.every((c, i, arr) => i === 0 ? true : c > arr[i-1]);  
const lllh = last5.every((c, i, arr) => i === 0 ? true : c < arr[i-1]);  

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

// ==========================
// OBFVG DETECTION
// ==========================
function detectOBFVG(candles, polarity = "bull") {
const highs = candles.map(c => c.h);
const lows = candles.map(c => c.l);
const closes = candles.map(c => c.c);
const opens = candles.map(c => c.o);
const vols = candles.map(c => c.v || Math.abs(c.c - c.o));

if (closes.length < ATR_PERIOD + 2) return null;  

const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });  
const lastATR = atrArr.slice(-1)[0];  
const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;  

for (let i = candles.length - 2; i >= 1; i--) {  
    const body = Math.abs(closes[i] - opens[i]);  
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];  
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];  
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;  

    if (body > lastATR && volStrong) {  
        if (polarity === "bull" && isBullish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };  
        if (polarity === "bear" && isBearish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };  
    }  
}  
return null;  

}

// ==========================
// RETEST VALIDATION
// ==========================
function validateRetest(intraday, zone, polarity = "bull") {
const lookback = 10;
const c = intraday;
for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
const candle = c[i];
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

// ==========================
// BUY/SELL ZONE COMPUTATION
// ==========================
function computeBuyZone(daily, intraday, trend) {
const ob = detectOBFVG(intraday, "bull");
if (!ob) return null;

const highs = intraday.map(c => c.h);  
const lows = intraday.map(c => c.l);  
const closes = intraday.map(c => c.c);  
const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD }).slice(-1)[0];  

const zoneMin = ob.obLow - 0.2 * atr;  
const zoneMax = ob.obHigh + 0.1 * atr;  
const midpoint = (zoneMin + zoneMax) / 2;  

const origin = intraday[ob.originIndex];  
const last = intraday[intraday.length - 1];  
if (last.o < origin.c && last.c > origin.o) {  
    return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, note: "origin overlap suspicious" };  
}  

return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength };  

}

function computeSellZone(daily, intraday, trend) {
const ob = detectOBFVG(intraday, "bear");
if (!ob) return null;

const highs = intraday.map(c => c.h);  
const lows = intraday.map(c => c.l);  
const closes = intraday.map(c => c.c);  
const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD }).slice(-1)[0];  

const zoneMin = ob.obLow - 0.1 * atr;  
const zoneMax = ob.obHigh + 0.25 * atr;  
const midpoint = (zoneMin + zoneMax) / 2;  

const origin = intraday[ob.originIndex];  
const subsequent = intraday.slice(ob.originIndex + 1);  
const invalidatingSubsequent = subsequent.some(c => c.h > origin.h + atr * 0.25);  
if (invalidatingSubsequent) return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, note: "origin may be invalidated by later HH" };  

const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, "bear");  
}

return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, retest: !!retest };  

}

// ==========================
// SL / TP CALCULATION
// ==========================
function computeSLTP(zone, trend) {
if (!zone) return null;
const sl = trend === "bull" ? zone.min * 0.995 : zone.max * 1.005;
const risk = trend === "bull" ? zone.midpoint - sl : sl - zone.midpoint;
return {
sl,
tp1: trend === "bull" ? zone.midpoint + risk : zone.midpoint - risk,
tp2: trend === "bull" ? zone.midpoint + 2 * risk : zone.midpoint - 2 * risk,
tp3: trend === "bull" ? zone.midpoint + 3 * risk : zone.midpoint - 3 * risk,
risk
};
}

// ==========================
// CHOP DETECTION
// ==========================
function isChop(candles) {
const highs = candles.map(c => c.h);
const lows = candles.map(c => c.l);
const closes = candles.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const last8 = atrArr.slice(-6);
if (last8.length < 6) return false;
const avgBody = candles.slice(-6).map(c => Math.abs(c.c - c.o)).reduce((a, b) => a + b, 0) / 6;
const atrAvg = last8.reduce((a, b) => a + b, 0) / 6;
return avgBody < 0.5 * atrAvg;
}

// ==========================
// SNIPER WINDOW CHECK
// ==========================
function isInSniperWindow(ts = Date.now()) {
const hourUTC = new Date(ts).getUTCHours();
return ENTRY_WINDOWS_UTC_SOL.includes(hourUTC);
}

// ==========================
// TELEGRAM HELPER
// ==========================
async function sendTelegramMessage(text) {
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
const url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage";
await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }) });
}

function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : n.toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note }) {
const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
let msg = "*CTWL-Pro Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n";
msg += "*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n";
msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
if (zone.retest) msg += "Retest observed: yes\n";
if (note) msg += "*Note:* ${note}\n";
if (sltp) {
msg += "\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n";
}
if (label) msg += "\n_${label}_\n";
msg += `\nVolatility (ATR %): ${zone.strength ? (zone.strength * 100).toFixed(2) : "n/a"}%\n`;
msg += "\n_Source: CTWL-Pro (no lookahead checks enforced)_";
return msg;
}

// ==========================
// MAIN EXECUTION
// ==========================
export async function runCTWLProSOL() {
try {
const daily = await fetchCandlesCCXT("SOL/USDT", "1d", 400);
const intraday = await fetchCandlesCCXT("SOL/USDT", "4h", 200);

    if (isChop(daily)) { console.log("Market in chop — skipping zones."); return; }  
    const trendObj = detectTrend(daily);  
    if (trendObj.trend === "invalid") { console.log("Trend invalid:", trendObj.reason); return; }  
    if (!isInSniperWindow()) { console.log("Outside sniper window — skipping."); return; }  

    const trend = trendObj.trend;  
    let zone, sltp, label;  

    if (trend === "bull") {  
        zone = computeBuyZone(daily, intraday, trend);  
        sltp = computeSLTP(zone, "bull");  
        if (zone) {  
            label = "VALID BUY ZONE";  
            await sendTelegramMessage(buildZoneMessage({ symbol: "SOL", trend, zone, sltp, label }));  
        }  
    } else if (trend === "bear") {  
        zone = computeSellZone(daily, intraday
