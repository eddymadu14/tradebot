// ==========================================================
// INSTITUTIONAL GRADE BINANCE FUTURES PAIR ANALYSER
// ==========================================================
//
// FEATURES:
// - Single pair analysis at runtime
// - Multi-timeframe market structure
// - EMA trend engine
// - Open Interest analysis
// - Funding analysis
// - Relative volume
// - ATR volatility regime
// - VWAP positioning
// - Momentum persistence
// - Weighted institutional scoring engine
// - Bullish/Bearish probability output
//
// INSTALL:
// npm install axios technicalindicators cli-table3 chalk
//
// RUN:
// node analyser.js BTCUSDT
// node analyser.js ONDOUSDT
//
// ==========================================================

import axios from "axios";
import {
  EMA,
  ATR,
  ADX,
  RSI
} from "technicalindicators";

import Table from "cli-table3";
import chalk from "chalk";

// ==========================================================
// CONFIG
// ==========================================================

const BASE_URL = "https://fapi.binance.com";

const TIMEFRAMES = [
  "15m",
  "1h",
  "4h",
  "1d"
];

const LIMIT = 250;

// ==========================================================
// PAIR INPUT
// ==========================================================

const SYMBOL = process.argv[2];

if (!SYMBOL) {
  console.log(chalk.red("Usage: node analyser.js BTCUSDT"));
  process.exit(1);
}

// ==========================================================
// HELPERS
// ==========================================================

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentChange(a, b) {
  return ((b - a) / a) * 100;
}

function last(arr) {
  return arr[arr.length - 1];
}

function slope(arr, length = 10) {
  const slice = arr.slice(-length);

  return slice[slice.length - 1] - slice[0];
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
// OPEN INTEREST
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
// FUNDING
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
// MARKET STRUCTURE
// ==========================================================

function analyseStructure(closes) {
  const ema20 = EMA.calculate({
    period: 20,
    values: closes
  });

  const ema50 = EMA.calculate({
    period: 50,
    values: closes
  });

  const ema200 = EMA.calculate({
    period: 200,
    values: closes
  });

  const latestPrice = last(closes);

  const e20 = last(ema20);
  const e50 = last(ema50);
  const e200 = last(ema200);

  let bullish = 0;
  let bearish = 0;

  // EMA STACKING

  if (e20 > e50 && e50 > e200) bullish += 20;
  if (e20 < e50 && e50 < e200) bearish += 20;

  // EMA SLOPE

  if (slope(ema20) > 0) bullish += 10;
  else bearish += 10;

  // PRICE POSITION

  if (latestPrice > e20) bullish += 10;
  else bearish += 10;

  return {
    bullish,
    bearish,
    ema20: e20,
    ema50: e50,
    ema200: e200
  };
}

// ==========================================================
// ATR REGIME
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

  let regime = "NORMAL";

  if (ratio > 1.5) regime = "HIGH VOLATILITY";
  if (ratio < 0.7) regime = "COMPRESSION";

  return {
    latestATR,
    ratio,
    regime
  };
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

  return latest.adx;
}

// ==========================================================
// RVOL
// ==========================================================

function analyseRVOL(volumes) {
  const latest = last(volumes);

  const averageVolume = avg(volumes.slice(-50));

  return latest / averageVolume;
}

// ==========================================================
// VWAP
// ==========================================================

function analyseVWAP(candles, closes) {
  const vwap = calculateVWAP(candles);

  const latestVWAP = last(vwap);

  const latestPrice = last(closes);

  return {
    aboveVWAP: latestPrice > latestVWAP,
    vwap: latestVWAP
  };
}

// ==========================================================
// OPEN INTEREST ANALYSIS
// ==========================================================

function analyseOI(data, closes) {
  const oiValues = data.map(x => parseFloat(x.sumOpenInterest));

  const oiChange = percentChange(
    oiValues[0],
    last(oiValues)
  );

  const priceChange = percentChange(
    closes[closes.length - 20],
    last(closes)
  );

  let interpretation = "";

  let bullish = 0;
  let bearish = 0;

  if (priceChange > 0 && oiChange > 0) {
    interpretation = "NEW LONGS";
    bullish += 20;
  }

  else if (priceChange < 0 && oiChange > 0) {
    interpretation = "AGGRESSIVE SHORTS";
    bearish += 20;
  }

  else if (priceChange > 0 && oiChange < 0) {
    interpretation = "SHORT COVERING";
    bullish += 10;
  }

  else {
    interpretation = "LONG LIQUIDATION";
    bearish += 10;
  }

  return {
    oiChange,
    interpretation,
    bullish,
    bearish
  };
}

// ==========================================================
// FUNDING ANALYSIS
// ==========================================================

