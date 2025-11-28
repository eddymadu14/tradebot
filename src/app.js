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

// ---------------- 4H SCHEDULER -----------------

export function msUntilNext4HBoundary() {
  const now = new Date();

  const nextHour =
    Math.ceil((now.getUTCHours() + now.getUTCMinutes() / 60) / 4) * 4;

  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      nextHour
    )
  );

  let diff = next.getTime() - now.getTime();
  if (diff <= 0) diff += 4 * 60 * 60 * 1000;

  return diff;
}

export async function startScheduler() {
  console.log("⏳ Immediate 4H bot run at startup...");
  await startBots();

  const delay = msUntilNext4HBoundary();
  console.log(
    `📆 Scheduler: next 4H run in ${Math.round(
      delay / 1000
    )} seconds (${(delay / 3600000).toFixed(2)} hours)`
  );

  setTimeout(startScheduler, delay);
}

// ---------------- EXPRESS SERVER ----------------

const app = express();
const port = process.env.PORT || 3000;

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("Bot is live.");
});

// ---------------- CRON ROUTE (IMPORTANT) ----------------
// This is what your external cron site will call
app.get("/cron/run", async (req, res) => {
  try {
    await startBots();
    res.send("OK"); // DO NOT return large JSON
  } catch (err) {
    res.send("ERR: " + err.message);
  }
});

// ---------------- START SERVER ----------------

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

// Optionally start the internal 4H scheduler
// startScheduler();
