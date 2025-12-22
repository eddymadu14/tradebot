import ccxt from "ccxt";
import fs from "fs";
import { evaluateCTWL } from "./ctwlCore.js";

/* ================= CONFIG ================= */
const SYMBOL = "BTC/USDT";
const LIMIT_H4 = 1600; // Number of 4H candles to pull
const MIN_STRENGTH = 1.0;

/* ================= EXCHANGE ================= */
const exchange = new ccxt.binance({ enableRateLimit: true });

async function fetchOHLCV(tf, limit) {
  const raw = await exchange.fetchOHLCV(SYMBOL, tf, undefined, limit);
  return raw.map(r => ({
    t: r[0],
    o: r[1],
    h: r[2],
    l: r[3],
    c: r[4],
    v: r[5],
  }));
}

/* ================= BACKTEST ================= */
async function runBacktest() {
  console.log("Fetching OHLCV data...");
  const daily = await fetchOHLCV("1d", 500);
  const h4 = await fetchOHLCV("4h", LIMIT_H4);
  const h1 = await fetchOHLCV("1h", LIMIT_H4 * 4);

  let trades = [];
  let equity = 0;
  let active = null;

  // Start after enough candles for indicators
  for (let i = 200; i < h4.length - 1; i++) {
    const candle = h4[i];

    /* ===== Manage open trade ===== */
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

    /* ===== Signal generation ===== */
    const result = evaluateCTWL({
      daily: daily.slice(0, Math.floor(i / 6)),
      intraday: h4.slice(0, i),
      ltf: h1.slice(0, i * 4),
    });

    if (!result) continue; // No zone detected
    if (result.strength < MIN_STRENGTH) continue; // Skip weak signals

    active = {
      openTime: candle.t,
      dir: result.trend,
      entry: result.zone.entry,
      sl: result.sl,
      tp: result.tp,
      strength: result.strength,
    };
  }

  /* ================= OUTPUT TRADES ================= */
  fs.writeFileSync(
    "ctwl_trades.txt",
    trades
      .map(
        t =>
          `${new Date(t.openTime).toISOString()} | ${t.dir.toUpperCase()} | STR ${t.strength.toFixed(
            2
          )} | ${t.result}`
      )
      .join("\n")
  );

  /* ================= OUTPUT PERFORMANCE ================= */
  const wins = trades.filter(t => t.result === "TP").length;
  const losses = trades.length - wins;

  fs.writeFileSync(
    "ctwl_performance.txt",
    `
CTWL BTC BACKTEST
================
Total Trades: ${trades.length}
Wins: ${wins}
Losses: ${losses}
Win Rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(2) : 0}%
Net R: ${equity}
`
  );

  console.log("Backtest complete.");
  console.log(`Trades: ${trades.length}, Net R: ${equity}`);
}

runBacktest();
