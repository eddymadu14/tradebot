import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// =================== CONFIG ===================
const SYMBOL = "SOL/USDT";
const TIMEFRAMES = { daily: "1d", intraday4h: "4h", intraday1h: "1h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 2; // Strong impulse volume multiplier
const IMPULSE_ATR_MULTIPLIER = 1.5; // SOL-specific body threshold

// Sniper windows - UTC hours
const ENTRY_WINDOWS_UTC = [0, 6, 12, 18];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

const exchange = new ccxt.binance({
apiKey: BINANCE_API_KEY || undefined,
secret: BINANCE_SECRET || undefined,
enableRateLimit: true,
timeout: 30000,
options: { defaultType: "future" },
});

// =================== FETCH CANDLES ===================
async function safeFetch(exchangeInstance, method, ...args) {
const maxRetries = 4, baseDelay = 1500;
for (let attempt = 1; attempt <= maxRetries; attempt++) {
try { return await method.apply(exchangeInstance, args); }
catch (err) {
console.warn("[safeFetch] Attempt ${attempt} failed: ${err.message}");
if (attempt === maxRetries) throw err;
await new Promise(res => setTimeout(res, baseDelay * attempt));
}
}
}

async function fetchCandles(symbol, timeframe, limit = 500) {
const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// =================== TREND DETECTION ===================
function detectTrend(candles) {
const closes = candles.map(c => c.c);
if (closes.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough data" };
const emaArr = {};
EMA_STACK.forEach(p => emaArr[p] = EMA.calculate({ period: p, values: closes }));
const lastClose = closes[closes.length - 1];
const lastEMA = EMA_STACK.every(p => lastClose > emaArr[p].slice(-1)[0]);
const lastEMA_bear = EMA_STACK.every(p => lastClose < emaArr[p].slice(-1)[0]);
const last5 = closes.slice(-6);
const hhhl = last5.every((c, i, arr) => i === 0 ? true : c > arr[i - 1]);
const lllh = last5.every((c, i, arr) => i === 0 ? true : c < arr[i - 1]);
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

// =================== OB & FVG DETECTION ===================
function detectOBFVG(candles, polarity = "bull") {
const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c), opens = candles.map(c => c.o), vols = candles.map(c => c.v);
if (closes.length < ATR_PERIOD + 2) return null;
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const lastATR = atrArr.slice(-1)[0];
const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-ATR_PERIOD).length);

for (let i = candles.length - 2; i >= 1; i--) {
const body = Math.abs(closes[i] - opens[i]);
const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
if (body > lastATR * IMPULSE_ATR_MULTIPLIER && volStrong) {
if (polarity === "bull" && isBullish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };
if (polarity === "bear" && isBearish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };
}
}
return null;
}

// =================== RETEST VALIDATION ===================
function validateRetest(intraday, zone, polarity = "bull") {
const lookback = 10, c = intraday;
for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
const candle = c[i];
const touched = candle.h >= zone.min && candle.l <= zone.max;
if (!touched) continue;
if (polarity === "bear") {
const upperWick = candle.h - Math.max(candle.o, candle.c), body = Math.abs(candle.c - candle.o);
const rejected = upperWick > 0.4 * (candle.h - candle.l) && candle.c < candle.o;
if (rejected) return { index: i, candle };
} else {
const lowerWick = Math.min(candle.o, candle.c) - candle.l, body = Math.abs(candle.c - candle.o);
const rejected = lowerWick > 0.4 * (candle.h - candle.l) && candle.c > candle.o;
if (rejected) return { index: i, candle };
}
}
return null;
}

// =================== COMPUTE ZONES ===================
function computeBuyZone(daily, intraday, trend) {
const ob = detectOBFVG(intraday, "bull");
if (!ob) return null;
const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0];
const zoneMin = ob.obLow - 0.25 * atr;
const zoneMax = ob.obHigh + 0.1 * atr;
const midpoint = (zoneMin + zoneMax) / 2;
const origin = intraday[ob.originIndex], last = intraday[intraday.length - 1];
if (last.o < origin.c && last.c > origin.o) return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, note: "origin overlap suspicious" };
return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength };
}

