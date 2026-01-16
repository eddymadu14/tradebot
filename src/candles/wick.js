import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1w";
const LIMIT = 200; // ~4 years of weekly data

async function fetchWeeklyCandles() {
  const url = `${BINANCE_BASE}/api/v3/klines`;
  const { data } = await axios.get(url, {
    params: {
      symbol: SYMBOL,
      interval: INTERVAL,
      limit: LIMIT
    }
  });
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

  const type = c > o ? "BULL" : c < o ? "BEAR" : "DOJI";

  const upperWickPct =
    ((h - Math.max(o, c)) / o) * 100;

  const lowerWickPct =
    ((Math.min(o, c) - l) / o) * 100;

  return {
    week: new Date(openTime).toISOString().split("T")[0],
    open: o,
    high: h,
    low: l,
    close: c,
    type,
    upperWickPct: Number(upperWickPct.toFixed(2)),
    lowerWickPct: Number(lowerWickPct.toFixed(2))
  };
}

async function run() {
  console.log("Fetching BTC weekly candles...\n");

  const candles = await fetchWeeklyCandles();

  const analyzed = candles.map(analyzeCandle);

  analyzed.forEach(c => {
    console.log(
      `${c.week} | ${c.type} | Upper Wick: ${c.upperWickPct}% | Lower Wick: ${c.lowerWickPct}%`
    );
  });

  const summary = {
    total: analyzed.length,
    bull: analyzed.filter(c => c.type === "BULL").length,
    bear: analyzed.filter(c => c.type === "BEAR").length,
    avgUpperWickPct: (
      analyzed.reduce((s, c) => s + c.upperWickPct, 0) / analyzed.length
    ).toFixed(2),
    avgLowerWickPct: (
      analyzed.reduce((s, c) => s + c.lowerWickPct, 0) / analyzed.length
    ).toFixed(2)
  };

  console.log("\nSUMMARY");
  console.table(summary);
}

run().catch(err => {
  console.error("Error:", err.message);
});
