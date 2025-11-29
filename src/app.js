import express from "express";
import { runBTC } from "./strategies/btc.js";
import { runSUI } from "./strategies/sui1.js";
import { runSOL } from "./strategies/sol.js";

// ---------------- BOT EXECUTION ----------------

export async function startBots() {
  await runBTC();
  await runSUI();
  await runSOL();
}

// ---------------- EXPRESS SERVER ----------------

const app = express();
const port = process.env.PORT || 3000;

// OPTIONAL: Silence Render cold-start logs (enable if needed)
// if (process.env.RENDER) {
//   console.log = () => {};
//   console.error = () => {};
// }

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("Bot is live.");
});

// ---------------- SILENT CRON ROUTE ----------------
// External cron will call this endpoint.
// Response is sent immediately to avoid Render cold-start log spam.
app.get("/cron/run", async (req, res) => {
  // Respond instantly
  res.status(200).send("ok");

  // Run bots after response – prevents output-too-large on cold start
  setTimeout(async () => {
    try {
      await startBots();
    } catch (err) {
      console.error("Cron bot run failed:", err.message);
    }
  }, 10);
});

// ---------------- START SERVER ----------------

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
