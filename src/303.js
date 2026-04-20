import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1w";
const CONCURRENCY = 10;
const THRESHOLD = 10; // minimum 10% move
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

async function getWeeklyData(symbol) {
  try {
    const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: {
        symbol,
        interval: INTERVAL,
        limit: 5, // get enough candles
      },
    });

    if (data.length < 4) return null;

    // Remove current forming candle
    const closedCandles = data.slice(0, -1);

    // Take last 3 fully closed candles
    const lastThree = closedCandles.slice(-3);

    const moves = [];
    const directions = [];

    for (let candle of lastThree) {
      const open = parseFloat(candle[1]);
      const close = parseFloat(candle[4]);

      const percentMove = ((close - open) / open) * 100;

      // Disqualify if move < threshold
      if (Math.abs(percentMove) < THRESHOLD) return null;

      moves.push(percentMove.toFixed(2));
      directions.push(percentMove > 0 ? "positive" : "negative");
    }

    // Only qualify if all 3 moves are same direction
    const firstDir = directions[0];
    const allSame = directions.every((d) => d === firstDir);

    if (allSame) {
      return {
        symbol,
        direction: firstDir,
        moves,
      };
    }

    return null;
  } catch {
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
        const data = await getWeeklyData(symbol);
        if (data) results.push(data);
      })
    )
  );

  if (results.length === 0) {
    console.log("No pairs met the strict 3-week consistency criteria.");
    return;
  }

  // Sort by strongest recent move
  results.sort((a, b) => Math.max(...b.moves) - Math.max(...a.moves));

  console.log("\n=== 3-Week Consistent Directional Moves ≥10% ===\n");

  results.forEach((r) => {
    console.log(
      `${r.symbol} | Direction: ${r.direction} | Weekly Moves: [${r.moves.join(
        "%, "
      )}%]`
    );
  });

  console.log(`\nTotal Matches: ${results.length}`);
}

scan();
