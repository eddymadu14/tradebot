// engine/index.js
import { runScanner } from "./scanner.js";

(async () => {
  console.log("====================================");
  console.log("INSTITUTIONAL ACCUMULATION ENGINE");
  console.log("====================================\n");

  const signals = await runScanner();

  if (signals.length > 0) {
    console.log("\n🏆 Ranked Candidates:");
    console.table(signals);
  } else {
    console.log("\n❌ No qualifying setups found.");
  }
})();
