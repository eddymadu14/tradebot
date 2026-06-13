import axios from "axios";

const SYMBOL = "BTCUSDT";
const BINANCE = "https://api.binance.com";

/**
 * =========================
 * CLI INPUT
 * =========================
 */
const targetDate = process.argv[2];

if (!targetDate) {
  console.log("Usage: node btcBias.js YYYY-MM-DD");
  process.exit(1);
}

const dayStart = new Date(targetDate).setUTCHours(0, 0, 0, 0);
const dayEnd = dayStart + 24 * 60 * 60 * 1000;

/**
 * =========================
 * BINANCE FETCH
 * =========================
 */
async function getKlines(interval, limit = 1000) {
  const { data } = await axios.get(`${BINANCE}/api/v3/klines`, {
    params: {
      symbol: SYMBOL,
      interval,
      limit
    }
  });

  return data.map(k => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6]
  }));
}

/**
 * =========================
 * FILTER HELPERS
 * =========================
 */
function filterBeforeDate(candles, cutoff) {
  return candles.filter(c => c.openTime < cutoff);
}

function getTargetDayCandles(candles, start, end) {
  return candles.filter(
    c => c.openTime >= start && c.openTime < end
  );
}

function getCompletedCandles(candles, max = 2) {
  return candles.slice(0, max);
}

/**
 * =========================
 * STRUCTURE LOGIC
 * =========================
 */
function getCompletedDailyStructure(daily) {
  if (daily.length < 3) return { bullish: false, bearish: false };

  const completed = daily[daily.length - 2];
  const previous = daily[daily.length - 3];

  const bullish =
    completed.high > previous.high &&
    completed.low > previous.low;

  const bearish =
    completed.high < previous.high &&
    completed.low < previous.low;

  return { bullish, bearish };
}

function getCompleted4HStructure(h4) {
  if (h4.length < 3) return { bullish: false, bearish: false };

  const completed = h4[h4.length - 2];
  const previous = h4[h4.length - 3];

  const bullish =
    completed.high > previous.high &&
    completed.low > previous.low;

  const bearish =
    completed.high < previous.high &&
    completed.low < previous.low;

  return { bullish, bearish };
}

/**
 * =========================
 * SUPPORT / RESISTANCE
 * =========================
 */
function getSupportResistance(h4) {
  const lookback = h4.slice(-20);

  const support = Math.min(...lookback.map(c => c.low));
  const resistance = Math.max(...lookback.map(c => c.high));

  return { support, resistance };
}

/**
 * =========================
 * MOMENTUM
 * =========================
 */
function calculateMomentum(price, open) {
  return ((price - open) / open) * 100;
}

/**
 * =========================
 * SCORING ENGINE (UNCHANGED)
 * =========================
 */
function calculateBias(data) {
  let score = 0;
  const conditions = [];

  if (data.dailyStructure.bullish) {
    score += 30;
    conditions.push({ name: "Daily Structure", status: "Bullish", score: 30 });
  } else if (data.dailyStructure.bearish) {
    score -= 30;
    conditions.push({ name: "Daily Structure", status: "Bearish", score: -30 });
  } else {
    conditions.push({ name: "Daily Structure", status: "Neutral", score: 0 });
  }

  if (data.price > data.yesterdayHigh) {
    score += 20;
    conditions.push({ name: "Break Y-High", status: "Bullish", score: 20 });
  } else if (data.price < data.yesterdayLow) {
    score -= 20;
    conditions.push({ name: "Break Y-Low", status: "Bearish", score: -20 });
  } else {
    conditions.push({ name: "Yesterday Range", status: "Neutral", score: 0 });
  }

  if (data.h4Structure.bullish) {
    score += 25;
    conditions.push({ name: "4H Structure", status: "Bullish", score: 25 });
  } else if (data.h4Structure.bearish) {
    score -= 25;
    conditions.push({ name: "4H Structure", status: "Bearish", score: -25 });
  } else {
    conditions.push({ name: "4H Structure", status: "Neutral", score: 0 });
  }

  const supportDistance =
    ((data.price - data.support) / data.price) * 100;

  const resistanceDistance =
    ((data.resistance - data.price) / data.price) * 100;

  if (supportDistance <= 1.5) {
    score += 15;
    conditions.push({ name: "Support Zone", status: "Bullish", score: 15 });
  } else if (resistanceDistance <= 1.5) {
    score -= 15;
    conditions.push({ name: "Resistance Zone", status: "Bearish", score: -15 });
  } else {
    conditions.push({ name: "Liquidity Zone", status: "Neutral", score: 0 });
  }

  if (data.momentum > 0.5) {
    score += 10;
    conditions.push({ name: "Session Momentum", status: "Bullish", score: 10 });
  } else if (data.momentum < -0.5) {
    score -= 10;
    conditions.push({ name: "Session Momentum", status: "Bearish", score: -10 });
  } else {
    conditions.push({ name: "Session Momentum", status: "Neutral", score: 0 });
  }

  let bias = "NEUTRAL";

  if (score >= 70) bias = "STRONG_BULLISH";
  else if (score >= 40) bias = "BULLISH";
  else if (score <= -70) bias = "STRONG_BEARISH";
  else if (score <= -40) bias = "BEARISH";

  return {
    symbol: SYMBOL,
    date: targetDate,
    score,
    bias,
    momentum: data.momentum.toFixed(2) + "%",
    support: data.support,
    resistance: data.resistance,
    conditions
  };
}

/**
 * =========================
 * MAIN ENGINE
 * =========================
 */
async function main() {
  console.log(`Predicting BTC bias for ${targetDate}...\n`);

  const dailyAll = await getKlines("1d", 1000);
  const h4All = await getKlines("4h", 1000);

  const dailyHistory = filterBeforeDate(dailyAll, dayStart);
  const h4History = filterBeforeDate(h4All, dayStart);

  const targetDayH4 = getTargetDayCandles(h4All, dayStart, dayEnd);
  const completedTargetDayH4 = getCompletedCandles(targetDayH4, 2);

  const mode =
    completedTargetDayH4.length === 0
      ? "FORECAST"
      : completedTargetDayH4.length === 1
      ? "CONFIRMATION_4H"
      : "CONFIRMATION_8H";

  if (dailyHistory.length < 10 || h4History.length < 20) {
    console.log("Not enough historical data.");
    return;
  }

  const yesterday = dailyHistory[dailyHistory.length - 1];

  let price = yesterday.close;
  if (completedTargetDayH4.length > 0) {
    price = completedTargetDayH4[completedTargetDayH4.length - 1].close;
  }

  const h4Context = [...h4History, ...completedTargetDayH4];

  const dailyStructure = getCompletedDailyStructure(dailyHistory);
  const h4Structure = getCompleted4HStructure(h4Context);

  const { support, resistance } = getSupportResistance(h4Context);

  let momentum;
  if (completedTargetDayH4.length === 0) {
    momentum = calculateMomentum(yesterday.close, yesterday.open);
  } else {
    momentum = calculateMomentum(price, yesterday.close);
  }

  const result = calculateBias({
    price,
    yesterdayHigh: yesterday.high,
    yesterdayLow: yesterday.low,
    dailyStructure,
    h4Structure,
    support,
    resistance,
    momentum
  });

  console.log(
    JSON.stringify(
      {
        mode,
        completedTargetDayCandles: completedTargetDayH4.length,
        ...result
      },
      null,
      2
    )
  );
}

main().catch(console.error);
