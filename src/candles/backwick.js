import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOL = "BTCUSDT";
const INTERVAL = "1w";
const LIMIT = 60; // fetch extra, slice to last 1 year

const START_CAPITAL = 100;
const RISK_PER_TRADE = 0.01;
const TP_PCT = 0.03;
const SL_PCT = 0.03;

async function fetchWeeklyCandles() {
  const { data } = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
    params: { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT }
  });
  return data;
}

function candleType(open, close) {
  if (close > open) return "BULL";
  if (close < open) return "BEAR";
  return "DOJI";
}

async function run() {
  const candlesRaw = await fetchWeeklyCandles();

  // use only last 1 year (~52 candles)
  const candles = candlesRaw.slice(-53);

  let capital = START_CAPITAL;
  let wins = 0;
  let losses = 0;
  let totalProfit = 0;
  let totalLoss = 0;

  console.log("\nBTC Weekly Strategy Backtest (1Y)\n");

  for (let i = 0; i < candles.length - 1; i++) {
    const [ , open, , , close ] = candles[i];
    const type = candleType(Number(open), Number(close));

    if (type === "DOJI") continue;

    const next = candles[i + 1];
    const entry = Number(next[1]);
    const high = Number(next[2]);
    const low = Number(next[3]);

    const riskAmount = capital * RISK_PER_TRADE;
    let tp, sl, result;

    if (type === "BULL") {
      tp = entry * (1 + TP_PCT);
      sl = entry * (1 - SL_PCT);

      if (low <= sl) {
        result = "LOSS";
      } else if (high >= tp) {
        result = "WIN";
      }
    }

    if (type === "BEAR") {
      tp = entry * (1 - TP_PCT);
      sl = entry * (1 + SL_PCT);

      if (high >= sl) {
        result = "LOSS";
      } else if (low <= tp) {
        result = "WIN";
      }
    }

    if (!result) continue;

    if (result === "WIN") {
      const profit = riskAmount * (TP_PCT / SL_PCT);
      capital += profit;
      totalProfit += profit;
      wins++;
    }

    if (result === "LOSS") {
      capital -= riskAmount;
      totalLoss += riskAmount;
      losses++;
    }

    console.log(
      `${new Date(next[0]).toISOString().split("T")[0]} | ${type} | ${result} | Capital: $${capital.toFixed(2)}`
    );
  }

  console.log("\n===== FINAL REPORT =====");
  console.table({
    "Starting Capital": `$${START_CAPITAL}`,
    "Ending Capital": `$${capital.toFixed(2)}`,
    "Total Trades": wins + losses,
    Wins: wins,
    Losses: losses,
    "Total Profit": `$${totalProfit.toFixed(2)}`,
    "Total Loss": `$${totalLoss.toFixed(2)}`
  });
}

run().catch(err => console.error(err.message));
