// ==========================================================
// INSTITUTIONAL BINANCE FUTURES SCANNER v3
// ==========================================================
//
// MAJOR UPGRADES
// - Directional scoring fixed
// - Higher timeframe weighting
// - ADX directional logic (+DI / -DI)
// - Directional RVOL
// - Directional ATR expansion
// - Net score architecture
// - Realistic funding thresholds
// - Live streaming table
// - Duplicate update prevention
// - 24H volume filter
// - Better institutional weighting
// - Error visibility
//
// INSTALL
// npm install axios technicalindicators cli-table3 chalk p-limit
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

import Table from "cli-table3";
import chalk from "chalk";
import pLimit from "p-limit";

// ==========================================================
// CONFIG
// ==========================================================

const BASE_URL =
  "https://fapi.binance.com";

const TIMEFRAMES = [
  "15m",
  "1h",
  "4h",
  "1d"
];

const TF_WEIGHTS = {
  "15m": 1,
  "1h": 2,
  "4h": 3,
  "1d": 4
};

const LIMIT = 250;

const CONCURRENCY = 10;

const MIN_24H_VOLUME =
  20_000_000;

const STRONG_BULLISH = 60;
const STRONG_BEARISH = -60;

// ==========================================================
// LIVE RESULTS
// ==========================================================

const liveResults = [];

// ==========================================================
// HELPERS
// ==========================================================

function avg(arr) {
  return arr.reduce(
    (a, b) => a + b,
    0
  ) / arr.length;
}

function last(arr) {
  return arr[arr.length - 1];
}

function slope(
  arr,
  length = 10
) {

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

    cumulativeTPV +=
      tp * volume;

    cumulativeVolume +=
      volume;

    values.push(
      cumulativeTPV /
      cumulativeVolume
    );
  }

  return values;
}

// ==========================================================
// FETCH LIQUID PAIRS
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

  const volumeMap = {};

  for (const t of tickers.data) {

    volumeMap[t.symbol] =
      parseFloat(
        t.quoteVolume
      );
  }

  return exchangeInfo.data.symbols

    .filter(symbol => {

      const volume =
        volumeMap[
          symbol.symbol
        ] || 0;

      return (
        symbol.quoteAsset ===
          "USDT" &&
        symbol.status ===
          "TRADING" &&
        volume >=
          MIN_24H_VOLUME
      );
    })

    .map(symbol => ({
      symbol: symbol.symbol,
      volume:
        volumeMap[
          symbol.symbol
        ]
    }))

    .sort(
      (a, b) =>
        b.volume -
        a.volume
    );
}

// ==========================================================
// FETCH CANDLES
// ==========================================================

