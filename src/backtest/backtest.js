import ccxt from "ccxt";
import fs from "fs";
import { evaluateCTWL } from "./ctwlCore.js";

/* ================= CONFIG ================= */
const SYMBOL = "BTC/USDT";
const LIMIT = 1600;
const MIN_STRENGTH = 1.0;

/* ================= EXCHANGE ================= */
const exchange = new ccxt.binance({ enableRateLimit: true });

async function fetch(tf, limit) {
  const raw = await exchange.fetchOHLCV(SYMBOL, tf, undefined, limit);
  return raw.map(r => ({
    t: r[0],
    o: r[1],
    h: r[2],
    l: r[3],
    c: r[4]
  }));
}

async function run() {
  const daily = await fetch("1d", 500);
  const h4 = await fetch("4h", LIMIT);
  const h1 = await fetch("1h", LIMIT * 4);

  let trades = [];
  let equity = 0;
  let active = null;
  let pending = null; // 👈 NEW: waiting for entry touch

  for (let i = 200; i < h4.length - 1; i++) {
    const candle = h4[i];

    /* ================= ENTRY FILL ================= */
    if (pending) {
      const touched =
        pending.dir === "bull"
          ? candle.h >= pending.entry
          : candle.l <= pending.entry;

      if (touched) {
        active = {
          ...pending,
          fillTime: candle.t
        };
        pending = null;
      }
    }

    /* ================= MANAGE ACTIVE TRADE ================= */
    if (active) {
      if (
        (active.dir === "bull" && candle.l <= active.sl) ||
        (active.dir === "bear" && candle.h >= active.sl)
      ) {
        equity -= 1;
        active.result = "SL";
        active.exitTime = candle.t;
        trades.push(active);
        active = null;
        continue;
      }

      if (
        (active.dir === "bull" && candle.h >= active.tp) ||
        (active.dir === "bear" && candle.l <= active.tp)
      ) {
        equity += 3;
        active.result = "TP";
        active.exitTime = candle.t;
        trades.push(active);
        active = null;
      }
      continue;
    }

    /* ================= SIGNAL GENERATION ================= */
    if (pending) continue; // do not stack signals

    const dailyIndex = Math.floor(i / 6);
    const dailySlice = daily.slice(0, Math.max(200, dailyIndex));

    const result = evaluateCTWL({
      daily: dailySlice,
      intraday: h4.slice(0, i),
      ltf: h1.slice(0, i * 4),
      minStrength: MIN_STRENGTH
    });

    if (result.decision !== "TRADE") continue;

    pending = {
      openTime: candle.t,
      dir: result.trend,
      entry: result.entry,
      sl: result.sl,
      tp: result.tp,
      strength: result.strength
    };
  }

  /* ================= OUTPUT ================= */
  fs.writeFileSync(
    "ctwl_trades.txt",
    trades.map(t =>
      `${new Date(t.openTime).toISOString()} | ${t.dir.toUpperCase()} | STR ${t.strength.toFixed(
        2
      )} | ${t.result}`
    ).join("\n")
  );

  const wins = trades.filter(t => t.result === "TP").length;
  const losses = trades.length - wins;

  fs.writeFileSync(
    "ctwl_performance.txt",
    `
CTWL BTC BACKTEST
================
Trades: ${trades.length}
Wins: ${wins}
Losses: ${losses}
Win Rate: ${
      trades.length ? (wins / trades.length * 100).toFixed(2) : "0.00"
    }%
Net R: ${equity}
`
  );

  console.log("Backtest complete.");
}

run();
