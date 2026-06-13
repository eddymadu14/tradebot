import axios from "axios";

const SYMBOL = "BTCUSDT";
const BINANCE = "https://api.binance.com";

/**
 * CLI ARG (target day)
 */
const targetDate = process.argv[2] || null;

/**
 * Convert date → timestamp range
 */
function getDayRange(dateStr) {
  const start = new Date(dateStr || new Date().toISOString().slice(0, 10));
  const startTime = start.getTime();
  const endTime = startTime + 86400000;

  return { startTime, endTime };
}

/**
 * Fetch klines
 */
async function getKlines(interval, limit = 1000, startTime, endTime) {
  const { data } = await axios.get(
    `${BINANCE}/api/v3/klines`,
    {
      params: {
        symbol: SYMBOL,
        interval,
        limit,
        startTime,
        endTime
      }
    }
  );

  return data.map(k => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5]
  }));
}

/**
 * STRUCTURE LOGIC (unchanged but safer indexing)
 */
function getCompletedDailyStructure(daily) {
  const completed = daily[daily.length - 1];
  const previous = daily[daily.length - 2];

  return {
    bullish:
      completed.high > previous.high &&
      completed.low > previous.low,
    bearish:
      completed.high < previous.high &&
      completed.low < previous.low
  };
}

function getCompleted4HStructure(h4) {
  const completed = h4[h4.length - 1];
  const previous = h4[h4.length - 2];

  return {
    bullish:
      completed.high > previous.high &&
      completed.low > previous.low,
    bearish:
      completed.high < previous.high &&
      completed.low < previous.low
  };
}

/**
 * Support / Resistance
 */
function getSupportResistance(h4) {
  const lookback = h4.slice(-20);

  return {
    support: Math.min(...lookback.map(c => c.low)),
    resistance: Math.max(...lookback.map(c => c.high))
  };
}

/**
 * Momentum
 */
function calculateMomentum(price, open) {
  return ((price - open) / open) * 100;
}

/**
 * BIAS ENGINE
 */
function calculateBias(data) {
  let score = 0;
  const conditions = [];

  // DAILY STRUCTURE (30)
  if (data.dailyStructure.bullish) {
    score += 30;
    conditions.push({ name: "Daily Structure", status: "Bullish", score: 30 });
  } else if (data.dailyStructure.bearish) {
    score -= 30;
    conditions.push({ name: "Daily Structure", status: "Bearish", score: -30 });
  }

  // YESTERDAY RANGE (20)
  if (data.price > data.yesterdayHigh) {
    score += 20;
    conditions.push({ name: "Break Y-High", status: "Bullish", score: 20 });
  } else if (data.price < data.yesterdayLow) {
    score -= 20;
    conditions.push({ name: "Break Y-Low", status: "Bearish", score: -20 });
  }

  // 4H STRUCTURE (25)
  if (data.h4Structure.bullish) {
    score += 25;
    conditions.push({ name: "4H Structure", status: "Bullish", score: 25 });
  } else if (data.h4Structure.bearish) {
    score -= 25;
    conditions.push({ name: "4H Structure", status: "Bearish", score: -25 });
  }

  // SUPPORT / RESISTANCE (15)
  const supportDist = ((data.price - data.support) / data.price) * 100;
  const resistanceDist = ((data.resistance - data.price) / data.price) * 100;

  if (supportDist <= 1.5) {
    score += 15;
    conditions.push({ name: "Support", status: "Bullish Zone", score: 15 });
  } else if (resistanceDist <= 1.5) {
    score -= 15;
    conditions.push({ name: "Resistance", status: "Bearish Zone", score: -15 });
  }

  // MOMENTUM (10)
  if (data.momentum > 0.5) {
    score += 10;
    conditions.push({ name: "Momentum", status: "Bullish", score: 10 });
  } else if (data.momentum < -0.5) {
    score -= 10;
    conditions.push({ name: "Momentum", status: "Bearish", score: -10 });
  }

  let bias = "NEUTRAL";

  if (score >= 70) bias = "STRONG_BULLISH";
  else if (score >= 40) bias = "BULLISH";
  else if (score <= -70) bias = "STRONG_BEARISH";
  else if (score <= -40) bias = "BEARISH";

  return {
    symbol: SYMBOL,
    bias,
    score,
    currentPrice: data.price,
    momentum: `${data.momentum.toFixed(2)}%`,
    conditions
  };
}

/**
 * MAIN CLI FUNCTION
 */
async function main() {
  const { startTime, endTime } = getDayRange(targetDate);

  // DAILY candles (context)
  const daily = await getKlines("1d", 50);

  // 4H candles FOR SELECTED DAY
  const h4 = await getKlines("4h", 100, startTime, endTime);

  if (h4.length < 3) {
    console.log("Not enough data for selected day.");
    return;
  }

  const price = h4[h4.length - 1].close;

  const yesterday = daily[daily.length - 2];

  const dailyStructure = getCompletedDailyStructure(daily);
  const h4Structure = getCompleted4HStructure(h4);

  const { support, resistance } = getSupportResistance(h4);

  const dayOpen = h4[0].open;
  const momentum = calculateMomentum(price, dayOpen);

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

  console.log("\nBTC DAILY BIAS REPORT");
  console.log("=====================");
  console.log(JSON.stringify(result, null, 2));
}

/**
 * RUN
 */
main().catch(console.error);
