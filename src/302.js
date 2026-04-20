import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1w";
const CONCURRENCY = 10;
const THRESHOLD = 20; // 20%
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

    // Last 3 fully closed candles
    const lastThree = closedCandles.slice(-3);

    const qualifyingMoves = [];
    const directions = [];

    for (let candle of lastThree) {
      const open = parseFloat(candle[1]);
      const close = parseFloat(candle[4]);

      const percentMove = ((close - open) / open) * 100;

      if (Math.abs(percentMove) >= THRESHOLD) {
        qualifyingMoves.push(percentMove.toFixed(2));
        directions.push(percentMove > 0 ? "positive" : "negative");
      }
    }

    if (qualifyingMoves.length >= 2) {
      // Check if all qualifying moves are same direction
      const firstDir = directions[0];
      const allSame = directions.every((d) => d === firstDir);

      if (allSame) {
        return {
          symbol,
          weeksQualified: qualifyingMoves.length,
          moves: qualifyingMoves,
          direction: firstDir,
        };
      }
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
    console.log("No pairs met the criteria.");
    return;
  }

  // Sort by weeksQualified first, then strongest move
  results.sort((a, b) => {
    if (b.weeksQualified !== a.weeksQualified) {
      return b.weeksQualified - a.weeksQualified;
    }
    return Math.max(...b.moves) - Math.max(...a.moves);
  });

  console.log("\n=== Directional Weekly Streaks ≥20% ===\n");

  results.forEach((r) => {
    console.log(
      `${r.symbol} | Qualified Weeks: ${r.weeksQualified}/3 | Direction: ${r.direction} | Weekly Moves: [${r.moves.join(
        "%, "
      )}%]`
    );
  });

  console.log(`\nTotal Matches: ${results.length}`);
}

scan();