function computeSellZone(daily, intraday, trend) {
const ob = detectOBFVG(intraday, "bear");
if (!ob) return null;
const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0];
const zoneMin = ob.obLow - 0.1 * atr, zoneMax = ob.obHigh + 0.25 * atr, midpoint = (zoneMin + zoneMax)/2;
const origin = intraday[ob.originIndex], subsequent = intraday.slice(ob.originIndex + 1);
const invalidatingSubsequent = subsequent.some(c => c.h > origin.h + atr * 0.25);
const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, "bear");
return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, retest: retest ? true : false, note: invalidatingSubsequent ? "origin may be invalidated" : undefined };
}

// =================== SL/TP ===================
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

// =================== CHOP DETECTION ===================
function isChop(candles) {
const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const last8 = atrArr.slice(-8); if (last8.length < 8) return false;
const atrAvg = last8.reduce((a,b)=>a+b,0)/8;
const bodySizes = candles.slice(-8).map(c => Math.abs(c.c - c.o));
const avgBody = bodySizes.reduce((a,b)=>a+b,0)/8;
return avgBody < 0.5 * atrAvg;
}

// =================== TIME FILTER ===================
function isInSniperWindow(ts = Date.now()) {
return ENTRY_WINDOWS_UTC.includes(new Date(ts).getUTCHours());
}

// =================== TELEGRAM ===================
async function sendTelegramMessage(text) {
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
for (let i=1;i<=3;i++){
try { const res = await fetch(url,{method:"POST", headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); const data = await res.json(); if (!data.ok) throw new Error(JSON.stringify(data)); return data; }
catch(err){ if(i===3) console.error("[telegram] all attempts failed."); else await new Promise(r=>setTimeout(r,1000*i)); }
}
}

// =================== MESSAGE FORMAT ===================
function fmt(n){return typeof n!=="number"?String(n):n>=1000?n.toFixed(2):n.toFixed(6);}
function buildZoneMessage({ symbol, trend, zone, sltp, label, note }){
const nowUTC = new Date().toISOString().replace("T"," ").replace("Z"," UTC");
let msg=`*CTWL-Pro Alert 1hr*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n*Strength:* ${zone.strength?zone.strength.toFixed(2):"n/a"}\n`;
if(zone.retest) msg+="*Retest observed:* yes\n"; if(note) msg+=`*Note:* ${note}\n`;
if(sltp) msg+=`\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
if(label) msg+=`\n_${label}_\n`;
msg+="\n_Source: CTWL-Pro (no lookahead checks enforced)_"; return msg;
}

// =================== MAIN EXECUTION ===================
export async function runSOL1h(){
try{
const daily = await fetchCandles(SYMBOL,TIMEFRAMES.daily,400);
const h4 = await fetchCandles(SYMBOL,TIMEFRAMES.intraday4h,200);
const h1 = await fetchCandles(SYMBOL,TIMEFRAMES.intraday1h,500);
if(isChop(daily)){ console.log("Market in chop — skipping zones."); return; }
const trendObj = detectTrend(daily); const trend = trendObj.trend;
if(trend==="invalid"){ console.log("Trend invalid:", trendObj.reason); return; }
if(!isInSniperWindow()) { console.log("Outside sniper window — skipping."); return; }
if(trend==="bull"){
const zone=computeBuyZone(daily,h1,trend);
const sltp=computeSLTP(zone,"bull");
if(!zone){ console.log("No valid buy origin/OB found — waiting for impulse."); return; }
const msg=buildZoneMessage({symbol:SYMBOL,trend,zone,sltp,label:"VALID BUY ZONE"});
console.log("=== CTWL-Pro BUY OUTPUT ==="); console.log({symbol:SYMBOL,trend,zone,sltp}); await sendTelegramMessage(msg);
} else if(trend==="bear"){
const zone=computeSellZone(daily,h1,trend);
const sltp=computeSLTP(zone,"bear");
if(!zone){ console.log("No valid sell origin/OB found — measuring continues."); return; }
const label=zone.retest?"VALID SELL ZONE (retest observed)":"VALID SELL ZONE (no retest)";
const msg=buildZoneMessage({symbol:SYMBOL,trend,zone,sltp,label,note:zone.note});
console.log("=== CTWL-Pro SELL OUTPUT ==="); console.log({symbol:SYMBOL,trend,zone,sltp,label}); await sendTelegramMessage(msg);
} else console.log("Unhandled trend state:",trend);
} catch(err){ console.error("CTWL-Pro ERROR:",err.message||err); try{ await sendTelegramMessage("CTWL-Pro ERROR: ${err.message||JSON.stringify(err)}");}catch(e){ } }
}
