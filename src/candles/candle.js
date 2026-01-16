/**
 * Daily Bull/Bear Candle Analyzer
 * Assets: BTCUSDT, ETHUSDT
 * Timeframe: 1D
 * Lookback: ~1 year (365 candles)
 */

import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "1d";
const LIMIT = 365;

/**
 * Fetch daily candles from Binance
 */
async function fetchDailyCandles(symbol) {
  const url = `${BINANCE_BASE}/api/v3/klines`;

  const { data } = await axios.get(url, {
    params: {
      symbol,
      interval: INTERVAL,
      limit: LIMIT,
    },
  });

  return data;
}

/**
 * Analyze candles: bull vs bear
 */
function analyzeCandles(symbol, candles) {
  let bullCount = 0;
  let bearCount = 0;

  console.log(
    `\n📊 ${symbol} Daily Candle Breakdown (Last ${candles.length} Days)\n`
  );

  candles.forEach((candle, index) => {
    const [
      openTime,
      open,
      high,
      low,
      close,
      volume,
    ] = candle;

    const o = Number(open);
    const c = Number(close);

    let type = "DOJI";

    if (c > o) {
      type = "BULL";
      bullCount++;
    } else if (c < o) {
      type = "BEAR";
      bearCount++;
    }

    console.log(
      `${index + 1}. ${new Date(openTime).toISOString().slice(0, 10)} | ` +
      `Open: ${o} | Close: ${c} | ${type}`
    );
  });

  console.log(`\n✅ ${symbol} SUMMARY`);
  console.log(`Bull Candles: ${bullCount}`);
  console.log(`Bear Candles: ${bearCount}`);
  console.log(`Total Candles: ${candles.length}`);
  console.log(`Bull %: ${((bullCount / candles.length) * 100).toFixed(2)}%`);
  console.log(`Bear %: ${((bearCount / candles.length) * 100).toFixed(2)}%`);

  return { bullCount, bearCount };
}

/**
 * Main runner
 */
async function run() {
  try {
    for (const symbol of SYMBOLS) {
      const candles = await fetchDailyCandles(symbol);
      analyzeCandles(symbol, candles);
    }
  } catch (err) {
    console.error("❌ Error:", err?.message || err);
  }
}

run();
