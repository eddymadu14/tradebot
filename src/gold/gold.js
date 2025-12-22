/**
 * GOLD WEEKLY DIRECTION ENGINE — PRODUCTION
 * ----------------------------------------
 * Directional bias + TP/SL
 * Professional constraints only
 * ONE FILE — NO FLUFF
 */

import ccxt from "ccxt";
import fs from "fs";
import fetch from "node-fetch";
import { ATR } from "technicalindicators";

// =========================
// CONFIG
// =========================
const SYMBOL = "XAU/USDT";
const ATR_PERIOD = 14;
const HTF_LOOKBACK = 10;
const MIN_CONFIDENCE = 0.6;

const TP_MULT = 1.5;
const SL_MULT = 1.0;

// =========================
// LOAD STATIC DATA
// =========================
const COT = loadCOT("cot_gold.csv");
const MACRO_WEEKS = new Set(JSON.parse(fs.readFileSync("macro_events.json")));

// =========================
// EXCHANGE
// =========================
const exchange = new ccxt.binance({ enableRateLimit: true });

// =========================
// UTILS
// =========================
function isoWeek(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function rollingCorrelation(a, b) {
  const n = a.length;
  const avgA = a.reduce((x, y) => x + y) / n;
  const avgB = b.reduce((x, y) => x + y) / n;

  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - avgA) * (b[i] - avgB);
    da += (a[i] - avgA) ** 2;
    db += (b[i] - avgB) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function loadCOT(file) {
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const map = {};
  rows.forEach(r => {
    const [date, net] = r.split(",");
    map[date] = Number(net);
  });
  return map;
}

// =========================
// DATA FETCHERS
// =========================
async function fetchWeekly(symbol) {
  const ohlc = await exchange.fetchOHLCV(symbol, "1w", undefined, 120);
  return ohlc.map(c => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4]
  }));
}

async function fetchDXY() {
  const res = await fetch(
    "https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=2y&interval=1wk"
  );
  const json = await res.json();
  return json.chart.result[0].indicators.quote[0].close;
}

// =========================
// FILTERS
// =========================
function htfBias(data, i) {
  const slice = data.slice(i - HTF_LOOKBACK, i).map(x => x.close);
  const max = Math.max(...slice);
  const min = Math.min(...slice);

  if (data[i].close > max) return "BULL";
  if (data[i].close < min) return "BEAR";
  return "FLAT";
}

function openDisplacement(data, i) {
  const highs = data.slice(i - 4, i).map(x => x.high);
  const lows = data.slice(i - 4, i).map(x => x.low);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const pos = (data[i].open - lo) / (hi - lo);
  return pos <= 0.25 || pos >= 0.75;
}

function cotExtreme(date) {
  const keys = Object.keys(COT);
  if (!keys.length) return false;

  const vals = Object.values(COT);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pct = (COT[date] - min) / (max - min);
  return pct <= 0.2 || pct >= 0.8;
}

// =========================
// ENGINE
// =========================
async function run() {
  const gold = await fetchWeekly(SYMBOL);
  const dxy = await fetchDXY();

  const atrVals = ATR.calculate({
    high: gold.map(x => x.high),
    low: gold.map(x => x.low),
    close: gold.map(x => x.close),
    period: ATR_PERIOD
  });

  const results = [];

  for (let i = ATR_PERIOD + HTF_LOOKBACK; i < gold.length; i++) {
    const week = gold[i];
    const date = isoWeek(week.time);

    // ---- HARD EXCLUSIONS ----
    if (MACRO_WEEKS.has(date)) continue;

    // ---- FILTERS ----
    const atr = atrVals[i - ATR_PERIOD];
    const volOK = atr < Math.max(...atrVals.slice(-52)) * 0.65;
    const openOK = openDisplacement(gold, i);
    const bias = htfBias(gold, i);
    const cotOK = cotExtreme(date);

    const goldCloses = gold.slice(i - 13, i).map(x => x.close);
    const dxySlice = dxy.slice(i - 13, i);
    const corrOK = rollingCorrelation(goldCloses, dxySlice) < -0.4;

    const filters = { volOK, openOK, cotOK, corrOK, biasOK: bias !== "FLAT" };
    const confidence =
      Object.values(filters).filter(Boolean).length / Object.keys(filters).length;

    if (confidence < MIN_CONFIDENCE) continue;

    // ---- SIGNAL ----
    const signal = bias === "BULL" ? "LONG" : "SHORT";

    const sl =
      signal === "LONG"
        ? week.open - atr * SL_MULT
        : week.open + atr * SL_MULT;

    const tp =
      signal === "LONG"
        ? week.open + atr * TP_MULT
        : week.open - atr * TP_MULT;

    results.push({
      date,
      signal,
      open: week.open,
      sl: sl.toFixed(2),
      tp: tp.toFixed(2),
      confidence: confidence.toFixed(2)
    });
  }

  console.table(results.slice(-5));
}

run();
