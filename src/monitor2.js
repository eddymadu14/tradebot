// ======================================================
// DAILY % MOVE MONITOR
// PART 1
// Reads pairs.txt
// Fetches current DAILY candle from Binance
// Calculates targets & invalidation levels
// Part 2 will add WebSocket monitoring
// ======================================================

import fs from "fs/promises";
import axios from "axios";

const BINANCE =
  "https://fapi.binance.com/fapi/v1/klines";

const PAIRS_FILE = "./pairs.txt";

// 40% invalidation
const INVALIDATION_RATIO = 0.40;

// stores all active pair data
const markets = new Map();

// ------------------------------------------------------
// Read pairs.txt
// ------------------------------------------------------

async function loadPairs() {
  const text = await fs.readFile(PAIRS_FILE, "utf8");

  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {

      const [symbol, pct] = line
        .split(",")
        .map(x => x.trim());

      return {
        symbol: symbol.toUpperCase(),
        targetPct: Number(pct)
      };

    });
}

// ------------------------------------------------------
// Fetch current DAILY candle
// ------------------------------------------------------

async function fetchDailyOpen(symbol) {

  const url =
    `${BINANCE}?symbol=${symbol}&interval=1d&limit=1`;

  const { data } = await axios.get(url);

  return Number(data[0][1]);
}

// ------------------------------------------------------
// Calculate levels
// ------------------------------------------------------

function calculateLevels(open, targetPct) {

  const invalidPct =
    targetPct * INVALIDATION_RATIO;

  return {

    open,

    targetPct,

    invalidPct,

    longTarget:
      open * (1 + targetPct / 100),

    shortTarget:
      open * (1 - targetPct / 100),

    upperInvalid:
      open * (1 + invalidPct / 100),

    lowerInvalid:
      open * (1 - invalidPct / 100)

  };

}

// ------------------------------------------------------
// Load every configured pair
// ------------------------------------------------------

async function initializePairs() {

  const pairs = await loadPairs();

  console.log("");
  console.log("====================================");
  console.log(" DAILY MONITOR INITIALIZATION");
  console.log("====================================");
  console.log("");

  for (const pair of pairs) {

    try {

      const open =
        await fetchDailyOpen(pair.symbol);

      const levels =
        calculateLevels(
          open,
          pair.targetPct
        );

      markets.set(pair.symbol, {

        symbol: pair.symbol,

        ...levels,

        longInvalid: false,

        shortInvalid: false,

        longTriggered: false,

        shortTriggered: false

      });

      console.log("----------------------------------");
      console.log(pair.symbol);

      console.log(
        "Daily Open:",
        open
      );

      console.log(
        "Target:",
        pair.targetPct + "%"
      );

      console.log(
        "Invalidation:",
        levels.invalidPct + "%"
      );

      console.log(
        "Long Target:",
        levels.longTarget
      );

      console.log(
        "Short Target:",
        levels.shortTarget
      );

      console.log(
        "Upper Invalid:",
        levels.upperInvalid
      );

      console.log(
        "Lower Invalid:",
        levels.lowerInvalid
      );

      console.log("----------------------------------");
      console.log("");

    }

    catch (err) {

      console.log(
        `Failed loading ${pair.symbol}`
      );

    }

  }

}

// ------------------------------------------------------
// MAIN
// ------------------------------------------------------

(async () => {

  await initializePairs();

  console.log("");
  console.log(
    "Initialization Complete."
  );

  console.log(
    "Waiting for Part 2 WebSocket Monitor..."
  );

})();



// ======================================================
// PART 2
// ======================================================
