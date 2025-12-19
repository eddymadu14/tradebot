if (process.env.NODE_ENV !== 'production') {
  // Only load dotenv in local development
  import('dotenv').then(dotenv => dotenv.config());
}

import express from 'express';
import { startBots } from './app.js';

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
  process.nextTick(() => runBotsSilent());
});

// ----------------------
// INTERNAL LOOP
// ----------------------
let isLoopRunning = false;

function startInternalLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  console.log("🔁 Internal CTWL loop started…");

  setInterval(async () => {
    try {
      await startBots();   // <-- Runs EVERY 60 seconds
    } catch (err) {
      console.error("Loop error:", err);
    }
  }, 40 * 1000); // 1 minute
}

// Start loop immediately
startInternalLoop();

// ----------------------
// START SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
