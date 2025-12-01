import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// =====================================================
// CTWL-Pro — ETH stand-alone sniper (1H-dominant, 4H bias)
// Fully integrated ATR-adaptive SL/TP, retains all logic
// =====================================================

// ----------------- CONFIG -----------------
const SYMBOL = "ETH/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "1h", bias: "4h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.2;
const ZONE_ATR_PAD = { min: 0.15, max: 0.15 };

const SNIPER_WINDOW_STRICT = false;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

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
console.warn("[safeFetch] Attempt ${attempt} failed: ${err.message}");
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

// ---------- TREND DETECTION ----------
function detectTrend(intraday1h, bias4h) {
if (!intraday1h.length) return { trend: "invalid", reason: "No 1H data" };

const closes1h = intraday1h.map(c => c.c);  
if (closes1h.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough 1H data" };  

const emaArr1h = {};  
EMA_STACK.forEach(p => { emaArr1h[p] = EMA.calculate({ period: p, values: closes1h }); });  

const lastClose1h = closes1h[closes1h.length - 1];  
const emaAbove1h = EMA_STACK.every(p => lastClose1h > emaArr1h[p].slice(-1)[0]);  
const emaBelow1h = EMA_STACK.every(p => lastClose1h < emaArr1h[p].slice(-1)[0]);  

const last5 = closes1h.slice(-6);  
const hhhl = last5.every((c, i, arr) => i === 0 ? true : c > arr[i - 1]);  
const lllh = last5.every((c, i, arr) => i === 0 ? true : c < arr[i - 1]);  

const ema20 = emaArr1h[20];  
const slope20 = ema20.slice(-1)[0] - ema20.slice(-2)[0];  
const bullishMomentum = slope20 > 0;  
const bearishMomentum = slope20 < 0;  

const bullishLayers = [emaAbove1h, hhhl, bullishMomentum].filter(Boolean).length;  
const bearishLayers = [emaBelow1h, lllh, bearishMomentum].filter(Boolean).length;  

let bias = null;  
try {  
    const closes4h = bias4h.map(c => c.c);  
    const ema200_4h = EMA.calculate({ period: 200, values: closes4h }).slice(-1)[0];  
    const last4hClose = closes4h[closes4h.length - 1];  
    bias = last4hClose > ema200_4h ? 'bull' : 'bear';  
} catch { bias = null; }  

if (bullishLayers >= 2) return { trend: "bull", bias };  
if (bearishLayers >= 2) return { trend: "bear", bias };  
return { trend: "invalid", reason: "1H layers not aligned", bias };  

}

// ---------- HTF OB/FVG detection ----------
function detectOBFVG(candles, polarity = "bull") {
if (candles.length < ATR_PERIOD + 2) return null;

const highs = candles.map(c => c.h);  
const lows = candles.map(c => c.l);  
const closes = candles.map(c => c.c);  
const opens = candles.map(c => c.o);  
const vols = candles.map(c => c.v);  

const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });  
const lastATR = atrArr.slice(-1)[0];  
const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-ATR_PERIOD).length);  

for (let i = candles.length - 2; i >= 1; i--) {  
    const body = Math.abs(closes[i] - opens[i]);  
    const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];  
    const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];  
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;  

    if (body > lastATR * 0.9 && volStrong) {  
        if (polarity === "bull" && isBullish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };  
        if (polarity === "bear" && isBearish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };  
    }  
}  
return null;  

}

// ---------- Liquidity sweep detector ----------
function detectLiquiditySweep(candles, polarity = 'bull') {
const recent = candles.slice(-12);
for (let i = recent.length - 3; i >= 2; i--) {
const c = recent[i], prev = recent[i - 1];
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

// ---------- Retest validation ----------
function validateRetest(intraday, zone, polarity = "bull") {
const lookback = 8;
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

// ---------- Buy/Sell zones ----------
function computeBuyZone(intraday) {
const ob = detectOBFVG(intraday, "bull");
if (!ob) return null;
const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0];
const zoneMin = ob.obLow - ZONE_ATR_PAD.min;
const zoneMax = ob.obHigh + ZONE_ATR_PAD.max;
const midpoint = (zoneMin + zoneMax) / 2;
const sweep = detectLiquiditySweep(intraday, 'bull');
const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, 'bull');
return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false };
}

function computeSellZone(intraday) {
const ob = detectOBFVG(intraday, "bear");
if (!ob) return null;
const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0];
const zoneMin = ob.obLow - ZONE_ATR_PAD.min;
const zoneMax = ob.obHigh + ZONE_ATR_PAD.max;
const midpoint = (zoneMin + zoneMax) / 2;
const sweep = detectLiquiditySweep(intraday, 'bear');
const retest = validateRetest(intraday, { min: zoneMin, max: zoneMax }, 'bear');
return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false };
}

