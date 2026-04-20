// engine/scanner.js
import pLimit from "p-limit";
import { CONFIG } from "./config.js";
import {
  getFuturesUSDT,
  getKlines,
  getOpenInterest,
  getFunding
} from "./fetcher.js";
import { zScore, ATR, trueRange, mean } from "./indicators.js";
import { detectStructure } from "./structure.js";
import { detectSweep } from "./liquidity.js";
import { detectRegime } from "./regime.js";
import { scoreSignal } from "./scoring.js";

export async function runScanner() {
  const startTime = Date.now();

  console.log("🔎 Fetching USDT perpetual futures...");
  const symbols = await getFuturesUSDT();
  console.log(`📊 Total symbols to scan: ${symbols.length}`);
  console.log("🚀 Starting scan...\n");

  const limit = pLimit(CONFIG.CONCURRENCY);
  const results = [];
  let scanned = 0;

  await Promise.all(
    symbols.map(symbol =>
      limit(async () => {
        try {
          const klines = await getKlines(symbol);
          const volumes = klines.slice(-21, -1).map(k => parseFloat(k[5]));
          const last = klines.at(-1);

          const currentVolume = parseFloat(last[5]);
          const volumeZ = zScore(currentVolume, volumes);
          const rvol = currentVolume / mean(volumes);

          const atr = ATR(klines);
          const tr = trueRange(last);
          const atrCompressed = tr < atr * CONFIG.ATR_COMPRESSION_RATIO;

          const structure = detectStructure(klines);
          const sweep = detectSweep(klines);
          const regime = detectRegime(klines);

          const oi = await getOpenInterest(symbol);
          const funding = await getFunding(symbol);

          const score = scoreSignal({
            volumeZ,
            rvol,
            atrCompressed,
            oiRising: true, // placeholder
            sweep,
            structure,
            funding
          });

          scanned++;

          // Progress update every 25 symbols
          if (scanned % 25 === 0) {
            console.log(`⏳ Scanned ${scanned}/${symbols.length}`);
          }

          if (score >= CONFIG.SCORE_THRESHOLD && regime === "LOW_VOL") {
            const signal = { symbol, score, volumeZ, rvol };
            results.push(signal);

            console.log("🔥 Candidate Found:", signal);
          }

        } catch (err) {
          scanned++;
        }
      })
    )
  );

  const runtime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n✅ Scan Complete");
  console.log(`⏱ Runtime: ${runtime}s`);
  console.log(`📈 Total Candidates: ${results.length}`);

  return results.sort((a, b) => b.score - a.score);
}
