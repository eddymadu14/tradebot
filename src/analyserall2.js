// ==========================================================
// INSTITUTIONAL GRADE BINANCE FUTURES MARKET SCANNER v2
// ==========================================================
//
// FEATURES
// - Scans ALL Binance USDT futures pairs
// - 24H USDT volume filter
// - Streaming live signal emission
// - Multi-timeframe structure analysis
// - EMA trend engine
// - ATR volatility regime
// - ADX trend strength
// - RVOL analysis
// - VWAP positioning
// - Momentum persistence
// - Open Interest analysis
// - Funding analysis
// - Institutional weighted scoring engine
//
// OUTPUT
// - ONLY emits:
//      Bullish Probability >= 80%
//      OR
//      Bearish Probability >= 80%
//
// LIQUIDITY FILTER
// - Minimum 24H Volume:
//      20,000,000 USDT
//
// INSTALL
// npm install axios technicalindicators chalk p-limit
//
// RUN
// node scanner.js
//
// ==========================================================

import axios from "axios";

import {
  EMA,
  ATR,
  ADX
} from "technicalindicators";

import chalk from "chalk";
import pLimit from "p-limit";

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

const CONCURRENCY = 10;

const MIN_PROBABILITY = 80;

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

  const slice =
    arr.slice(-length);

  return (
    slice[slice.length - 1] -
    slice[0]
  );
}

