import ccxt from "ccxt";
import { EMA, ATR, SMA } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// ==========================================================================
// CONFIG
// ==========================================================================
const SYMBOL = "BTC/USDT";
const EXCHANGE = new ccxt.binance({ enableRateLimit: true });

const TIMEFRAMES = {
HTF1: "1d",
HTF2: "4h",
EXEC: "1h",
};

const ENTRY_WINDOWS_UTC = [0, 6, 12, 18]; // ultra strict sniper windows

// ==========================================================================
// TELEGRAM SENDER
// ==========================================================================
async function sendTelegram(msg) {
const URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
try {
await fetch(URL, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
chat_id: process.env.TELEGRAM_CHAT_ID,
text: msg,
parse_mode: "Markdown"
})
});
} catch (err) {
console.error("TELEGRAM SEND FAILED:", err.message);
}
}

// ==========================================================================
// UTILITY
// ==========================================================================
async function candles(tf, limit = 200) {
return await EXCHANGE.fetchOHLCV(SYMBOL, tf, undefined, limit);
}

function mapCandles(raw) {
return raw.map(c => ({
time: c[0],
open: c[1],
high: c[2],
low: c[3],
close: c[4],
volume: c[5]
}));
}

// ==========================================================================
// INDICATORS
// ==========================================================================
function atr(candles, period = 14) {
return ATR.calculate({
period,
high: candles.map(c => c.high),
low: candles.map(c => c.low),
close: candles.map(c => c.close)
});
}

function ema(candles, period) {
return EMA.calculate({ period, values: candles.map(c => c.close) });
}

function sma(values, period) {
return SMA.calculate({ period, values });
}

// ==========================================================================
// STRICT IMPULSE VALIDATION
// ==========================================================================
function isStrictImpulse(prev, candle, atrValue, volMA) {
const body = Math.abs(candle.close - candle.open);
const wickUp = candle.high - Math.max(candle.close, candle.open);
const wickDown = Math.min(candle.close, candle.open) - candle.low;

const bullish = candle.close > candle.open;
const wickInDir = bullish ? wickUp : wickDown;
const wickAgainst = bullish ? wickDown : wickUp;

return (
body > 1.8 * atrValue &&
candle.volume > 2 * volMA &&
wickInDir <= 0.25 * (candle.high - candle.low) &&
wickAgainst >= 0.30 * (candle.high - candle.low)
);
}

// ==========================================================================
// SWEEP DETECTION
// ==========================================================================
function detectSweep(candles) {
const n = candles.length;
const a = candles[n - 1], b = candles[n - 2], c = candles[n - 3];

if (a.high > b.high && a.high > c.high && a.close < a.open)
return { type: "sweep_high", level: a.high };
if (a.low < b.low && a.low < c.low && a.close > a.open)
return { type: "sweep_low", level: a.low };
return null;
}

// ==========================================================================
// ORDER BLOCK DETECTOR
// ==========================================================================
function detectOrderBlock(candles, direction, atrValue) {
const last = candles[candles.length - 2];
if (direction === "BUY" && last.open > last.close) {
return { type: "BULLISH", low: last.low, high: last.high + atrValue * 0.4 };
}
if (direction === "SELL" && last.close > last.open) {
return { type: "BEARISH", low: last.low - atrValue * 0.4, high: last.high };
}
return null;
}

// ==========================================================================
// FVG DETECTION
// ==========================================================================
function detectFVG(c1, c2, c3) {
if (c1.high < c3.low) return { start: c1.high, end: c3.low, type: "BULLISH" };
if (c1.low > c3.high) return { start: c3.high, end: c1.low, type: "BEARISH" };
return null;
}

// ==========================================================================
// HTF BIAS
// ==========================================================================
function determineHTFBias(D, H4) {
const dailyEMA = ema(D, 50);
const h4EMA = ema(H4, 50);

const dailyTrend = D[D.length - 1].close > dailyEMA[dailyEMA.length - 1] ? "BUY" : "SELL";
const h4Trend = H4[H4.length - 1].close > h4EMA[h4EMA.length - 1] ? "BUY" : "SELL";

return dailyTrend === h4Trend ? dailyTrend : null;
}

