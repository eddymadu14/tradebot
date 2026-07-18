// ======================================================
// btc-4h-regime-detector.js (PART 1)
// Node.js ES Module
// npm install axios technicalindicators
// ======================================================

import axios from "axios";
import {
  EMA,
  ATR,
  ADX
} from "technicalindicators";

// ======================================================
// CONFIG
// ======================================================

const SYMBOL = process.argv[2] || "BTCUSDT";
const INTERVAL = "4h";
const LIMIT = 100;

const BINANCE =
  "https://fapi.binance.com/fapi/v1/klines";

// ======================================================
// FETCH CANDLES
// ======================================================

async function fetchCandles() {

  const { data } = await axios.get(BINANCE, {
    params: {
      symbol: SYMBOL,
      interval: INTERVAL,
      limit: LIMIT
    }
  });

  return data.map(c => ({
    openTime: c[0],

    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),

    volume: Number(c[5]),

    closeTime: c[6]
  }));

}

// ======================================================
// ARRAYS
// ======================================================

function extract(candles) {

  return {

    close: candles.map(x => x.close),

    high: candles.map(x => x.high),

    low: candles.map(x => x.low)

  };

}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

  return EMA.calculate({
    period,
    values
  });

}

function lastEMA(values, period) {

  const ema = calculateEMA(values, period);

  return ema[ema.length - 1];

}

// ======================================================
// ATR
// ======================================================

function calculateATR(high, low, close) {

  const atr = ATR.calculate({

    high,
    low,
    close,

    period: 14

  });

  return atr;

}

function lastATR(high, low, close) {

  const atr = calculateATR(
    high,
    low,
    close
  );

  return atr[atr.length - 1];

}

// ======================================================
// ADX
// ======================================================

function calculateADX(high, low, close) {

  const adx = ADX.calculate({

    high,
    low,
    close,

    period: 14

  });

  return adx;

}

function lastADX(high, low, close) {

  const values = calculateADX(
    high,
    low,
    close
  );

  return values[values.length - 1];

}

// ======================================================
// LINEAR REGRESSION SLOPE
// ======================================================

function regressionSlope(values) {

  const n = values.length;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {

    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;

  }

  const numerator =
    n * sumXY -
    sumX * sumY;

  const denominator =
    n * sumXX -
    sumX * sumX;

  return numerator / denominator;

}

// ======================================================
// HIGHER HIGH / LOWER LOW STRUCTURE
// ======================================================

function marketStructure(candles) {

  let hh = 0;
  let hl = 0;

  let lh = 0;
  let ll = 0;

  for (let i = 1; i < candles.length; i++) {

    if (
      candles[i].high >
      candles[i - 1].high
    )
      hh++;

    if (
      candles[i].low >
      candles[i - 1].low
    )
      hl++;

    if (
      candles[i].high <
      candles[i - 1].high
    )
      lh++;

    if (
      candles[i].low <
      candles[i - 1].low
    )
      ll++;

  }

  return {

    hh,

    hl,

    lh,

    ll,

    bullish:
      hh + hl,

    bearish:
      lh + ll

  };

}

// ======================================================
// VOLATILITY (% ATR)
// ======================================================

function atrPercent(atr, price) {

  return (atr / price) * 100;

}

// ======================================================
// EMA ALIGNMENT
// ======================================================

function emaAlignment(

  ema20,
  ema50,
  ema100

) {

  if (
    ema20 >
    ema50 &&
    ema50 >
    ema100
  )
    return "BULL";

  if (
    ema20 <
    ema50 &&
    ema50 <
    ema100
  )
    return "BEAR";

  return "MIXED";

}

// ======================================================
// PREPARE METRICS
// ======================================================

async function prepareMetrics() {

  const candles =
    await fetchCandles();

  const {

    close,
    high,
    low

  } = extract(candles);

  const ema20 =
    lastEMA(close, 20);

  const ema50 =
    lastEMA(close, 50);

  const ema100 =
    lastEMA(close, 100);

  const atr =
    lastATR(
      high,
      low,
      close
    );

  const adx =
    lastADX(
      high,
      low,
      close
    );

  const slope =
    regressionSlope(
      close.slice(-50)
    );

  const structure =
    marketStructure(
      candles.slice(-50)
    );

  return {

    candles,

    currentPrice:
      close.at(-1),

    ema20,
    ema50,
    ema100,

    atr,

    atrPct:
      atrPercent(
        atr,
        close.at(-1)
      ),

    adx,

    slope,

    structure,

    alignment:
      emaAlignment(
        ema20,
        ema50,
        ema100
      )

  };

}

// ======================================================
// PART 2 CONTINUES...
// ======================================================
// ======================================================
// PART 2
// Append this BELOW Part 1
// ======================================================

// ------------------------------------------------------
// REGIME SCORING ENGINE
// ------------------------------------------------------

