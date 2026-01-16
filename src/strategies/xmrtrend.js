import Binance from "binance-api-node";
import fetch from "node-fetch";

/* ================= CONFIG ================= */

const CONFIG = {
  SYMBOL: "XMRUSDT",

  TF_BIAS: "4h",
  TF_ENTRY: "1h",
  CANDLE_LIMIT: 300,

  EMA_FAST: 20,
  EMA_SLOW: 50,
  ATR_PERIOD: 14,
  RSI_PERIOD: 14,
  ADX_PERIOD: 14,

  MIN_ADX: 25,
  STRENGTH_THRESHOLD: 5,

  SL_ATR_MULT: 1.5,
  TP_ATR_MULT: 2.5,

  TELEGRAM_BOT_TOKEN: "YOUR_BOT_TOKEN",
  TELEGRAM_CHAT_ID: "YOUR_CHAT_ID"
};
const client = Binance.default
  ? Binance.default()
  : Binance();

/* ================= PURE JS INDICATORS ================= */

function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => (ema = v * k + ema * (1 - k)));
}

function ATR(highs, lows, closes, period) {
  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b) / period;
  const out = [atr];

  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out.push(atr);
  }
  return out;
}

function RSI(values, period) {
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    diff >= 0 ? gains += diff : losses -= diff;
  }

  let rs = gains / losses;
  let rsi = 100 - 100 / (1 + rs);
  const out = [rsi];

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      gains = (gains * (period - 1) + diff) / period;
      losses = (losses * (period - 1)) / period;
    } else {
      gains = (gains * (period - 1)) / period;
      losses = (losses * (period - 1) - diff) / period;
    }
    rs = gains / losses;
    rsi = 100 - 100 / (1 + rs);
    out.push(rsi);
  }
  return out;
}

function ADX(highs, lows, closes, period) {
  const plusDM = [], minusDM = [], tr = [];

  for (let i = 1; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);

    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const smooth = arr => {
    let sum = arr.slice(0, period).reduce((a, b) => a + b);
    const res = [sum];
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      res.push(sum);
    }
    return res;
  };

  const trS = smooth(tr);
  const pS = smooth(plusDM);
  const mS = smooth(minusDM);

  return trS.map((_, i) => {
    const pDI = 100 * (pS[i] / trS[i]);
    const mDI = 100 * (mS[i] / trS[i]);
    return 100 * Math.abs(pDI - mDI) / (pDI + mDI);
  });
}

/* ================= MARKET LOGIC ================= */

function detectRegime(c) {
  const adx = ADX(c.h, c.l, c.c, CONFIG.ADX_PERIOD).at(-1);
  if (adx < CONFIG.MIN_ADX) return "RANGE";
  return c.c.at(-1) > c.c[0] ? "BULL" : "BEAR";
}

function strengthScore(trend, c) {
  const rsi = RSI(c.c, CONFIG.RSI_PERIOD).at(-1);
  const emaFast = EMA(c.c, CONFIG.EMA_FAST).at(-1);
  const emaSlow = EMA(c.c, CONFIG.EMA_SLOW).at(-1);

  let score = 5;

  if (trend === "BULL") {
    if (emaFast > emaSlow) score += 2;
    if (rsi > 60) score += 2;
  } else {
    if (emaFast < emaSlow) score += 2;
    if (rsi < 40) score += 2;
  }

  return Math.min(score, 10);
}

function liquiditySweep(c, atr) {
  const last = c.raw.at(-1);
  const wick = Math.max(
    last.high - last.close,
    last.close - last.low
  );
  const avgVol = c.raw.reduce((a, b) => a + b.volume, 0) / c.raw.length;

  return wick > atr * 0.8 && last.volume > avgVol * 1.5;
}

/* ================= ZONE ENGINE ================= */

function buildZone(c, trend) {
  const atr = ATR(c.h, c.l, c.c, CONFIG.ATR_PERIOD).at(-1);
  const zoneHigh = Math.max(...c.h.slice(-20));
  const zoneLow = Math.min(...c.l.slice(-20));
  const entry = (zoneHigh + zoneLow) / 2;

  const sl = trend === "BULL"
    ? entry - atr * CONFIG.SL_ATR_MULT
    : entry + atr * CONFIG.SL_ATR_MULT;

  const tp = trend === "BULL"
    ? entry + atr * CONFIG.TP_ATR_MULT
    : entry - atr * CONFIG.TP_ATR_MULT;

  return { entry, sl, tp, atr, zoneHigh, zoneLow };
}

/* ================= TELEGRAM ================= */

async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: msg
    })
  });
}

/* ================= DATA ================= */

async function fetchCandles(tf) {
  const raw = await client.candles({
    symbol: CONFIG.SYMBOL,
    interval: tf,
    limit: CONFIG.CANDLE_LIMIT
  });

  return {
    raw,
    h: raw.map(c => +c.high),
    l: raw.map(c => +c.low),
    c: raw.map(c => +c.close)
  };
}

/* ================= MAIN ENGINE ================= */

async function run() {
  console.log("⏱ Evaluating XMR...");

  const bias = await fetchCandles(CONFIG.TF_BIAS);
  const entry = await fetchCandles(CONFIG.TF_ENTRY);

  const biasRegime = detectRegime(bias);
  const entryRegime = detectRegime(entry);

  console.log("Regimes → Bias:", biasRegime, "| Entry:", entryRegime);

  if (biasRegime !== entryRegime) {
    console.log("❌ REJECTED: TF regime mismatch");
    return;
  }

  if (biasRegime === "RANGE") {
    console.log("❌ REJECTED: Ranging market");
    return;
  }

  const strength = strengthScore(biasRegime, entry);
  console.log("Strength:", strength);

  if (strength < CONFIG.STRENGTH_THRESHOLD) {
    console.log("❌ REJECTED: Weak strength");
    return;
  }

  const atr = ATR(entry.h, entry.l, entry.c, CONFIG.ATR_PERIOD).at(-1);
  if (liquiditySweep(entry, atr)) {
    console.log("❌ REJECTED: Liquidity sweep detected");
    return;
  }

  const zone = buildZone(entry, biasRegime);

  console.log("✅ VALID ZONE FOUND");

  const message = `
🚨 XMR INSTITUTIONAL ZONE

Trend: ${biasRegime}
Strength: ${strength}/10

Zone:
High: ${zone.zoneHigh.toFixed(2)}
Low: ${zone.zoneLow.toFixed(2)}
Entry: ${zone.entry.toFixed(2)}

SL: ${zone.sl.toFixed(2)}
TP: ${zone.tp.toFixed(2)}
ATR: ${zone.atr.toFixed(2)}
`;

  console.log(message);
  await sendTelegram(message);
}

//setInterval(run, 60 * 60 * 1000);
run();
