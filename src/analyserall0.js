// ==========================================================
// INSTITUTIONAL GRADE BINANCE FUTURES MARKET SCANNER
// ==========================================================
//
// SCANS:
// - ALL BINANCE USDT FUTURES PAIRS
//
// OUTPUT:
// - ONLY PAIRS WITH:
//      Bullish Probability >= 80%
//      OR
//      Bearish Probability >= 80%
//
// FEATURES:
// - Multi-timeframe structure
// - EMA trend engine
// - Open Interest analysis
// - Funding analysis
// - RVOL
// - ATR regime
// - VWAP positioning
// - Momentum persistence
// - Weighted institutional scoring
// - 24H Volume Filter (NEW)
//
// INSTALL:
// npm install axios technicalindicators cli-table3 chalk p-limit
//
// RUN:
// node scanner.js
//
// ==========================================================

import axios from "axios";
import { EMA, ATR, ADX } from "technicalindicators";
import Table from "cli-table3";
import chalk from "chalk";
import pLimit from "p-limit";

// ==========================================================
// CONFIG
// ==========================================================

const BASE_URL = "https://fapi.binance.com";

const TIMEFRAMES = ["15m", "1h", "4h", "1d"];

const LIMIT = 250;

const CONCURRENCY = 5;

const MIN_PROBABILITY = 85;

// NEW: LIQUIDITY FILTER
const MIN_24H_VOLUME = 20_000_000;

// ==========================================================
// HELPERS
// ==========================================================

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function last(arr) {
  return arr[arr.length - 1];
}

function slope(arr, length = 10) {
  const slice = arr.slice(-length);
  return slice[slice.length - 1] - slice[0];
}

function percentChange(a, b) {
  return ((b - a) / a) * 100;
}

function calculateVWAP(candles) {
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  const values = [];

  for (const c of candles) {
    const high = parseFloat(c[2]);
    const low = parseFloat(c[3]);
    const close = parseFloat(c[4]);
    const volume = parseFloat(c[5]);

    const tp = (high + low + close) / 3;

    cumulativeTPV += tp * volume;
    cumulativeVolume += volume;

    values.push(cumulativeTPV / cumulativeVolume);
  }

  return values;
}

// ==========================================================
// FETCH ALL USDT FUTURES PAIRS
// ==========================================================

async function fetchAllPairs() {
  const url = `${BASE_URL}/fapi/v1/exchangeInfo`;

  const res = await axios.get(url);

  return res.data.symbols
    .filter(
      s => s.quoteAsset === "USDT" && s.status === "TRADING"
    )
    .map(s => s.symbol);
}

// ==========================================================
// FETCH 24H VOLUME (NEW)
// ==========================================================

async function fetch24hVolumes() {
  const url = `${BASE_URL}/fapi/v1/ticker/24hr`;

  const res = await axios.get(url);

  const map = new Map();

  for (const item of res.data) {
    map.set(item.symbol, parseFloat(item.quoteVolume));
  }

  return map;
}

// ==========================================================
// FETCH CANDLES
// ==========================================================

async function fetchCandles(symbol, interval) {
  const url = `${BASE_URL}/fapi/v1/klines`;

  const res = await axios.get(url, {
    params: {
      symbol,
      interval,
      limit: LIMIT
    }
  });

  return res.data;
}

// ==========================================================
// FETCH OI
// ==========================================================

async function fetchOpenInterest(symbol) {
  const url = `${BASE_URL}/futures/data/openInterestHist`;

  const res = await axios.get(url, {
    params: {
      symbol,
      period: "5m",
      limit: 50
    }
  });

  return res.data;
}

// ==========================================================
// FETCH FUNDING
// ==========================================================

async function fetchFunding(symbol) {
  const url = `${BASE_URL}/fapi/v1/fundingRate`;

  const res = await axios.get(url, {
    params: {
      symbol,
      limit: 20
    }
  });

  return res.data;
}

// ==========================================================
// STRUCTURE
// ==========================================================

function analyseStructure(closes) {
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });

  const e20 = last(ema20);
  const e50 = last(ema50);
  const e200 = last(ema200);

  const latestPrice = last(closes);

  let bullish = 0;
  let bearish = 0;

  if (e20 > e50 && e50 > e200) bullish += 20;
  if (e20 < e50 && e50 < e200) bearish += 20;

  if (slope(ema20) > 0) bullish += 10;
  else bearish += 10;

  if (latestPrice > e20) bullish += 10;
  else bearish += 10;

  return { bullish, bearish };
}

// ==========================================================
// ATR
// ==========================================================

function analyseATR(highs, lows, closes) {
  const atr = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const latestATR = last(atr);
  const atrAvg = avg(atr.slice(-50));
  const ratio = latestATR / atrAvg;

  let bullish = 0;
  let bearish = 0;

  if (ratio > 1.5) {
    bullish += 5;
    bearish += 5;
  }

  return { bullish, bearish };
}

// ==========================================================
// ADX
// ==========================================================

function analyseADX(highs, lows, closes) {
  const adx = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });

  const latest = last(adx);

  let bullish = 0;
  let bearish = 0;

  if (latest.adx > 25) {
    bullish += 5;
    bearish += 5;
  }

  return { bullish, bearish };
}

// ==========================================================
// RVOL
// ==========================================================

function analyseRVOL(volumes) {
  const latest = last(volumes);
  const averageVolume = avg(volumes.slice(-50));
  const rvol = latest / averageVolume;

  let bullish = 0;
  let bearish = 0;

  if (rvol > 1.5) {
    bullish += 5;
    bearish += 5;
  }

  return { bullish, bearish };
}

