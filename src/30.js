import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1w";
const CONCURRENCY = 10;
const limit = pLimit(CONCURRENCY);

async function getAllFuturesPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING" &&
        s.quoteAsset === "USDT"
    )
    .map((s) => s.symbol);
}

async function getWeeklyCandles(symbol) {
  try {
    const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: {
        symbol,
        interval: INTERVAL,
        limit: 3, // get last 3 weekly candles
      },
    });

    if (data.length < 2) return null;

    // Use previous CLOSED candle
    const previousWeek = data[data.length - 2];

    const open = parseFloat(previousWeek[1]);
    const close = parseFloat(previousWeek[4]);
    const high = parseFloat(previousWeek[2]);
    const low = parseFloat(previousWeek[3]);
    const volume = parseFloat(previousWeek[5]);

    const percentMove = ((close - open) / open) * 100;

    return {
      symbol,
      open,
      close,
      high,
      low,
      volume,
      percentMove,
    };
  } catch (err) {
    return null;
  }
}

async function scan() {
  console.log("Fetching futures pairs...");
  const symbols = await getAllFuturesPairs();
  console.log(`Scanning ${symbols.length} pairs...\n`);

  const results = [];

  await Promise.all(
    symbols.map((symbol) =>
      limit(async () => {
        const data = await getWeeklyCandles(symbol);
        if (!data) return;

        if (Math.abs(data.percentMove) >= 30) {
          results.push(data);
        }
      })
    )
  );

  if (results.length === 0) {
    console.log("No pairs moved 30%+ last week.");
    return;
  }

  // Sort by absolute % move descending
  results.sort(
    (a, b) => Math.abs(b.percentMove) - Math.abs(a.percentMove)
  );

  console.log("\n=== Pairs That Moved ≥ 30% Last Week ===\n");

  results.forEach((r) => {
    console.log(
      `${r.symbol} | Move: ${r.percentMove.toFixed(2)}% | O: ${r.open} C: ${r.close} | Vol: ${r.volume}`
    );
  });

  console.log(`\nTotal Matches: ${results.length}`);
}

scan();
