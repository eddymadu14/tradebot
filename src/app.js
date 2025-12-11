// app.js
import { runBTC } from "./strategies/btc.js";
//import { runSUI } from "./strategies/sui1.js";
import { runSOL } from "./strategies/sol.js";
import { runBTC1h } from "./strategies/btc1h.js";
import { runSOL1h } from "./strategies/sol1h.js";
//import { runBTCatr } from "./strategies/btcatr.js";
//import { runBTCltf } from "./strategies/btcltf.js";
import { runethfast } from "./strategies/ethfast.js";
import { runeth } from "./strategies/eth.js";
//import { runethatr } from "./strategies/ethatr.js";
// ---------------- BOT EXECUTION ----------------

export async function startBots() {
  try {
    console.log("🚀 Starting bot cycle...");
   await runBTC();
   await runeth();
    await runSOL();
   await runethfast();
//await runethatr(); 
//await runBTCatr();
    console.log("✅ Bot cycle completed.");
  } catch (err) {
    console.error("❌ Bot cycle failed:", err.message);
  }
}