function analyseFunding(data) {
  const rates = data.map(x => parseFloat(x.fundingRate));

  const latest = last(rates);

  let bullish = 0;
  let bearish = 0;

  if (latest > 0.01) bearish += 10;

  if (latest < -0.01) bullish += 10;

  return {
    latest,
    bullish,
    bearish
  };
}

// ==========================================================
// MOMENTUM PERSISTENCE
// ==========================================================

function analyseMomentum(closes) {
  let bullishCandles = 0;

  for (let i = closes.length - 10; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) bullishCandles++;
  }

  return bullishCandles;
}

// ==========================================================
// MAIN ANALYSIS
// ==========================================================

async function analysePair(symbol) {

  console.log(
    chalk.yellow(`\nANALYSING ${symbol}\n`)
  );

  const timeframeResults = [];

  let totalBullish = 0;
  let totalBearish = 0;

  for (const tf of TIMEFRAMES) {

    const candles = await fetchCandles(symbol, tf);

    const closes = candles.map(x => parseFloat(x[4]));
    const highs = candles.map(x => parseFloat(x[2]));
    const lows = candles.map(x => parseFloat(x[3]));
    const volumes = candles.map(x => parseFloat(x[5]));

    const structure = analyseStructure(closes);

    const atr = analyseATR(
      highs,
      lows,
      closes
    );

    const adx = analyseADX(
      highs,
      lows,
      closes
    );

    const rvol = analyseRVOL(volumes);

    const vwap = analyseVWAP(
      candles,
      closes
    );

    const momentum = analyseMomentum(closes);

    let bullish = structure.bullish;
    let bearish = structure.bearish;

    // ADX

    if (adx > 25) bullish += 5;

    // RVOL

    if (rvol > 1.5) bullish += 5;

    // VWAP

    if (vwap.aboveVWAP) bullish += 5;
    else bearish += 5;

    // MOMENTUM

    if (momentum >= 7) bullish += 10;
    if (momentum <= 3) bearish += 10;

    totalBullish += bullish;
    totalBearish += bearish;

    timeframeResults.push({
      tf,
      bullish,
      bearish,
      adx: adx.toFixed(2),
      rvol: rvol.toFixed(2),
      atr: atr.regime
    });
  }

  // ======================================================
  // DERIVATIVES
  // ======================================================

  const oiData = await fetchOpenInterest(symbol);

  const fundingData = await fetchFunding(symbol);

  const mainCandles = await fetchCandles(symbol, "1h");

  const closes = mainCandles.map(x => parseFloat(x[4]));

  const oi = analyseOI(oiData, closes);

  const funding = analyseFunding(fundingData);

  totalBullish += oi.bullish + funding.bullish;
  totalBearish += oi.bearish + funding.bearish;

  // ======================================================
  // FINAL SCORE
  // ======================================================

  const total = totalBullish + totalBearish;

  const bullishProbability =
    ((totalBullish / total) * 100).toFixed(2);

  const bearishProbability =
    ((totalBearish / total) * 100).toFixed(2);

  // ======================================================
  // TABLE OUTPUT
  // ======================================================

  const table = new Table({
    head: [
      "TF",
      "Bullish",
      "Bearish",
      "ADX",
      "RVOL",
      "ATR"
    ]
  });

  timeframeResults.forEach(x => {
    table.push([
      x.tf,
      x.bullish,
      x.bearish,
      x.adx,
      x.rvol,
      x.atr
    ]);
  });

  console.log(table.toString());

  // ======================================================
  // DERIVATIVES OUTPUT
  // ======================================================

  console.log(
    chalk.cyan("\nDERIVATIVES ANALYSIS")
  );

  console.log(
    "OI Change:",
    oi.oiChange.toFixed(2) + "%"
  );

  console.log(
    "OI Interpretation:",
    oi.interpretation
  );

  console.log(
    "Funding:",
    funding.latest
  );

  // ======================================================
  // FINAL BIAS
  // ======================================================

  console.log(
    chalk.green("\nFINAL ANALYSIS")
  );

  console.log(
    "Bullish Probability:",
    bullishProbability + "%"
  );

  console.log(
    "Bearish Probability:",
    bearishProbability + "%"
  );

  if (bullishProbability > bearishProbability) {
    console.log(
      chalk.green(
        `\nOVERALL BIAS: BULLISH`
      )
    );
  } else {
    console.log(
      chalk.red(
        `\nOVERALL BIAS: BEARISH`
      )
    );
  }
}

// ==========================================================
// EXECUTION
// ==========================================================

analysePair(SYMBOL).catch(err => {

  console.log(
    chalk.red("\nERROR:")
  );

  console.log(err.message);

});
