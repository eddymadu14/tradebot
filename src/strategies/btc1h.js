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
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("TELEGRAM SEND FAILED:", err.message);
  }
}

// ==========================================================================
// UTILITY (bounded fetch + mapping)
// ==========================================================================
async function candles(tf, limit = 200) {
  // Always pass a limit to avoid huge responses
  return await EXCHANGE.fetchOHLCV(SYMBOL, tf, undefined, limit);
}

function mapCandles(raw) {
  // returns fresh small array of candle objects; keep it short lived
  return raw.map((c) => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
}

// ==========================================================================
// SMALL helpers that compute ONLY the last indicator value (reduce memory)
// ==========================================================================
function lastEMAValueFromCandles(candles, period) {
  // slice down to only what's necessary (period * 4 is arbitrary safe window)
  const needed = Math.max(period * 3, period + 50);
  const lastCloses = candles.map((c) => c.close).slice(-needed);
  const arr = EMA.calculate({ period, values: lastCloses });
  const val = arr.length ? arr[arr.length - 1] : null;
  // free arr and lastCloses as soon as possible (local scope, but explicit)
  return val;
}

function lastATRValueFromCandles(candles, period = 14) {
  const needed = Math.max(period * 3, period + 50);
  const slice = candles.slice(-needed);
  const high = slice.map((c) => c.high);
  const low = slice.map((c) => c.low);
  const close = slice.map((c) => c.close);
  const arr = ATR.calculate({ period, high, low, close });
  return arr.length ? arr[arr.length - 1] : null;
}

function lastSMAValue(values, period) {
  const needed = Math.max(period * 3, period + 50);
  const slice = values.slice(-needed);
  const arr = SMA.calculate({ period, values: slice });
  return arr.length ? arr[arr.length - 1] : null;
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

  // Defensive: ensure atrValue and volMA exist
  if (!atrValue || !volMA) return false;

  return (
    body > 1.8 * atrValue &&
    candle.volume > 2 * volMA &&
    wickInDir <= 0.25 * (candle.high - candle.low) &&
    wickAgainst >= 0.3 * (candle.high - candle.low)
  );
}

// ==========================================================================
// SWEEP DETECTION
// ==========================================================================
function detectSweep(candles) {
  const n = candles.length;
  if (n < 3) return null;
  const a = candles[n - 1],
    b = candles[n - 2],
    c = candles[n - 3];

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
  if (candles.length < 2) return null;
  const last = candles[candles.length - 2];
  if (!last) return null;
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
  if (!c1 || !c2 || !c3) return null;
  if (c1.high < c3.low) return { start: c1.high, end: c3.low, type: "BULLISH" };
  if (c1.low > c3.high) return { start: c3.high, end: c1.low, type: "BEARISH" };
  return null;
}

// ==========================================================================
// HTF BIAS - compute only final EMA values to avoid big arrays
// ==========================================================================
function determineHTFBias(D, H4) {
  const dailyEMA50 = lastEMAValueFromCandles(D, 50);
  const h4EMA50 = lastEMAValueFromCandles(H4, 50);

  if (dailyEMA50 == null || h4EMA50 == null) return null;

  const dailyClose = D[D.length - 1].close;
  const h4Close = H4[H4.length - 1].close;

  const dailyTrend = dailyClose > dailyEMA50 ? "BUY" : "SELL";
  const h4Trend = h4Close > h4EMA50 ? "BUY" : "SELL";

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
// MAIN SNIPER - memory-safe
// ==========================================================================
export async function runBTC1h() {
  try {
    // fetch bounded candle arrays (small, fixed limits)
    const rawD = await candles(TIMEFRAMES.HTF1, 200); // keep daily to 200
    const rawH4 = await candles(TIMEFRAMES.HTF2, 200); // keep 4h to 200
    const rawH1 = await candles(TIMEFRAMES.EXEC, 120); // H1 only need recent 120

    const D = mapCandles(rawD);
    const H4 = mapCandles(rawH4);
    const H1 = mapCandles(rawH1);

   
    // HTF bias (only last EMA values used)
    const bias = determineHTFBias(D, H4);
    if (!bias) {
      console.log("No HTF alignment → No Tier A");
      // explicit cleanup (help GC)
      // eslint-disable-next-line no-unused-expressions
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "No HTF alignment → No Tier A" };
    }

    // compute only last ATR and last vol SMA
    const latestATR = lastATRValueFromCandles(H1, 14);
    const volMA = lastSMAValue(H1.map((c) => c.volume), 20);

    // quick safety checks for indicator presence
    if (!latestATR || !volMA) {
      console.log("Indicators missing → abort");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "Missing indicators" };
    }

    const last = H1[H1.length - 1];
    const prev = H1[H1.length - 2];

    if (!isStrictImpulse(prev, last, latestATR, volMA)) {
      console.log("Impulse not strict enough → No Tier A");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "Impulse not strict enough → No Tier A" };
    }

    const sweep = detectSweep(H1);
    if (!sweep) {
      console.log("No sweep → No Tier A");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "No sweep → No Tier A" };
    }

    const OB = detectOrderBlock(H1, bias, latestATR);
    if (!OB) {
      console.log("No strict OB → No Tier A");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "No strict OB → No Tier A" };
    }

    const c1 = H1[H1.length - 3],
      c2 = H1[H1.length - 2],
      c3 = H1[H1.length - 1];
    const FVG = detectFVG(c1, c2, c3);
    if (!FVG) {
      console.log("No clean FVG → No Tier A");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "No clean FVG → No Tier A" };
    }

    if (!inSniperWindow(last.time)) {
      console.log("Outside sniper window → No Tier A");
      nullify([rawD, rawH4, rawH1, D, H4, H1]);
      return { ok: false, msg: "Outside sniper window → No Tier A" };
    }

    // Compute Buy/Sell Zones (numbers only)
    const entryZone = { low: OB.low, high: OB.high };
    const stopLoss =
      bias === "BUY" ? OB.low - latestATR * 0.5 : OB.high + latestATR * 0.5;
    const takeProfit =
      bias === "BUY"
        ? last.close + (last.close - stopLoss) * 2
        : last.close - (stopLoss - last.close) * 2;

    const msg = `🔥 TIER A SIGNAL — BTC 1H 🔥

Direction: ${bias}
Entry Zone: ${entryZone.low.toFixed(2)} → ${entryZone.high.toFixed(2)}
Stop Loss: ${stopLoss.toFixed(2)}
Take Profit: ${takeProfit.toFixed(2)}
Sweep: ${sweep.type} @ ${Number(sweep.level).toFixed(2)}
Order Block: ${OB.type} (${Number(OB.low).toFixed(2)} → ${Number(OB.high).toFixed(2)})
FVG: ${FVG.type} (${Number(FVG.start).toFixed(2)} → ${Number(FVG.end).toFixed(2)})
ATR: ${Number(latestATR).toFixed(2)}
Time: ${new Date(last.time).toUTCString()}

Conditions: HTF aligned ✓ Strict Impulse ✓ Sweep ✓ Fresh OB ✓ Clean FVG ✓ Sniper Window ✓`;

    console.log("Tier A Signal generated");
    await sendTelegram(msg);

    // Build the return object with only primitive / small values
    const result = {
      ok: true,
      tier: "A",
      type: bias,
      timestamp: last.time,
      sweep: { type: sweep.type, level: Number(sweep.level) },
      orderBlock: { type: OB.type, low: Number(OB.low), high: Number(OB.high) },
      fvg: { type: FVG.type, start: Number(FVG.start), end: Number(FVG.end) },
      entryZone: { low: Number(entryZone.low), high: Number(entryZone.high) },
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
    };

    // explicit cleanup so large objects can be garbage collected quickly
    nullify([rawD, rawH4, rawH1, D, H4, H1]);

    return result;
  } catch (err) {
    console.error("runBTC1h ERROR:", err);
    return { ok: false, error: err.message };
  }
}

// small helper to nullify arrays/objects (helps GC by releasing references)
function nullify(list) {
  try {
    for (let i = 0; i < list.length; i++) {
      // set to null if it's a var reference in the closure — this helps local references drop
      list[i] = null;
    }
    // if explicit GC is available (typically only when node started with --expose-gc)
    if (global && typeof global.gc === "function") {
      try {
        global.gc();
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }
}
