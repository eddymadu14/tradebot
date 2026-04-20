import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "1d";        // Change timeframe here
const LOOKBACK = 50;         // Number of candles
const VOLUME_MULTIPLIER = 2; // 2x average = spike
const CONCURRENCY = 8;

const limit = pLimit(CONCURRENCY);

let scanned = 0;

// ===== Get USDT Perpetual Futures Pairs =====
async function getUSDTPairs() {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(
      s =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING"
    )
    .map(s => s.symbol);
}

// ===== Fetch Candles =====
async function getCandles(symbol) {
  const { data } = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
    params: {
      symbol,
      interval: INTERVAL,
      limit: LOOKBACK
    }
  });

  return data.map(c => ({
    closeTime: c[6],
    volume: parseFloat(c[5])
  }));
}

// ===== Detect Volume Spike =====
function detectVolumeSpike(candles) {
  if (candles.length < 21) return null;

  const volumes = candles.map(c => c.volume);
  const lastVolume = volumes[volumes.length - 1];

  const avgVolume =
    volumes.slice(0, -1).reduce((a, b) => a + b, 0) /
    (volumes.length - 1);

  const ratio = lastVolume / avgVolume;

  if (ratio >= VOLUME_MULTIPLIER) {
    return {
      lastVolume,
      avgVolume,
      difference: lastVolume - avgVolume,
      ratio
    };
  }

  return null;
}

// ===== Scanner =====
async function scan() {
  console.log("\n🚀 Binance Futures USDT Volume Spike Scanner\n");

  const pairs = await getUSDTPairs();
  console.log(`Total Pairs: ${pairs.length}\n`);

  const tasks = pairs.map(symbol =>
    limit(async () => {
      try {
        const candles = await getCandles(symbol);
        const spike = detectVolumeSpike(candles);

        scanned++;
        process.stdout.write(`Scanning ${scanned}/${pairs.length}\r`);

        if (spike) {
          console.log(
            `\n🔥 ${symbol}
   Last Volume: ${spike.lastVolume.toFixed(2)}
   Avg Volume:  ${spike.avgVolume.toFixed(2)}
   Difference:  ${spike.difference.toFixed(2)}
   Ratio:       ${spike.ratio.toFixed(2)}x`
          );
        }
      } catch {
        scanned++;
      }
    })
  );

  await Promise.all(tasks);

  console.log("\n\n✅ Scan complete.\n");
}

scan();
