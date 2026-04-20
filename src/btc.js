import axios from "axios";

const BASE_URL = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";

const DAILY_INTERVAL = "1d";
const H4_INTERVAL = "4h";
const H1_INTERVAL = "1h";

const EMA_FAST = 20;
const EMA_SLOW = 50;
const ATR_PERIOD = 14;

// =====================
// Utilities
// =====================

function calculateEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateATR(candles, period) {
  const trs = [];

  for (let i = 1; i < candles.length; i++) {
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

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

async function getKlines(interval, limit = 200) {
  const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: {
      symbol: SYMBOL,
      interval,
      limit,
    },
  });

  return res.data;
}

// =====================
// Strategy Core
// =====================

async function runStrategy() {
  console.log("Scanning BTC HTF/LTF alignment...");

  const daily = await getKlines(DAILY_INTERVAL);
  const h4 = await getKlines(H4_INTERVAL);
  const h1 = await getKlines(H1_INTERVAL);

  // ---- DAILY BIAS ----
  const dailyCloses = daily.map(c => parseFloat(c[4]));

  const dailyFast = calculateEMA(dailyCloses.slice(-EMA_FAST * 3), EMA_FAST);
  const dailySlow = calculateEMA(dailyCloses.slice(-EMA_SLOW * 3), EMA_SLOW);

  let bias = null;

  if (dailyFast > dailySlow) bias = "LONG";
  if (dailyFast < dailySlow) bias = "SHORT";

  if (!bias) {
    console.log("No clear daily bias.");
    return;
  }

  console.log("Daily Bias:", bias);

  // ---- 4H Pullback ----
  const h4Closes = h4.map(c => parseFloat(c[4]));
  const h4Fast = calculateEMA(h4Closes.slice(-EMA_FAST * 3), EMA_FAST);

  const lastH4Close = h4Closes[h4Closes.length - 1];
  const distanceFromEMA = Math.abs((lastH4Close - h4Fast) / h4Fast) * 100;

  if (distanceFromEMA > 1) {
    console.log("No valid 4H pullback.");
    return;
  }

  console.log("4H pullback confirmed.");

  // ---- 1H Trigger ----
  const lastH1 = h1[h1.length - 1];
  const prevH1 = h1[h1.length - 2];

  const lastClose = parseFloat(lastH1[4]);
  const prevHigh = parseFloat(prevH1[2]);
  const prevLow = parseFloat(prevH1[3]);

  let trigger = false;

  if (bias === "LONG" && lastClose > prevHigh) trigger = true;
  if (bias === "SHORT" && lastClose < prevLow) trigger = true;

  if (!trigger) {
    console.log("No 1H structure break trigger.");
    return;
  }

  console.log("1H trigger confirmed.");

  // ---- ATR for Stop ----
  const atr = calculateATR(h1, ATR_PERIOD);
  const entry = lastClose;

  let stop, takeProfit;

  if (bias === "LONG") {
    stop = entry - atr;
    takeProfit = entry + atr * 2;
  } else {
    stop = entry + atr;
    takeProfit = entry - atr * 2;
  }

  console.log("========= TRADE SETUP =========");
  console.log("Direction:", bias);
  console.log("Entry:", entry);
  console.log("Stop:", stop);
  console.log("Take Profit:", takeProfit);
  console.log("ATR:", atr);
  console.log("================================");
}

runStrategy();
