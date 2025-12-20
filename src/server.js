if (process.env.NODE_ENV !== 'production') {
  // Only load dotenv in local development
  import('dotenv').then(dotenv => dotenv.config());
}

import express from 'express';
import { startBots } from './ap.js';

const PORT = process.env.PORT || 3000;
const app = express();

// ----------------------
// HEALTH CHECK
// ----------------------
app.get('/', (req, res) => res.send('Tradebot running 🚀'));

// ----------------------
// SILENT BOT RUNNER
// ----------------------
const runBotsSilent = async () => {
  try {
    await startBots();
  } catch (err) {
    console.error('Bot run failed:', err);
  }
};

// ----------------------
// CRON + MANUAL TRIGGERS
// ----------------------
app.get('/run', (req, res) => {
  res.send('ok');
  process.nextTick(() => runBotsSilent());
});

app.get('/cron/run', (req, res) => {
  res.send('ok');
});

// ----------------------
// INTERNAL LOOP (UTC HOURLY)
// ----------------------
let isLoopRunning = false;

function startInternalLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  console.log("🔁 Internal CTWL UTC hourly loop started…");

  const run = async () => {
    try {
      await startBots();
    } catch (err) {
      console.error("Loop error:", err);
    }
  };

  // Align to next UTC hour
  const now = new Date();
  const nextHourUTC = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1,
    0,
    0,
    0
  ));

  const delay = nextHourUTC - now;

  // First run exactly at next UTC hour
  setTimeout(() => {
    run();

    // Then run every 1 hour UTC
    setInterval(run, 60 * 60 * 1000);
  }, delay);
}

// Start scheduler
startInternalLoop();

// ----------------------
// START SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
