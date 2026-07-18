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
// Live WebSocket Monitoring
// Invalidation Candle Logic
// Auto Daily Reset
// ======================================================

import WebSocket from "ws";

// ------------------------------------------------------
// Build Binance Multi Stream
// ------------------------------------------------------

function buildStreamURL() {

  const streams = [...markets.keys()]
    .map(s => `${s.toLowerCase()}@markPrice`)
    .join("/");

  return `wss://fstream.binance.com/stream?streams=${streams}`;

}

let ws;

// ------------------------------------------------------
// Connect WebSocket
// ------------------------------------------------------

function connectSocket() {

  const url = buildStreamURL();

  console.log("");
  console.log("Connecting WebSocket...");
  console.log(url);
  console.log("");

  ws = new WebSocket(url);

  ws.on("open", () => {

    console.log("WebSocket Connected");

  });

  ws.on("message", raw => {

    const msg = JSON.parse(raw);

    if (!msg.data) return;

    const symbol = msg.data.s;

    const price = Number(msg.data.p);

    processPrice(symbol, price);

  });

  ws.on("close", () => {

    console.log("Socket Closed...");
    console.log("Reconnect in 5 seconds");

    setTimeout(connectSocket, 5000);

  });

  ws.on("error", err => {

    console.log(err.message);

  });

}

// ------------------------------------------------------
// Process Incoming Price
// ------------------------------------------------------

function processPrice(symbol, price) {

  const pair = markets.get(symbol);

  if (!pair) return;

  // ----------------------------
  // LONG INVALIDATION
  // ----------------------------

  if (
    !pair.longInvalid &&
    price <= pair.lowerInvalid
  ) {

    pair.longInvalid = true;

    console.log(
      `${symbol} LONG INVALIDATED`
    );

  }

  // ----------------------------
  // SHORT INVALIDATION
  // ----------------------------

  if (
    !pair.shortInvalid &&
    price >= pair.upperInvalid
  ) {

    pair.shortInvalid = true;

    console.log(
      `${symbol} SHORT INVALIDATED`
    );

  }

  // ----------------------------
  // LONG SIGNAL
  // ----------------------------

  if (
    !pair.longTriggered &&
    !pair.longInvalid &&
    price >= pair.longTarget
  ) {

    pair.longTriggered = true;

    console.log("");
    console.log("=================================");
    console.log(`${symbol} LONG SIGNAL`);
    console.log(`Price ${price}`);
    console.log("=================================");
    console.log("");

  }

  // ----------------------------
  // SHORT SIGNAL
  // ----------------------------

  if (
    !pair.shortTriggered &&
    !pair.shortInvalid &&
    price <= pair.shortTarget
  ) {

    pair.shortTriggered = true;

    console.log("");
    console.log("=================================");
    console.log(`${symbol} SHORT SIGNAL`);
    console.log(`Price ${price}`);
    console.log("=================================");
    console.log("");

  }

}

// ------------------------------------------------------
// Daily Reset Checker
// ------------------------------------------------------

let currentDay = new Date().getUTCDate();

setInterval(async () => {

  const day = new Date().getUTCDate();

  if (day === currentDay)
    return;

  currentDay = day;

  console.log("");
  console.log("=================================");
  console.log("NEW DAILY CANDLE");
  console.log("Refreshing Levels...");
  console.log("=================================");
  console.log("");

  for (const pair of markets.values()) {

    try {

      const open =
        await fetchDailyOpen(pair.symbol);

      const levels =
        calculateLevels(
          open,
          pair.targetPct
        );

      Object.assign(pair, levels);

      pair.longInvalid = false;
      pair.shortInvalid = false;

      pair.longTriggered = false;
      pair.shortTriggered = false;

      console.log(
        `${pair.symbol} reset complete`
      );

    }

    catch {

      console.log(
        `${pair.symbol} failed refresh`
      );

    }

  }

}, 30000);

// ------------------------------------------------------
// Replace MAIN from Part 1
// ------------------------------------------------------

(async () => {

  await initializePairs();

  connectSocket();

})();
