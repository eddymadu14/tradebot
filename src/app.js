// app.js
import { runBTC } from "./strategies/btc.js";
import { runSUI } from "./strategies/sui1.js";
import { runSOL } from "./strategies/sol.js";

// ---------------- BOT EXECUTION ----------------

export async function startBots() {
  try {
    console.log("🚀 Starting bot cycle...");
    await runBTC();
    await runSUI();
    await runSOL();
    console.log("✅ Bot cycle completed.");
  } catch (err) {
    console.error("❌ Bot cycle failed:", err.message);
  }
}
