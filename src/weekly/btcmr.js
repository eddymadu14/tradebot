/**
 * MR_ENGINE — Mean Reversion at Weekly Open
 * Asset: BTCUSDT
 * TFs: Weekly + 4H
 * Logic: STRICT — no indicators, no guessing
 * Author intent: Silent unless edge exists
 */

import axios from "axios";
import cron from "node-cron";

/* =======================
   CONFIG (EDIT ONLY HERE)
======================= */

const BINANCE_BASE = "https://api.binance.com";
const SYMBOL = "BTCUSDT";

const WEEKLY_INTERVAL = "1w";
const FOUR_H_INTERVAL = "4h";

const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const TELEGRAM_CHAT_ID = "YOUR_CHAT_ID";

/* =======================
   CORE UTILS
======================= */

async function fetchCandles(interval, limit) {
  const res = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
    params: { symbol: SYMBOL, interval, limit }
  });

  return res.data.map(c => ({
    openTime: c[0],
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4]
  }));
}

async function sendTelegram(text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown"
    }
  );
}

/* =======================
   MR CORE LOGIC
======================= */

function runMR(weekly, fourH) {
  const currentWeek = weekly.at(-1);
  const prevWeeks = weekly.slice(-3, -1);
  const weeklyOpen = currentWeek.open;

  /* --------
     WEEKLY REGIME FILTER
  -------- */

  const avgRange =
    prevWeeks.reduce((s, w) => s + (w.high - w.low), 0) /
    prevWeeks.length;

  const currentRange = currentWeek.high - currentWeek.low;
  if (currentRange > avgRange) return null;

  /* --------
     WEEKLY OPEN TESTS
  -------- */

  const tests = fourH.filter(c =>
    Math.abs(c.high - weeklyOpen) / weeklyOpen < 0.002 ||
    Math.abs(c.low - weeklyOpen) / weeklyOpen < 0.002
  );

  if (tests.length < 2) return null;

  const lastTwo = tests.slice(-2);

  /* --------
     DIRECTION RESOLUTION
  -------- */

  let direction = null;

  // SHORT: failure above weekly open
  if (
    lastTwo[0].high > weeklyOpen &&
    lastTwo[1].high > weeklyOpen &&
    lastTwo[1].close < weeklyOpen
  ) direction = "SHORT";

  // LONG: failure below weekly open
  if (
    lastTwo[0].low < weeklyOpen &&
    lastTwo[1].low < weeklyOpen &&
    lastTwo[1].close > weeklyOpen
  ) direction = "LONG";

  if (!direction) return null;

  /* --------
     LIQUIDITY SWEEP VALIDATION
  -------- */

  const sweep = lastTwo[1];
  const wickPct =
    direction === "SHORT"
      ? (sweep.high - weeklyOpen) / weeklyOpen
      : (weeklyOpen - sweep.low) / weeklyOpen;

  if (wickPct < 0.0025) return null;

  /* --------
     TRADE CONSTRUCTION
  -------- */

  const entry = sweep.close;

  const tp =
    direction === "SHORT"
      ? entry * 0.99
      : entry * 1.01;

  const sl =
    direction === "SHORT"
      ? sweep.high * 1.0015
      : sweep.low * 0.9985;

  /* --------
     STRENGTH ENGINE (0–5)
  -------- */

  let strength = 0;

  if (wickPct > 0.25 / 100) strength++;
  if (wickPct > 0.4 / 100) strength++;

  if (
    direction === "SHORT"
      ? sweep.close < weeklyOpen
      : sweep.close > weeklyOpen
  ) strength++;

  if ((sweep.high - sweep.low) / sweep.open > 0.006) strength++;

  if (
    direction === "SHORT"
      ? sweep.close < sweep.open
      : sweep.close > sweep.open
  ) strength++;

  strength = Math.min(strength, 5);

  return {
    direction,
    weeklyOpen,
    entry,
    tp,
    sl,
    zone: {
      high: sweep.high,
      low: sweep.low
    },
    strength
  };
}

/* =======================
   EXECUTION LOOP
======================= */

async function engine() {
  try {
    const weekly = await fetchCandles(WEEKLY_INTERVAL, 5);
    const fourH = await fetchCandles(FOUR_H_INTERVAL, 80);

    const signal = runMR(weekly, fourH);
    if (!signal) return;

    const msg = `
*MR BTC MEAN REVERSION*

Direction: *${signal.direction}*
Weekly Open: ${signal.weeklyOpen}

Zone:
${signal.zone.low} → ${signal.zone.high}

Entry: ${signal.entry}
TP (1%): ${signal.tp}
SL: ${signal.sl}

Strength: *${signal.strength}/5*
Validity: 36H
`;

    await sendTelegram(msg);
    console.log("MR SIGNAL SENT");
  } catch (err) {
    console.error("MR ENGINE ERROR:", err.message);
  }
}

/* =======================
   SCHEDULER
======================= */
engine();
// Run shortly after each 4H close
cron.schedule("5 */4 * * *", engine);
