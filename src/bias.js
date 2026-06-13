import axios from "axios";

const SYMBOL = "BCHUSDT";
const BINANCE = "https://api.binance.com";

async function getKlines(interval, limit) {
  const { data } = await axios.get(
    `${BINANCE}/api/v3/klines`,
    {
      params: {
        symbol: SYMBOL,
        interval,
        limit
      }
    }
  );

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

function getCompletedDailyStructure(daily) {
  const completed = daily[daily.length - 2];
  const previous = daily[daily.length - 3];

  const bullish =
    completed.high > previous.high &&
    completed.low > previous.low;

  const bearish =
    completed.high < previous.high &&
    completed.low < previous.low;

  return {
    bullish,
    bearish,
    completed,
    previous
  };
}

function getCompleted4HStructure(h4) {
  const completed = h4[h4.length - 2];
  const previous = h4[h4.length - 3];

  const bullish =
    completed.high > previous.high &&
    completed.low > previous.low;

  const bearish =
    completed.high < previous.high &&
    completed.low < previous.low;

  return {
    bullish,
    bearish,
    completed,
    previous
  };
}

function getSupportResistance(h4) {
  const completedCandles =
    h4.slice(0, -1);

  const lookback =
    completedCandles.slice(-20);

  const support = Math.min(
    ...lookback.map(c => c.low)
  );

  const resistance = Math.max(
    ...lookback.map(c => c.high)
  );

  return {
    support,
    resistance
  };
}

function calculateMomentum(price, dayOpen) {
  return (
    ((price - dayOpen) / dayOpen) * 100
  );
}

function calculateBias(data) {
  let score = 0;

  const conditions = [];

  if (data.dailyStructure.bullish) {
    score += 30;

    conditions.push({
      name: "Daily Structure",
      status: "Bullish",
      score: 30
    });
  } else if (data.dailyStructure.bearish) {
    score -= 30;

    conditions.push({
      name: "Daily Structure",
      status: "Bearish",
      score: -30
    });
  } else {
    conditions.push({
      name: "Daily Structure",
      status: "Neutral",
      score: 0
    });
  }

  if (data.price > data.yesterdayHigh) {
    score += 20;

    conditions.push({
      name: "Yesterday High/Low",
      status: "Bullish",
      score: 20
    });
  } else if (data.price < data.yesterdayLow) {
    score -= 20;

    conditions.push({
      name: "Yesterday High/Low",
      status: "Bearish",
      score: -20
    });
  } else {
    conditions.push({
      name: "Yesterday High/Low",
      status: "Neutral",
      score: 0
    });
  }

  if (data.h4Structure.bullish) {
    score += 25;

    conditions.push({
      name: "4H Structure",
      status: "Bullish",
      score: 25
    });
  } else if (data.h4Structure.bearish) {
    score -= 25;

    conditions.push({
      name: "4H Structure",
      status: "Bearish",
      score: -25
    });
  } else {
    conditions.push({
      name: "4H Structure",
      status: "Neutral",
      score: 0
    });
  }

  const supportDistance =
    ((data.price - data.support) /
      data.price) *
    100;

  const resistanceDistance =
    ((data.resistance - data.price) /
      data.price) *
    100;

  if (supportDistance <= 1.5) {
    score += 15;

    conditions.push({
      name: "Support",
      status: "Near Support",
      score: 15
    });
  } else if (
    resistanceDistance <= 1.5
  ) {
    score -= 15;

    conditions.push({
      name: "Resistance",
      status: "Near Resistance",
      score: -15
    });
  } else {
    conditions.push({
      name: "Support/Resistance",
      status: "Neutral",
      score: 0
    });
  }

  if (data.momentum > 0.5) {
    score += 10;

    conditions.push({
      name: "Session Momentum",
      status: "Bullish",
      score: 10
    });
  } else if (data.momentum < -0.5) {
    score -= 10;

    conditions.push({
      name: "Session Momentum",
      status: "Bearish",
      score: -10
    });
  } else {
    conditions.push({
      name: "Session Momentum",
      status: "Neutral",
      score: 0
    });
  }

  let bias = "NEUTRAL";

  if (score >= 70)
    bias = "STRONG_BULLISH";
  else if (score >= 40)
    bias = "BULLISH";
  else if (score <= -70)
    bias = "STRONG_BEARISH";
  else if (score <= -40)
    bias = "BEARISH";

  return {
    symbol: SYMBOL,
    currentPrice: data.price,
    score,
    bias,
    momentum:
      data.momentum.toFixed(2) + "%",
    support: data.support,
    resistance: data.resistance,
    conditions
  };
}

async function main() {
  const daily =
    await getKlines("1d", 50);

  const h4 =
    await getKlines("4h", 100);

  const livePrice =
    h4[h4.length - 1].close;

  const yesterday =
    daily[daily.length - 2];

  const currentDay =
    daily[daily.length - 1];

  const dailyStructure =
    getCompletedDailyStructure(
      daily
    );

  const h4Structure =
    getCompleted4HStructure(h4);

  const {
    support,
    resistance
  } = getSupportResistance(h4);

  const momentum =
    calculateMomentum(
      livePrice,
      currentDay.open
    );

  const result = calculateBias({
    price: livePrice,
    yesterdayHigh: yesterday.high,
    yesterdayLow: yesterday.low,
    dailyStructure,
    h4Structure,
    support,
    resistance,
    momentum
  });

  console.log(
    JSON.stringify(result, null, 2)
  );
}

main().catch(console.error);