// ==========================================================
// VWAP
// ==========================================================

function analyseVWAP(candles, closes) {
  const vwapValues = calculateVWAP(candles);
  const vwap = last(vwapValues);
  const price = last(closes);

  let bullish = 0;
  let bearish = 0;

  if (price > vwap) bullish += 10;
  else bearish += 10;

  return { bullish, bearish };
}

// ==========================================================
// MOMENTUM
// ==========================================================

function analyseMomentum(closes) {
  let upCandles = 0;

  for (let i = closes.length - 10; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      upCandles++;
    }
  }

  let bullish = 0;
  let bearish = 0;

  if (upCandles >= 7) bullish += 15;
  if (upCandles <= 3) bearish += 15;

  return { bullish, bearish };
}

// ==========================================================
// OI ANALYSIS
// ==========================================================

function analyseOI(oiData, closes) {
  const oiValues = oiData.map(x => parseFloat(x.sumOpenInterest));

  const oiChange = percentChange(oiValues[0], last(oiValues));
  const priceChange = percentChange(
    closes[closes.length - 20],
    last(closes)
  );

  let bullish = 0;
  let bearish = 0;

  if (priceChange > 0 && oiChange > 0) bullish += 25;
  else if (priceChange < 0 && oiChange > 0) bearish += 25;
  else if (priceChange > 0 && oiChange < 0) bullish += 10;
  else bearish += 10;

  return { bullish, bearish };
}

// ==========================================================
// FUNDING
// ==========================================================

function analyseFunding(data) {
  const rates = data.map(x => parseFloat(x.fundingRate));
  const latest = last(rates);

  let bullish = 0;
  let bearish = 0;

  if (latest < -0.01) bullish += 10;
  if (latest > 0.01) bearish += 10;

  return { bullish, bearish };
}

// ==========================================================
// ANALYSE SINGLE PAIR
// ==========================================================

async function analysePair(symbol) {
  try {
    let totalBullish = 0;
    let totalBearish = 0;

    for (const tf of TIMEFRAMES) {
      const candles = await fetchCandles(symbol, tf);

      const closes = candles.map(x => parseFloat(x[4]));
      const highs = candles.map(x => parseFloat(x[2]));
      const lows = candles.map(x => parseFloat(x[3]));
      const volumes = candles.map(x => parseFloat(x[5]));

      const structure = analyseStructure(closes);
      const atr = analyseATR(highs, lows, closes);
      const adx = analyseADX(highs, lows, closes);
      const rvol = analyseRVOL(volumes);
      const vwap = analyseVWAP(candles, closes);
      const momentum = analyseMomentum(closes);

      totalBullish +=
        structure.bullish +
        atr.bullish +
        adx.bullish +
        rvol.bullish +
        vwap.bullish +
        momentum.bullish;

      totalBearish +=
        structure.bearish +
        atr.bearish +
        adx.bearish +
        rvol.bearish +
        vwap.bearish +
        momentum.bearish;
    }

    const oiData = await fetchOpenInterest(symbol);
    const fundingData = await fetchFunding(symbol);
    const candles = await fetchCandles(symbol, "1h");

    const closes = candles.map(x => parseFloat(x[4]));

    const oi = analyseOI(oiData, closes);
    const funding = analyseFunding(fundingData);

    totalBullish += oi.bullish + funding.bullish;
    totalBearish += oi.bearish + funding.bearish;

    const total = totalBullish + totalBearish;
    if (!total) return null;

    const bullishProbability = Number(
      ((totalBullish / total) * 100).toFixed(2)
    );

    const bearishProbability = Number(
      ((totalBearish / total) * 100).toFixed(2)
    );

    if (bullishProbability >= MIN_PROBABILITY) {
      return {
        symbol,
        bias: "BULLISH",
        probability: bullishProbability
      };
    }

    if (bearishProbability >= MIN_PROBABILITY) {
      return {
        symbol,
        bias: "BEARISH",
        probability: bearishProbability
      };
    }

    return null;
  } catch (err) {
    return null;
  }
}

// ==========================================================
// MAIN SCANNER
// ==========================================================

async function runScanner() {
  console.log(chalk.yellow("\nFETCHING BINANCE FUTURES PAIRS...\n"));

  const pairs = await fetchAllPairs();
  const volumeMap = await fetch24hVolumes();

  const filteredPairs = pairs.filter(symbol => {
    const vol = volumeMap.get(symbol) || 0;
    return vol >= MIN_24H_VOLUME;
  });

  console.log(chalk.cyan(`TOTAL PAIRS: ${pairs.length}`));
  console.log(chalk.magenta(`HIGH VOLUME PAIRS: ${filteredPairs.length}\n`));

  const limit = pLimit(CONCURRENCY);

  const tasks = filteredPairs.map(symbol =>
    limit(() => analysePair(symbol))
  );

  const results = await Promise.all(tasks);

  const filtered = results
    .filter(Boolean)
    .sort((a, b) => b.probability - a.probability);

  const table = new Table({
    head: ["PAIR", "BIAS", "PROBABILITY"]
  });

  filtered.forEach(x => {
    table.push([
      x.symbol,
      x.bias === "BULLISH"
        ? chalk.green(x.bias)
        : chalk.red(x.bias),
      x.probability + "%"
    ]);
  });

  console.log(table.toString());
  console.log(chalk.green(`\nSTRONG PAIRS FOUND: ${filtered.length}\n`));
}

// ==========================================================
// EXECUTION
// ==========================================================

runScanner().catch(err => {
  console.log(chalk.red("\nSCANNER ERROR"));
  console.log(err.message);
});
