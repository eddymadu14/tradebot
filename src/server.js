import dotenv from 'dotenv';
dotenv.config();  // load env vars first

import express from 'express';
import { startBots, msUntilNext4HBoundary } from './app.js';

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('Tradebot running 🚀'));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  scheduleBots(); // start scheduler AFTER dotenv loaded
});

function scheduleBots() {
  console.log('Immediate run at startup.');
  startBots(); // run once immediately

  const delay = msUntilNext4HBoundary();
  console.log(`Scheduler: waiting ${Math.round(delay / 1000)}s until next 4H boundary`);
  setTimeout(scheduleBots, delay); // schedule next run
}