function detectRegime(metrics) {

  let bull = 0;
  let bear = 0;
  let range = 0;
  let choppy = 0;

  // ---------------- EMA Alignment ----------------

  if (metrics.alignment === "BULL")
    bull += 25;

  if (metrics.alignment === "BEAR")
    bear += 25;

  if (metrics.alignment === "MIXED")
    range += 15;

  // ---------------- ADX ----------------

  const adx = metrics.adx.adx;

  if (adx >= 30) {

    if (metrics.alignment === "BULL")
      bull += 20;

    if (metrics.alignment === "BEAR")
      bear += 20;

  } else if (adx < 20) {

    range += 25;

  }

  // ---------------- Linear Regression ----------------

  if (metrics.slope > 0)
    bull += 15;

  if (metrics.slope < 0)
    bear += 15;

  // ---------------- Market Structure ----------------

  if (
    metrics.structure.bullish >
    metrics.structure.bearish
  ) {

    bull += 20;

  }

  if (
    metrics.structure.bearish >
    metrics.structure.bullish
  ) {

    bear += 20;

  }

  // ---------------- Volatility ----------------

  if (metrics.atrPct > 2.5) {

    choppy += 30;

  }

  if (metrics.atrPct < 1.2) {

    range += 10;

  }

  // ---------------- Current Price ----------------

  if (
    metrics.currentPrice >
    metrics.ema20
  )
    bull += 10;

  if (
    metrics.currentPrice <
    metrics.ema20
  )
    bear += 10;

  // ---------------- Final Scores ----------------

  const scores = {
    Bull: bull,
    Bear: bear,
    Range: range,
    Choppy: choppy
  };

  const sorted =
    Object.entries(scores)
      .sort((a, b) => b[1] - a[1]);

  const regime = sorted[0][0];
  const confidence = sorted[0][1];

  return {
    regime,
    confidence,
    scores
  };

}

// ------------------------------------------------------
// RECOMMENDATION
// ------------------------------------------------------

function recommendation(regime) {

  switch (regime) {

    case "Bull":
      return "Trend-following LONG setups preferred.";

    case "Bear":
      return "Trend-following SHORT setups preferred.";

    case "Range":
      return "Mean reversion. Buy support, sell resistance.";

    case "Choppy":
      return "Avoid aggressive trades. Wait for expansion.";

    default:
      return "No clear edge.";

  }

}

// ------------------------------------------------------
// PRINT REPORT
// ------------------------------------------------------

function printReport(metrics, result) {

  console.clear();

  console.log(
    "\n=============================="
  );

  console.log(
        `${SYMBOL} 4H MARKET REGIME`
  );

  console.log(
    "==============================\n"
  );

  console.log(
    "Current Price:",
    metrics.currentPrice.toFixed(2)
  );

  console.log(
    "EMA20:",
    metrics.ema20.toFixed(2)
  );

  console.log(
    "EMA50:",
    metrics.ema50.toFixed(2)
  );

  console.log(
    "EMA100:",
    metrics.ema100.toFixed(2)
  );

  console.log("");

  console.log(
    "EMA Alignment:",
    metrics.alignment
  );

  console.log(
    "ADX:",
    metrics.adx.adx.toFixed(2)
  );

  console.log(
    "+DI:",
    metrics.adx.pdi.toFixed(2)
  );

  console.log(
    "-DI:",
    metrics.adx.mdi.toFixed(2)
  );

  console.log("");

  console.log(
    "ATR:",
    metrics.atr.toFixed(2)
  );

  console.log(
    "ATR %:",
    metrics.atrPct.toFixed(2) + "%"
  );

  console.log("");

  console.log(
    "Regression Slope:",
    metrics.slope.toFixed(2)
  );

  console.log("");

  console.log(
    "Bull Structure:",
    metrics.structure.bullish
  );

  console.log(
    "Bear Structure:",
    metrics.structure.bearish
  );

  console.log("");

  console.log(
    "Bull Score:",
    result.scores.Bull
  );

  console.log(
    "Bear Score:",
    result.scores.Bear
  );

  console.log(
    "Range Score:",
    result.scores.Range
  );

  console.log(
    "Choppy Score:",
    result.scores.Choppy
  );

  console.log("");

  console.log(
    "REGIME:",
    result.regime
  );

  console.log(
    "CONFIDENCE:",
    result.confidence + "%"
  );

  console.log("");

  console.log(
    recommendation(result.regime)
  );

  console.log(
    "\n==============================\n"
  );

}

// ------------------------------------------------------
// MAIN
// ------------------------------------------------------

async function main() {

  try {

    const metrics =
      await prepareMetrics();

    const result =
      detectRegime(metrics);

    printReport(
      metrics,
      result
    );

  } catch (err) {

    console.error(err.message);

  }

}

main();