function percentChange(a, b) {
  return ((b - a) / a) * 100;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

// ==========================================================
// VWAP
// ==========================================================

function calculateVWAP(candles) {

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  const values = [];

  for (const c of candles) {

    const high =
      parseFloat(c[2]);

    const low =
      parseFloat(c[3]);

    const close =
      parseFloat(c[4]);

    const volume =
      parseFloat(c[5]);

    const tp =
      (high + low + close) / 3;

    cumulativeTPV += tp * volume;

    cumulativeVolume += volume;

    values.push(
      cumulativeTPV /
      cumulativeVolume
    );
  }

  return values;
}

// ==========================================================
// FETCH TRADABLE PAIRS
// ==========================================================

async function fetchAllPairs() {

  const exchangeInfo =
    await axios.get(
      `${BASE_URL}/fapi/v1/exchangeInfo`
    );

  const tickers =
    await axios.get(
      `${BASE_URL}/fapi/v1/ticker/24hr`
    );

  // Create volume map

  const volumeMap = {};

  for (const t of tickers.data) {

    volumeMap[t.symbol] =
      parseFloat(t.quoteVolume);
  }

  // Filter only liquid USDT futures pairs

  return exchangeInfo.data.symbols
    .filter(symbol => {

      const volume =
        volumeMap[symbol.symbol] || 0;

      return (
        symbol.quoteAsset === "USDT" &&
        symbol.status === "TRADING" &&
        volume >= MIN_24H_VOLUME
      );
    })

    .map(symbol => ({
      symbol: symbol.symbol,
      volume:
        volumeMap[symbol.symbol]
    }))

    .sort(
      (a, b) =>
        b.volume - a.volume
    );
}

// ==========================================================
// FETCH CANDLES
// ==========================================================

async function fetchCandles(
  symbol,
  interval
) {

  const res = await axios.get(
    `${BASE_URL}/fapi/v1/klines`,
    {
      params: {
        symbol,
        interval,
        limit: LIMIT
      }
    }
  );

  return res.data;
}

// ==========================================================
// FETCH OPEN INTEREST
// ==========================================================

async function fetchOpenInterest(
  symbol
) {

  const res = await axios.get(
    `${BASE_URL}/futures/data/openInterestHist`,
    {
      params: {
        symbol,
        period: "5m",
        limit: 50
      }
    }
  );

  return res.data;
}

// ==========================================================
// FETCH FUNDING
// ==========================================================

async function fetchFunding(symbol) {

  const res = await axios.get(
    `${BASE_URL}/fapi/v1/fundingRate`,
    {
      params: {
        symbol,
        limit: 20
      }
    }
  );

  return res.data;
}

// ==========================================================
// MARKET STRUCTURE
// ==========================================================

function analyseStructure(closes) {

  const ema20 =
    EMA.calculate({
      period: 20,
      values: closes
    });

  const ema50 =
    EMA.calculate({
      period: 50,
      values: closes
    });

  const ema200 =
    EMA.calculate({
      period: 200,
      values: closes
    });

  const e20 = last(ema20);
  const e50 = last(ema50);
  const e200 = last(ema200);

  const latestPrice =
    last(closes);

  let bullish = 0;
  let bearish = 0;

  // EMA STACKING

  if (
    e20 > e50 &&
    e50 > e200
  ) {
    bullish += 20;
  }

  if (
    e20 < e50 &&
    e50 < e200
  ) {
    bearish += 20;
  }

  // EMA SLOPE

  if (slope(ema20) > 0) {
    bullish += 10;
  } else {
    bearish += 10;
  }

  // PRICE POSITION

  if (latestPrice > e20) {
    bullish += 10;
  } else {
    bearish += 10;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// ATR REGIME
// ==========================================================

function analyseATR(
  highs,
  lows,
  closes
) {

  const atr =
    ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });

  const latestATR =
    last(atr);

  const atrAvg =
    avg(atr.slice(-50));

  const ratio =
    latestATR / atrAvg;

  let bullish = 0;
  let bearish = 0;

  // Volatility expansion

  if (ratio > 1.5) {
    bullish += 5;
    bearish += 5;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// ADX TREND STRENGTH
// ==========================================================

function analyseADX(
  highs,
  lows,
  closes
) {

  const adx =
    ADX.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });

  const latest =
    last(adx);

  let bullish = 0;
  let bearish = 0;

  if (latest.adx > 25) {

    bullish += 5;
    bearish += 5;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// RVOL
// ==========================================================

function analyseRVOL(volumes) {

  const latest =
    last(volumes);

  const avgVolume =
    avg(volumes.slice(-50));

  const rvol =
    latest / avgVolume;

  let bullish = 0;
  let bearish = 0;

  if (rvol > 1.5) {

    bullish += 5;
    bearish += 5;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// VWAP
// ==========================================================

function analyseVWAP(
  candles,
  closes
) {

  const vwapValues =
    calculateVWAP(candles);

  const vwap =
    last(vwapValues);

  const latestPrice =
    last(closes);

  let bullish = 0;
  let bearish = 0;

  if (latestPrice > vwap) {
    bullish += 10;
  } else {
    bearish += 10;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// MOMENTUM PERSISTENCE
// ==========================================================

function analyseMomentum(closes) {

  let upCandles = 0;

  for (
    let i = closes.length - 10;
    i < closes.length;
    i++
  ) {

    if (
      closes[i] >
      closes[i - 1]
    ) {
      upCandles++;
    }
  }

  let bullish = 0;
  let bearish = 0;

  if (upCandles >= 7) {
    bullish += 15;
  }

  if (upCandles <= 3) {
    bearish += 15;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// OPEN INTEREST ANALYSIS
// ==========================================================

function analyseOI(
  oiData,
  closes
) {

  const oiValues =
    oiData.map(x =>
      parseFloat(
        x.sumOpenInterest
      )
    );

  const oiChange =
    percentChange(
      oiValues[0],
      last(oiValues)
    );

  const priceChange =
    percentChange(
      closes[
        closes.length - 20
      ],
      last(closes)
    );

  let bullish = 0;
  let bearish = 0;

  // New longs

  if (
    priceChange > 0 &&
    oiChange > 0
  ) {
    bullish += 25;
  }

  // Aggressive shorts

  else if (
    priceChange < 0 &&
    oiChange > 0
  ) {
    bearish += 25;
  }

  // Short covering

  else if (
    priceChange > 0 &&
    oiChange < 0
  ) {
    bullish += 10;
  }

  // Long liquidation

  else {
    bearish += 10;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// FUNDING ANALYSIS
// ==========================================================

function analyseFunding(data) {

  const rates =
    data.map(x =>
      parseFloat(
        x.fundingRate
      )
    );

  const latest =
    last(rates);

  let bullish = 0;
  let bearish = 0;

  // Extremely negative funding

  if (latest < -0.01) {
    bullish += 10;
  }

  // Extremely positive funding

  if (latest > 0.01) {
    bearish += 10;
  }

  return {
    bullish,
    bearish
  };
}

// ==========================================================
// ANALYSE SINGLE PAIR
// ==========================================================

async function analysePair(
  symbol,
  volume
) {

  try {

    let totalBullish = 0;
    let totalBearish = 0;

    // ======================================================
    // MULTI TIMEFRAME ANALYSIS
    // ======================================================

    for (const tf of TIMEFRAMES) {

      const candles =
        await fetchCandles(
          symbol,
          tf
        );

      const closes =
        candles.map(c =>
          parseFloat(c[4])
        );

      const highs =
        candles.map(c =>
          parseFloat(c[2])
        );

      const lows =
        candles.map(c =>
          parseFloat(c[3])
        );

      const volumes =
        candles.map(c =>
          parseFloat(c[5])
        );

      const structure =
        analyseStructure(closes);

      const atr =
        analyseATR(
          highs,
          lows,
          closes
        );

      const adx =
        analyseADX(
          highs,
          lows,
          closes
        );

      const rvol =
        analyseRVOL(
          volumes
        );

      const vwap =
        analyseVWAP(
          candles,
          closes
        );

      const momentum =
        analyseMomentum(
          closes
        );

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

    // ======================================================
    // DERIVATIVES ANALYSIS
    // ======================================================

    const oiData =
      await fetchOpenInterest(
        symbol
      );

    const fundingData =
      await fetchFunding(
        symbol
      );

    const candles =
      await fetchCandles(
        symbol,
        "1h"
      );

    const closes =
      candles.map(c =>
        parseFloat(c[4])
      );

    const oi =
      analyseOI(
        oiData,
        closes
      );

    const funding =
      analyseFunding(
        fundingData
      );

    totalBullish +=
      oi.bullish +
      funding.bullish;

    totalBearish +=
      oi.bearish +
      funding.bearish;

    // ======================================================
    // FINAL PROBABILITY
    // ======================================================

    const total =
      totalBullish +
      totalBearish;

    if (!total) {
      return null;
    }

    const bullishProbability =
      Number(
        (
          (totalBullish /
            total) *
          100
        ).toFixed(2)
      );

    const bearishProbability =
      Number(
        (
          (totalBearish /
            total) *
          100
        ).toFixed(2)
      );

    // ======================================================
    // QUALIFIED SIGNALS ONLY
    // ======================================================

    if (
      bullishProbability >=
      MIN_PROBABILITY
    ) {

      return {
        symbol,
        bias: "BULLISH",
        probability:
          bullishProbability,
        volume
      };
    }

    if (
      bearishProbability >=
      MIN_PROBABILITY
    ) {

      return {
        symbol,
        bias: "BEARISH",
        probability:
          bearishProbability,
        volume
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

  console.log(
    chalk.yellow(
      "\nFETCHING LIQUID FUTURES PAIRS...\n"
    )
  );

  const pairs =
    await fetchAllPairs();

  console.log(
    chalk.cyan(
      `QUALIFIED LIQUID PAIRS: ${pairs.length}\n`
    )
  );

  const limit =
    pLimit(CONCURRENCY);

  const tasks =
    pairs.map(pair =>

      limit(async () => {

        const result =
          await analysePair(
            pair.symbol,
            pair.volume
          );

        // ==================================================
        // STREAM SIGNALS IMMEDIATELY
        // ==================================================

        if (result) {

          const color =
            result.bias ===
            "BULLISH"
              ? chalk.green
              : chalk.red;

          console.log(
            color(
              `[${new Date().toLocaleTimeString()}] `
            ) +
            chalk.white(
              result.symbol
            ) +
            " | " +
            color(result.bias) +
            " | " +
            chalk.yellow(
              result.probability +
              "%"
            ) +
            " | VOL: $" +
            (
              result.volume /
              1_000_000
            ).toFixed(1) +
            "M"
          );
        }

        // Small delay to reduce API stress

        await sleep(150);

      })
    );

  await Promise.all(tasks);

  console.log(
    chalk.cyan(
      "\nSCAN COMPLETE\n"
    )
  );
}

// ==========================================================
// START
// ==========================================================

runScanner().catch(err => {

  console.log(
    chalk.red(
      "\nSCANNER ERROR"
    )
  );

  console.log(err.message);

});
