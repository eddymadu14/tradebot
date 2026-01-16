import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1w";
const LIMIT = 60;

const START_CAPITAL = 100;
const RISK_PCT = 0.01;
const TP_PCT = 0.01;
const SL_PCT = 0.03;

async function fetchWeeklyCandles() {
  const { data } = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
    params: { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT }
  });
  return data;
}

function candleType(o, c) {
  if (c > o) return "BULL";
  if (c < o) return "BEAR";
  return "DOJI";
}

async function run() {
  const raw = await fetchWeeklyCandles();
  const candles = raw.slice(-53); // ~1 year

  let capital = START_CAPITAL;
  let wins = 0;
  let losses = 0;
  let failed = 0;
  let totalProfit = 0;
  let totalLoss = 0;

  console.log("\nBTC Weekly 1-Week Timeboxed Backtest\n");

  for (let i = 0; i < candles.length - 1; i++) {
    const [, open, , , close] = candles[i];
    const type = candleType(+open, +close);
    if (type === "DOJI") continue;

    const next = candles[i + 1];
    const entry = +next[1];
    const high = +next[2];
    const low = +next[3];

    const risk = capital * RISK_PCT;
    let outcome = "FAILED";

    // ===================
    // LONG (Bull candle)
    // ===================
    if (type === "BULL") {
      const tp = entry * (1 + TP_PCT);
      const sl = entry * (1 - SL_PCT);

      if (high >= tp) {
        outcome = "WIN";
        capital += risk;
        totalProfit += risk;
        wins++;
      } else if (low <= sl) {
        outcome = "LOSS";
        capital -= risk;
        totalLoss += risk;
        losses++;
      } else {
        failed++;
      }
    }

    // ===================
    // SHORT (Bear candle)
    // ===================
    if (type === "BEAR") {
      const tp = entry * (1 - TP_PCT);
      const sl = entry * (1 + SL_PCT);

      if (low <= tp) {
        outcome = "WIN";
        capital += risk;
        totalProfit += risk;
        wins++;
      } else if (high >= sl) {
        outcome = "LOSS";
        capital -= risk;
        totalLoss += risk;
        losses++;
      } else {
        failed++;
      }
    }

    console.log(
      `${new Date(next[0]).toISOString().split("T")[0]} | ${type} | ${outcome} | Capital: $${capital.toFixed(2)}`
    );
  }

  console.log("\n===== FINAL REPORT =====");
  console.table({
    "Starting Capital": `$${START_CAPITAL}`,
    "Ending Capital": `$${capital.toFixed(2)}`,
    Wins: wins,
    Losses: losses,
    Failed: failed,
    "Total Profit": `$${totalProfit.toFixed(2)}`,
    "Total Loss": `$${totalLoss.toFixed(2)}`
  });
}

run().catch(err => console.error(err.message));
