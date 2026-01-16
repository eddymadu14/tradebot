import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// =====================================================
// CTWL-XMR PRO
// Structural • Compression • Acceptance Engine
// =====================================================

// ---------------- CONFIG ----------------
const SYMBOL = "XMR/USDT";
const ASSET_PROFILE = "XMR";

const TIMEFRAMES = {
  exec: "4h",
  confirm: "1h",
  bias: "1d",
};

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];

const ZONE_ATR_MULT = 0.6;
const IMPULSE_VOL_FACTOR = 1.05;

const MIN_STRENGTH = 1.6;
const MAX_ZONE_AGE = 24; // 4H candles ≈ 4 days

const COMPRESSION_RATIO = 0.75;

// ---------------- TELEGRAM ----------------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ---------------- EXCHANGE ----------------
const exchange = new ccxt.binance({
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "spot" },
});

// ---------------- UTILS ----------------
async function safeFetch(method, ...args) {
  for (let i = 1; i <= 4; i++) {
    try {
      return await method(...args);
    } catch {
      if (i === 4) throw new Error("Fetch failed");
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

async function fetchCandles(tf, limit = 500) {
  const raw = await safeFetch(
    exchange.fetchOHLCV.bind(exchange),
    SYMBOL,
    tf,
    undefined,
    limit
  );
  return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// =====================================================
// 1. ATR COMPRESSION (MANDATORY GATE)
// =====================================================
function isCompressed(candles) {
  const atr = ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period: ATR_PERIOD,
  });

  if (atr.length < 20) return false;

  const curr = atr.at(-1);
  const avg = atr.slice(-20).reduce((a, b) => a + b, 0) / 20;
  return curr <= avg * COMPRESSION_RATIO;
}

// =====================================================
// 2. TREND + BIAS (HTF DOMINANT)
// =====================================================
function detectTrend(exec, biasTF) {
  const closes = exec.map(c => c.c);
  if (closes.length < 200) return { trend: "invalid" };

  const ema = {};
  EMA_STACK.forEach(p => {
    ema[p] = EMA.calculate({ period: p, values: closes }).at(-1);
  });

  const last = closes.at(-1);
  const bull = EMA_STACK.every(p => last > ema[p]);
  const bear = EMA_STACK.every(p => last < ema[p]);

  let bias = null;
  try {
    const dCloses = biasTF.map(c => c.c);
    const ema200 = EMA.calculate({ period: 200, values: dCloses }).at(-1);
    bias = dCloses.at(-1) > ema200 ? "bull" : "bear";
  } catch {}

  if (bull) return { trend: "bull", bias };
  if (bear) return { trend: "bear", bias };
  return { trend: "invalid", bias };
}

// =====================================================
// 3. ORDERBLOCK (PERSISTENCE-BASED)
// =====================================================
function detectOB(candles, side) {
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const opens = candles.map(c => c.o);
  const vols = candles.map(c => c.v);

  const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD }).at(-1);
  const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;

  for (let i = candles.length - 4; i >= 2; i--) {
    const body = Math.abs(closes[i] - opens[i]);
    const persistence =
      Math.abs(closes[i + 1] - closes[i]) < atr &&
      Math.abs(closes[i + 2] - closes[i + 1]) < atr;

    if (body >= atr * 0.6 && vols[i] >= volAvg * IMPULSE_VOL_FACTOR && persistence) {
      if (side === "bull" && closes[i] > opens[i])
        return { low: lows[i], high: highs[i], strength: body / atr, index: i };
      if (side === "bear" && closes[i] < opens[i])
        return { low: lows[i], high: highs[i], strength: body / atr, index: i };
    }
  }
  return null;
}

// =====================================================
// 4. ZONE + AGING
// =====================================================
function buildZone(exec, side) {
  const ob = detectOB(exec, side);
  if (!ob) return null;

  const atr = ATR.calculate({
    high: exec.map(c => c.h),
    low: exec.map(c => c.l),
    close: exec.map(c => c.c),
    period: ATR_PERIOD,
  }).at(-1);

  const min = ob.low - ZONE_ATR_MULT * atr;
  const max = ob.high + ZONE_ATR_MULT * atr;

  return {
    min,
    max,
    midpoint: (min + max) / 2,
    strength: ob.strength,
    age: exec.length - ob.index,
  };
}

