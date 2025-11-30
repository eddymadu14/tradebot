// app.js
import { runBTC } from "./strategies/btc.js";
import { runSUI } from "./strategies/sui1.js";
import { runSOL } from "./strategies/sol.js";
import { runBTC1h } from "./strategies/btc1h.js";
import { runSOL1h } from "./strategies/sol1h.js";
// ---------------- BOT EXECUTION ----------------

export async function startBots() {
  try {
    console.log("🚀 Starting bot cycle...");
    await runBTC();
    await runBTC1h();
    await runSOL1h();
    console.log("✅ Bot cycle completed.");
  } catch (err) {
    console.error("❌ Bot cycle failed:", err.message);
  }
}