// ==========================================================================
// WINDOW CHECK
// ==========================================================================
function inSniperWindow(timestamp) {
const hour = new Date(timestamp).getUTCHours();
return ENTRY_WINDOWS_UTC.includes(hour);
}

// ==========================================================================
// MAIN SNIPER
// ==========================================================================
export async function runBTC1h() {
try {
const D = mapCandles(await candles(TIMEFRAMES.HTF1));
const H4 = mapCandles(await candles(TIMEFRAMES.HTF2));
const H1 = mapCandles(await candles(TIMEFRAMES.EXEC));

console.log("Candles fetched:", { D: D.length, H4: H4.length, H1: H1.length });

const bias = determineHTFBias(D, H4);
if (!bias) {
  console.log("No HTF alignment → No Tier A");
  return { ok: false, msg: "No HTF alignment → No Tier A" };
}

const atrArray = atr(H1);
const latestATR = atrArray[atrArray.length - 1];
const volMA = sma(H1.map(c => c.volume), 20).slice(-1)[0];

const last = H1[H1.length - 1];
const prev = H1[H1.length - 2];

if (!isStrictImpulse(prev, last, latestATR, volMA)) {
  console.log("Impulse not strict enough → No Tier A");
  return { ok: false, msg: "Impulse not strict enough → No Tier A" };
}

const sweep = detectSweep(H1);
if (!sweep) {
  console.log("No sweep → No Tier A");
  return { ok: false, msg: "No sweep → No Tier A" };
}

const OB = detectOrderBlock(H1, bias, latestATR);
if (!OB) {
  console.log("No strict OB → No Tier A");
  return { ok: false, msg: "No strict OB → No Tier A" };
}

const c1 = H1[H1.length - 3], c2 = H1[H1.length - 2], c3 = H1[H1.length - 1];
const FVG = detectFVG(c1, c2, c3);
if (!FVG) {
  console.log("No clean FVG → No Tier A");
  return { ok: false, msg: "No clean FVG → No Tier A" };
}

if (!inSniperWindow(last.time)) {
  console.log("Outside sniper window → No Tier A");
  return { ok: false, msg: "Outside sniper window → No Tier A" };
}

// Compute Buy/Sell Zones
const entryZone = { low: OB.low, high: OB.high };
const stopLoss = bias === "BUY" ? OB.low - latestATR * 0.5 : OB.high + latestATR * 0.5;
const takeProfit = bias === "BUY" ? last.close + (last.close - stopLoss) * 2 : last.close - (stopLoss - last.close) * 2;

const msg = 

`🔥 TIER A SIGNAL — BTC 1H 🔥

Direction: ${bias}
Entry Zone: ${entryZone.low.toFixed(2)} → ${entryZone.high.toFixed(2)}
Stop Loss: ${stopLoss.toFixed(2)}
Take Profit: ${takeProfit.toFixed(2)}
Sweep: ${sweep.type} @ ${sweep.level.toFixed(2)}
Order Block: ${OB.type} (${OB.low.toFixed(2)} → ${OB.high.toFixed(2)})
FVG: ${FVG.type} (${FVG.start.toFixed(2)} → ${FVG.end.toFixed(2)})
ATR: ${latestATR.toFixed(2)}
Time: ${new Date(last.time).toUTCString()}

Conditions: HTF aligned ✓ Strict Impulse ✓ Sweep ✓ Fresh OB ✓ Clean FVG ✓ Sniper Window ✓`;

console.log("Tier A Signal Generated → Sending Telegram...");
await sendTelegram(msg);

return {
  ok: true,
  tier: "A",
  type: bias,
  timestamp: last.time,
  sweep,
  orderBlock: OB,
  fvg: FVG,
  entryZone,
  stopLoss,
  takeProfit
};

} catch (err) {
console.error("runBTC1h ERROR:", err);
return { ok: false, error: err.message };
}
}
