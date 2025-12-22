// app.js

import { runSOLatr } from "./strategies/solatr.js";
import { runBTCatr } from "./strategies/btcatr.js";
import { runeth } from "./strategies/eth.js";
//import { runBTCin } from "./strategies/btcin.js";
import { runethatr } from "./strategies/ethatr.js";
import { runCTWL1H_PREDICT } from "./ctwl/btctele.js";
import { runCTWL1H_PREDICT_ETH } from "./ctwl/ethtele.js";
import { runBTCmod } from "./strategies/btcmod.js";
import { runBTCmod1 } from "./strategies/btcmod1.js";
import { runBTCin } from "./strategies/btcfilter.js";
// ======================
// DELAY HELPER
// ======================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const FIVE_MINUTES = 2 * 1000; // keep your test value

const SYMBOL = "BTC/USDT";

// ======================
// DAILY WINDOW (IN-MEMORY)
// ======================
let lastDailyRunDate = null;

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isWithinDailyWindow() {
  const hour = new Date().getHours();
  return hour === 0; // 00:00 – 00:59
}

function canRunDailyJobs() {
  const today = getTodayKey();

  if (!isWithinDailyWindow()) return false;
  if (lastDailyRunDate === today) return false;

  return true;
}

// ======================
// MAIN BOT LOOP
// ======================
export async function startBots() {
  try {
    console.log("🚀 Starting bot cycle...");
     
    // ======================
    // DAILY (00:00–01:00)
    // ======================
    if (canRunDailyJobs()) {
      console.log("🕛 Executing daily/weekly jobs...");

      await import("./weekly/btc.js");
      await delay(FIVE_MINUTES);

      await import("./weekly/btcconst.js");
      await delay(FIVE_MINUTES);

      await import("./weekly/btcdaily.js");
      await delay(FIVE_MINUTES);

      lastDailyRunDate = getTodayKey();
      console.log("✅ Daily/weekly jobs completed.");
      } else {
      console.log("⏭️ Daily jobs skipped.");
    }

    await runBTCin(SYMBOL);
    await delay(FIVE_MINUTES);

   // await runBTCmod1(SYMBOL);
    //await delay(FIVE_MINUTES);

    await runethatr();
    await delay(FIVE_MINUTES);

    const btcRes = await runCTWL1H_PREDICT("BTCUSDT");
    console.log("CTWL BTC RESULT ↓↓↓");
    console.log(JSON.stringify(btcRes, null, 2));

    await delay(FIVE_MINUTES);

    const ethRes = await runCTWL1H_PREDICT_ETH("ETHUSDT");
    console.log("CTWL ETH RESULT ↓↓↓");
    console.log(JSON.stringify(ethRes, null, 2));

   
    console.log("✅ Bot cycle completed.");
  } catch (err) {
    console.error("❌ Bot cycle failed:", err.message);
  }
}
