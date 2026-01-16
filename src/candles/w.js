import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1w";
const LIMIT = 200;

async function fetchWeeklyCandles() {
  const { data } = await axios.get(
    `${BINANCE_BASE}/api/v3/klines`,
    {
      params: {
        symbol: SYMBOL,
        interval: INTERVAL,
        limit: LIMIT
      }
    }
  );
  return data;
}

function analyzeCandle(candle) {
  const [
    openTime,
    open,
    high,
    low,
    close
  ] = candle;

  const o = Number(open);
  const h = Number(high);
  const l = Number(low);
  const c = Number(close);

  let type = "DOJI";
  if (c > o) type = "BULL";
  if (c < o) type = "BEAR";

  let upperWickPct = null;
  let lowerWickPct = null;

  if (type === "BEAR") {
    upperWickPct = ((h - Math.max(o, c)) / o) * 100;
  }

  if (type === "BULL") {
    lowerWickPct = ((Math.min(o, c) - l) / o) * 100;
  }

  return {
    week: new Date(openTime).toISOString().split("T")[0],
    type,
    upperWickPct: upperWickPct !== null ? Number(upperWickPct.toFixed(2)) : null,
    lowerWickPct: lowerWickPct !== null ? Number(lowerWickPct.toFixed(2)) : null
  };
}

async function run() {
  console.log("BTC Weekly Directional Wick Analysis\n");

  const candles = await fetchWeeklyCandles();
  const analyzed = candles
    .map(analyzeCandle)
    .filter(c => c.type !== "DOJI");

  analyzed.forEach(c => {
    if (c.type === "BEAR") {
      console.log(
        `${c.week} | BEAR | Upper Wick: ${c.upperWickPct}%`
      );
    }

    if (c.type === "BULL") {
      console.log(
        `${c.week} | BULL | Lower Wick: ${c.lowerWickPct}%`
      );
    }
  });
}

run().catch(err => {
  console.error("Error:", err.message);
});
