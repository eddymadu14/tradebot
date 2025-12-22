import fs from "fs";
import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";

const DAYS = 5;
const MIN_MEAN_VOLUME = 1_000_000;

// Load tokens from txt file
function loadAlphaTokens(path = "./alphatokens.txt") {
  return fs
    .readFileSync(path, "utf8")
    .split("\n")
    .map(t => t.trim())
    .filter(Boolean);
}

async function fetchMeanVolume(symbol) {
  try {
    const { data } = await axios.get(
      `${BINANCE_BASE}/api/v3/klines`,
      {
        params: {
          symbol,
          interval: "1d",
          limit: DAYS + 1 // buffer for current candle
        }
      }
    );

    // Drop current forming candle
    const closedCandles = data.slice(0, DAYS);

    const volumes = closedCandles.map(c =>
      Number(c[7]) // quote asset volume (USDT)
    );

    const meanVolume =
      volumes.reduce((a, b) => a + b, 0) / volumes.length;

    return {
      symbol,
      meanVolume: Math.round(meanVolume)
    };

  } catch (err) {
    console.warn(`Skipping ${symbol}: ${err.message}`);
    return null;
  }
}

async function runAlphaVolumeFilter() {
  const tokens = loadAlphaTokens();
  const results = [];

  console.log(`Loaded ${tokens.length} Alpha tokens`);

  for (const symbol of tokens) {
    const res = await fetchMeanVolume(symbol);
    if (!res) continue;

    if (res.meanVolume >= MIN_MEAN_VOLUME) {
      results.push(res);
    }
  }

  console.table(results);
  return results;
}

runAlphaVolumeFilter();