// =====================================================
// 5. HTF RETEST / ACCEPTANCE
// =====================================================
function validateAcceptance(exec, zone, side) {
  const recent = exec.slice(-3);

  let accepted = 0;
  for (const c of recent) {
    const touched = c.h >= zone.min && c.l <= zone.max;
    if (!touched) continue;

    if (side === "bull" && c.c > c.o) accepted++;
    if (side === "bear" && c.c < c.o) accepted++;
  }

  return accepted >= 2;
}

// =====================================================
// 6. LIQUIDITY SWEEP (CONTEXT ONLY)
// =====================================================
function detectSweep(candles, side) {
  const r = candles.slice(-10);
  for (let i = 2; i < r.length - 1; i++) {
    if (
      side === "bull" &&
      r[i].l < r[i - 1].l &&
      r[i + 1].c > r[i].o
    ) return true;

    if (
      side === "bear" &&
      r[i].h > r[i - 1].h &&
      r[i + 1].c < r[i].o
    ) return true;
  }
  return false;
}

// =====================================================
// 7. CHOP FILTER
// =====================================================
function isChop(candles) {
  const bodies = candles.slice(-8).map(c => Math.abs(c.c - c.o));
  const atr = ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period: ATR_PERIOD,
  }).at(-1);

  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  return avgBody < atr * 0.4;
}

// =====================================================
// 8. COMPOSITE STRENGTH
// =====================================================
function scoreStrength(zone, accepted, sweep, biasAlign) {
  let s = zone.strength * 0.5;
  if (accepted) s += 0.6;
  if (biasAlign) s += 0.3;
  if (sweep) s += 0.2;
  return s;
}

// =====================================================
// 9. SL / TP
// =====================================================
function computeSLTP(zone, trend, candles) {
  const atr = ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period: ATR_PERIOD,
  }).at(-1);

  const sl = trend === "bull"
    ? zone.min - 0.4 * atr
    : zone.max + 0.4 * atr;

  return {
    sl,
    tp1: trend === "bull" ? zone.midpoint + atr : zone.midpoint - atr,
    tp2: trend === "bull" ? zone.midpoint + 2 * atr : zone.midpoint - 2 * atr,
    tp3: trend === "bull" ? zone.midpoint + 3 * atr : zone.midpoint - 3 * atr,
  };
}

// =====================================================
// 10. TELEGRAM
// =====================================================
async function sendTG(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "Markdown" }),
  });
}

// =====================================================
// 11. MAIN RUNNER
// =====================================================
export async function runCTWL_XMR() {
  const [exec, confirm, biasTF] = await Promise.all([
    fetchCandles(TIMEFRAMES.exec),
    fetchCandles(TIMEFRAMES.confirm),
    fetchCandles(TIMEFRAMES.bias),
  ]);

  if (!isCompressed(exec)) return;
  if (isChop(exec)) return;

  const { trend, bias } = detectTrend(exec, biasTF);
  if (trend === "invalid") return;

  const zone = buildZone(exec, trend);
  if (!zone || zone.age > MAX_ZONE_AGE) return;

  const accepted = validateAcceptance(exec, zone, trend);
  if (!accepted) return;

  const sweep = detectSweep(exec, trend);
  const strength = scoreStrength(zone, accepted, sweep, bias === trend);

  if (strength < MIN_STRENGTH) return;

  const sltp = computeSLTP(zone, trend, exec);

  await sendTG(
`*CTWL-XMR ALERT*
Symbol: ${SYMBOL}
Trend: ${trend.toUpperCase()}
Bias: ${bias || "n/a"}

Zone: ${zone.min.toFixed(2)} — ${zone.max.toFixed(2)}
Strength: ${strength.toFixed(2)}

SL: ${sltp.sl.toFixed(2)}
TP1: ${sltp.tp1.toFixed(2)}
TP2: ${sltp.tp2.toFixed(2)}
TP3: ${sltp.tp3.toFixed(2)}

_Source: CTWL-XMR Pro_`
  );
}
