import axios from "axios";
import fs from "fs";

const BASE_URL = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";

const EMA_FAST = 20;
const EMA_SLOW = 50;
const ATR_PERIOD = 14;

const ONE_YEAR_HOURS = 24 * 365;

// =====================
// Helpers
// =====================

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function calculateATR(candles, index, period) {
  let trs = [];

  for (let i = index - period; i < index; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  return trs.reduce((a, b) => a + b, 0) / period;
}

async function getKlines(interval, limit) {
  const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: { symbol: SYMBOL, interval, limit },
  });
  return res.data;
}

// =====================
// Backtest Core
// =====================

async function runBacktest() {
  console.log("Fetching 1H data...");
  const h1 = await getKlines("1h", ONE_YEAR_HOURS + 200);

  console.log("Fetching 4H data...");
  const h4 = await getKlines("4h", 2000);

  console.log("Fetching 1D data...");
  const d1 = await getKlines("1d", 400);

  let trades = [];

  for (let i = 200; i < h1.length - 50; i++) {
    const close = parseFloat(h1[i][4]);
    const time = h1[i][0];

    // ----- DAILY BIAS -----
    const dailyCloses = d1.map(c => parseFloat(c[4]));
    const dailyFast = ema(dailyCloses.slice(-EMA_FAST * 3), EMA_FAST);
    const dailySlow = ema(dailyCloses.slice(-EMA_SLOW * 3), EMA_SLOW);

    let bias = null;
    if (dailyFast > dailySlow) bias = "LONG";
    if (dailyFast < dailySlow) bias = "SHORT";
    if (!bias) continue;

    // ----- 1H TRIGGER -----
    const prevHigh = parseFloat(h1[i - 1][2]);
    const prevLow = parseFloat(h1[i - 1][3]);

    let trigger = false;
    if (bias === "LONG" && close > prevHigh) trigger = true;
    if (bias === "SHORT" && close < prevLow) trigger = true;

    if (!trigger) continue;

    // ----- ATR -----
    const atr = calculateATR(h1, i, ATR_PERIOD);
    const entry = close;

    let stop, tp;
    if (bias === "LONG") {
      stop = entry - atr;
      tp = entry + 2 * atr;
    } else {
      stop = entry + atr;
      tp = entry - 2 * atr;
    }

    // ----- SIMULATE FORWARD -----
    let outcome = "OPEN";
    let exitPrice = null;

    for (let j = i + 1; j < h1.length; j++) {
      const high = parseFloat(h1[j][2]);
      const low = parseFloat(h1[j][3]);

      if (bias === "LONG") {
        if (low <= stop) {
          outcome = "LOSS";
          exitPrice = stop;
          break;
        }
        if (high >= tp) {
          outcome = "WIN";
          exitPrice = tp;
          break;
        }
      } else {
        if (high >= stop) {
          outcome = "LOSS";
          exitPrice = stop;
          break;
        }
        if (low <= tp) {
          outcome = "WIN";
          exitPrice = tp;
          break;
        }
      }
    }

    trades.push({
      time,
      direction: bias,
      entry,
      stop,
      tp,
      result: outcome,
      exit: exitPrice,
    });
  }

  // ----- WRITE CSV -----
  const header = "time,direction,entry,stop,tp,result,exit\n";
  const rows = trades.map(t =>
    `${t.time},${t.direction},${t.entry},${t.stop},${t.tp},${t.result},${t.exit}`
  );

  fs.writeFileSync("backtest_results.csv", header + rows.join("\n"));

  console.log("Backtest complete.");
  console.log("Total trades:", trades.length);
  console.log("CSV saved as backtest_results.csv");
}

runBacktest();