async function fetchCandles(
  symbol,
  interval
) {

  const res =
    await axios.get(
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
// FETCH OI
// ==========================================================

async function fetchOpenInterest(
  symbol
) {

  const res =
    await axios.get(
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

async function fetchFunding(
  symbol
) {

  const res =
    await axios.get(
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
// STRUCTURE
// ==========================================================

function analyseStructure(
  closes
) {

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
  const e200 =
    last(ema200);

  const latestPrice =
    last(closes);

  let score = 0;

  // EMA STACKING

  if (
    e20 > e50 &&
    e50 > e200
  ) {
    score += 30;
  }

  if (
    e20 < e50 &&
    e50 < e200
  ) {
    score -= 30;
  }

  // EMA SLOPE

  if (
    slope(ema20) > 0
  ) {
    score += 15;
  } else {
    score -= 15;
  }

  // PRICE POSITION

  if (
    latestPrice > e20
  ) {
    score += 10;
  } else {
    score -= 10;
  }

  return score;
}

// ==========================================================
// ATR
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

  const avgATR =
    avg(
      atr.slice(-50)
    );

  const ratio =
    latestATR /
    avgATR;

  let score = 0;

  if (ratio > 1.5) {

    const move =
      closes[
        closes.length - 1
      ] -
      closes[
        closes.length - 5
      ];

    if (move > 0) {
      score += 5;
    } else {
      score -= 5;
    }
  }

  return score;
}

// ==========================================================
// ADX DIRECTIONAL
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

  let score = 0;

  if (
    latest.adx > 25
  ) {

    if (
      latest.pdi >
      latest.mdi
    ) {
      score += 10;
    }

    if (
      latest.mdi >
      latest.pdi
    ) {
      score -= 10;
    }
  }

  return score;
}

// ==========================================================
// RVOL
// ==========================================================

function analyseRVOL(
  volumes,
  closes
) {

  const latest =
    last(volumes);

  const avgVolume =
    avg(
      volumes.slice(-50)
    );

  const rvol =
    latest / avgVolume;

  let score = 0;

  const move =
    closes[
      closes.length - 1
    ] -
    closes[
      closes.length - 5
    ];

  if (rvol > 1.5) {

    if (move > 0) {
      score += 10;
    } else {
      score -= 10;
    }
  }

  return score;
}

// ==========================================================
// VWAP
// ==========================================================

function analyseVWAP(
  candles,
  closes
) {

  const vwapValues =
    calculateVWAP(
      candles
    );

  const vwap =
    last(vwapValues);

  const latestPrice =
    last(closes);

  if (
    latestPrice > vwap
  ) {
    return 10;
  }

  return -10;
}

// ==========================================================
// MOMENTUM
// ==========================================================

function analyseMomentum(
  closes
) {

  let upCandles = 0;

  for (
    let i =
      closes.length - 10;
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

  if (upCandles >= 7) {
    return 15;
  }

  if (upCandles <= 3) {
    return -15;
  }

  return 0;
}

// ==========================================================
// OI
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

  // New longs

  if (
    priceChange > 0 &&
    oiChange > 0
  ) {
    return 15;
  }

  // Aggressive shorts

  if (
    priceChange < 0 &&
    oiChange > 0
  ) {
    return -15;
  }

  // Short covering

  if (
    priceChange > 0 &&
    oiChange < 0
  ) {
    return 8;
  }

  // Long liquidation

  return -8;
}

// ==========================================================
// FUNDING
// ==========================================================

function analyseFunding(
  data
) {

  const rates =
    data.map(x =>
      parseFloat(
        x.fundingRate
      )
    );

  const latest =
    last(rates);

  if (latest < -0.001) {
    return 5;
  }

  if (latest > 0.001) {
    return -5;
  }

  return 0;
}

// ==========================================================
// LIVE TABLE
// ==========================================================

function renderTable() {

  console.clear();

  console.log(
    chalk.yellow(
      "\nINSTITUTIONAL FUTURES SCANNER\n"
    )
  );

  const table =
    new Table({
      head: [
        "PAIR",
        "BIAS",
        "NET SCORE",
        "24H VOL"
      ],
      colWidths: [
        15,
        15,
        15,
        15
      ]
    });

  liveResults.sort(
    (a, b) =>
      Math.abs(
        b.netScore
      ) -
      Math.abs(
        a.netScore
      )
  );

  for (const r of liveResults) {

    table.push([

      r.symbol,

      r.bias ===
      "BULLISH"
        ? chalk.green(
            r.bias
          )
        : chalk.red(
            r.bias
          ),

      r.netScore,

      `$${(
        r.volume /
        1_000_000
      ).toFixed(1)}M`
    ]);
  }

  console.log(
    table.toString()
  );

  console.log(
    chalk.cyan(
      `\nLIVE SIGNALS: ${liveResults.length}\n`
    )
  );
}

// ==========================================================
// ANALYSE PAIR
// ==========================================================

async function analysePair(
  symbol,
  volume
) {

  try {

    let totalScore = 0;

    // ======================================================
    // MULTI-TIMEFRAME
    // ======================================================

    for (const tf of TIMEFRAMES) {

      const candles =
        await fetchCandles(
          symbol,
          tf
        );

      const closes =
        candles.map(c =>
          parseFloat(
            c[4]
          )
        );

      const highs =
        candles.map(c =>
          parseFloat(
            c[2]
          )
        );

      const lows =
        candles.map(c =>
          parseFloat(
            c[3]
          )
        );

      const volumes =
        candles.map(c =>
          parseFloat(
            c[5]
          )
        );

      let tfScore = 0;

      tfScore +=
        analyseStructure(
          closes
        );

      tfScore +=
        analyseATR(
          highs,
          lows,
          closes
        );

      tfScore +=
        analyseADX(
          highs,
          lows,
          closes
        );

      tfScore +=
        analyseRVOL(
          volumes,
          closes
        );

      tfScore +=
        analyseVWAP(
          candles,
          closes
        );

      tfScore +=
        analyseMomentum(
          closes
        );

      totalScore +=
        tfScore *
        TF_WEIGHTS[tf];
    }

    // ======================================================
    // DERIVATIVES
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
        parseFloat(
          c[4]
        )
      );

    totalScore +=
      analyseOI(
        oiData,
        closes
      );

    totalScore +=
      analyseFunding(
        fundingData
      );

    // ======================================================
    // CLASSIFICATION
    // ======================================================

    let bias = null;

    if (
      totalScore >=
      STRONG_BULLISH
    ) {
      bias = "BULLISH";
    }

    if (
      totalScore <=
      STRONG_BEARISH
    ) {
      bias = "BEARISH";
    }

    if (!bias) {
      return null;
    }

    return {
      symbol,
      bias,
      netScore:
        totalScore,
      volume
    };

  } catch (err) {

    console.log(
      chalk.red(
        `${symbol} ERROR: ${err.message}`
      )
    );

    return null;
  }
}

// ==========================================================
// MAIN
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
      `QUALIFIED PAIRS: ${pairs.length}\n`
    )
  );

  const limit =
    pLimit(
      CONCURRENCY
    );

  const tasks =
    pairs.map(pair =>

      limit(async () => {

        const result =
          await analysePair(
            pair.symbol,
            pair.volume
          );

        if (!result) {
          return;
        }

        // Prevent duplicates

        const existing =
          liveResults.find(
            x =>
              x.symbol ===
              result.symbol
          );

        if (
          existing
        ) {

          existing.bias =
            result.bias;

          existing.netScore =
            result.netScore;

          existing.volume =
            result.volume;

        } else {

          liveResults.push(
            result
          );
        }

        renderTable();

      })
    );

  await Promise.all(
    tasks
  );

  console.log(
    chalk.green(
      "\nSCAN COMPLETE\n"
    )
  );
}

// ==========================================================
// START
// ==========================================================

runScanner().catch(
  err => {

    console.log(
      chalk.red(
        "\nSCANNER ERROR"
      )
    );

    console.log(
      err.message
    );
  }
);