// ---------- ATR-adaptive SL/TP ----------
function computeSLTP(zone, trend, intraday) {
if (!zone) return null;
const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const atr = atrArr.slice(-1)[0];
if (!atr) return null;

const sl = trend === "bull" ? zone.min - 0.05 * atr : zone.max + 0.05 * atr;  
const tp1 = trend === "bull" ? zone.midpoint + 1 * atr : zone.midpoint - 1 * atr;  
const tp2 = trend === "bull" ? zone.midpoint + 2 * atr : zone.midpoint - 2 * atr;  
const tp3 = trend === "bull" ? zone.midpoint + 3 * atr : zone.midpoint - 3 * atr;  
const risk = trend === "bull" ? zone.midpoint - sl : sl - zone.midpoint;  

return { sl, tp1, tp2, tp3, risk };  

}

// ---------- Chop detection ----------
function isChop(candles) {
if (candles.length < 8) return false;
const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c);
const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
const last8 = atrArr.slice(-8);
if (last8.length < 8) return false;
const atrAvg = last8.reduce((a, b) => a + b, 0) / 8;
const bodySizes = candles.slice(-8).map(c => Math.abs(c.c - c.o));
const avgBody = bodySizes.reduce((a, b) => a + b, 0) / 8;
return avgBody < 0.45 * atrAvg;
}

// ---------- Sniper window ----------
function isInSniperWindow(ts = Date.now()) {
if (!SNIPER_WINDOW_STRICT) return true;
const hourUTC = new Date(ts).getUTCHours();
return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ---------- Telegram ----------
async function sendTelegramMessage(text) {
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
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
if (i === 3) console.error("[telegram] all attempts failed.");
else await new Promise(r => setTimeout(r, 1000 * i));
}
}
}

function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? n.toFixed(2) : n.toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note }) {
const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
let msg = "*CTWL-Pro ETH Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n";
msg += "*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n";
msg += "*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n";
if (zone.retest) msg += "Retest observed: yes\n";
if (zone.sweep) msg += "Liquidity sweep observed: yes\n";
if (note) msg += "*Note:* ${note}\n";
if (sltp) msg += "\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n";
if (label) msg += "\n_${label}_\n";
msg += "\n_Source: CTWL-Pro ETH (1H-dominant)_";
return msg;
}

// ---------- MAIN RUNNER ----------
export async function runeth() {
try {
// 1. Verify sniper window
if (!isInSniperWindow()) return console.log("[${new Date().toISOString()}] Outside sniper window. Skipping...");

    // 2. Fetch OHLCV safely
    const [intraday1h, bias4h] = await Promise.all([
        fetchCandles(SYMBOL, TIMEFRAMES.intraday, 500),
        fetchCandles(SYMBOL, TIMEFRAMES.bias, 500)
    ]);

    // 3. Detect 1H trend and 4H bias
    const { trend, bias } = detectTrend(intraday1h, bias4h);
    if (trend === "invalid") return console.log(`[${new Date().toISOString()}] Trend invalid: Skipping.`);

    // 4. Compute zones based on OB/FVG
    let zone = null;
    if (trend === "bull") zone = computeBuyZone(intraday1h);
    if (trend === "bear") zone = computeSellZone(intraday1h);
    if (!zone) return console.log(`[${new Date().toISOString()}] No valid zone found.`);

    // 5. Chop check
    if (isChop(intraday1h)) return console.log(`[${new Date().toISOString()}] Market choppy. Skipping.`);

    // 6. Compute ATR-adaptive SL/TP
    const sltp = computeSLTP(zone, trend, intraday1h);
    if (!sltp) return console.log(`[${new Date().toISOString()}] SL/TP not computed. Skipping.`);

    // 7. Detect liquidity sweep / retest
    let note = null;
    if (zone.sweep) note = "Liquidity sweep detected";
    if (zone.retest) note = note ? note + " & retest observed" : "Retest observed";

    // 8. Determine price for current signal
    const price = intraday1h.slice(-1)[0].c;

    // 9. Build Telegram message
    const msg = buildZoneMessage({
        symbol: SYMBOL,
        trend,
        zone,
        sltp,
        label: bias ? `Bias: ${bias}` : null,
        note
    });

    // 10. Send Telegram alert
    await sendTelegramMessage(msg);

    // 11. Logging
    console.log(`[${new Date().toISOString()}] Signal sent. Trend: ${trend}, Price: ${fmt(price)}, SL: ${fmt(sltp.sl)}, TP1: ${fmt(sltp.tp1)}, TP2: ${fmt(sltp.tp2)}, TP3: ${fmt(sltp.tp3)}`);

} catch (err) {
    console.error(`[${new Date().toISOString()}] Error in runeth(): ${err.message}`);
}

}
