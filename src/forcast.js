import axios from "axios";

const SYMBOL = "BTCUSDT";
const BINANCE = "https://api.binance.com";

const targetDate = process.argv[2];

if (!targetDate) {
  console.log("Usage:");
  console.log("node btcBias.js YYYY-MM-DD");
  process.exit(1);
}

const dayStart = new Date(targetDate).setUTCHours(
  0,
  0,
  0,
  0
);

async function getKlines(
  interval,
  limit = 1000
) {
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

function filterBeforeDate(
  candles,
  cutoff
) {
  return candles.filter(
    c => c.openTime < cutoff
  );
}

function getDailyStructure(
  candles
) {
  const completed =
    candles[candles.length - 2];

  const previous =
    candles[candles.length - 3];

  const bullish =
    completed.high >
      previous.high &&
    completed.low >
      previous.low;

  const bearish =
    completed.high <
      previous.high &&
    completed.low <
      previous.low;

  return {
    bullish,
    bearish
  };
}

function get4HStructure(
  candles
) {
  const completed =
    candles[candles.length - 2];

  const previous =
    candles[candles.length - 3];

  const bullish =
    completed.high >
      previous.high &&
    completed.low >
      previous.low;

  const bearish =
    completed.high <
      previous.high &&
    completed.low <
      previous.low;

  return {
    bullish,
    bearish
  };
}

function getCloseLocation(
  candle
) {
  const range =
    candle.high - candle.low;

  if (range === 0)
    return 0.5;

  return (
    (candle.close -
      candle.low) /
    range
  );
}

function getSupportResistance(
  h4
) {
  const lookback =
    h4.slice(-20);

  const support =
    Math.min(
      ...lookback.map(
        c => c.low
      )
    );

  const resistance =
    Math.max(
      ...lookback.map(
        c => c.high
      )
    );

  return {
    support,
    resistance
  };
}

function getMomentum(
  candle
) {
  return (
    ((candle.close -
      candle.open) /
      candle.open) *
    100
  );
}

function calculateBias(
  context
) {
  let score = 0;

  const conditions =
    [];

  // DAILY STRUCTURE

  if (
    context.dailyStructure
      .bullish
  ) {
    score += 30;

    conditions.push({
      name: "Daily Structure",
      status:
        "Bullish",
      score: 30
    });
  } else if (
    context.dailyStructure
      .bearish
  ) {
    score -= 30;

    conditions.push({
      name: "Daily Structure",
      status:
        "Bearish",
      score: -30
    });
  }

  // 4H STRUCTURE

  if (
    context.h4Structure
      .bullish
  ) {
    score += 25;

    conditions.push({
      name: "4H Structure",
      status:
        "Bullish",
      score: 25
    });
  } else if (
    context.h4Structure
      .bearish
  ) {
    score -= 25;

    conditions.push({
      name: "4H Structure",
      status:
        "Bearish",
      score: -25
    });
  }

  // CLOSE LOCATION

  if (
    context.closeLocation >=
    0.70
  ) {
    score += 20;

    conditions.push({
      name:
        "Close Location",
      status:
        "Bullish",
      score: 20
    });
  } else if (
    context.closeLocation <=
    0.30
  ) {
    score -= 20;

    conditions.push({
      name:
        "Close Location",
      status:
        "Bearish",
      score: -20
    });
  }

  // SUPPORT RESISTANCE

  const supportDistance =
    ((context.price -
      context.support) /
      context.price) *
    100;

  const resistanceDistance =
    ((context.resistance -
      context.price) /
      context.price) *
    100;

  if (
    supportDistance <=
    1.5
  ) {
    score += 15;

    conditions.push({
      name: "Support",
      status:
        "Bullish",
      score: 15
    });
  } else if (
    resistanceDistance <=
    1.5
  ) {
    score -= 15;

    conditions.push({
      name:
        "Resistance",
      status:
        "Bearish",
      score: -15
    });
  }

  // MOMENTUM

  if (
    context.momentum > 1
  ) {
    score += 10;

    conditions.push({
      name:
        "Momentum",
      status:
        "Bullish",
      score: 10
    });
  } else if (
    context.momentum < -1
  ) {
    score -= 10;

    conditions.push({
      name:
        "Momentum",
      status:
        "Bearish",
      score: -10
    });
  }

  let bias =
    "NEUTRAL";

  if (score >= 70)
    bias =
      "STRONG_BULLISH";
  else if (
    score >= 40
  )
    bias =
      "BULLISH";
  else if (
    score <= -70
  )
    bias =
      "STRONG_BEARISH";
  else if (
    score <= -40
  )
    bias =
      "BEARISH";

  return {
    symbol: SYMBOL,
    forecastDate:
      targetDate,
    score,
    bias,
    conditions
  };
}

async function main() {
  console.log(
    `Forecasting BTC bias for ${targetDate}`
  );

  const daily =
    await getKlines(
      "1d",
      1000
    );

  const h4 =
    await getKlines(
      "4h",
      1000
    );

  const dailyHistory =
    filterBeforeDate(
      daily,
      dayStart
    );

  const h4History =
    filterBeforeDate(
      h4,
      dayStart
    );

  if (
    dailyHistory.length <
      10 ||
    h4History.length <
      20
  ) {
    console.log(
      "Insufficient history"
    );
    return;
  }

  const yesterday =
    dailyHistory[
      dailyHistory.length -
        1
    ];

  const price =
    yesterday.close;

  const dailyStructure =
    getDailyStructure(
      dailyHistory
    );

  const h4Structure =
    get4HStructure(
      h4History
    );

  const closeLocation =
    getCloseLocation(
      yesterday
    );

  const {
    support,
    resistance
  } =
    getSupportResistance(
      h4History
    );

  const momentum =
    getMomentum(
      yesterday
    );

  const result =
    calculateBias({
      price,
      dailyStructure,
      h4Structure,
      closeLocation,
      support,
      resistance,
      momentum
    });

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
}

main().catch(
  console.error
);
