// app.js

import { runSOLatr } from "./strategies/solatr.js";
import { runBTCatr } from "./strategies/btcatr.js";
import { runeth } from "./strategies/eth.js";
import { runBTCin } from "./strategies/btcin.js";
import { runethatr } from "./strategies/ethatr.js";
import { runCTWL1H_PREDICT } from "./ctwl/btctele.js";
import { runCTWL1H_PREDICT_ETH } from "./ctwl/ethtele.js";

// ======================
// DELAY HELPER (5 mins)
// ======================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const FIVE_MINUTES = 2 * 1000;

const SYMBOL = "BTC/USDT";

export async function startBots() {
  try {
    console.log("🚀 Starting bot cycle...");

    await runBTCin(SYMBOL);
    await delay(FIVE_MINUTES);

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
