import dotenv from 'dotenv';
dotenv.config(); // Load environment variables first

import express from 'express';
import { startBots } from './app.js'; // Import your bot starter from app.js

const PORT = process.env.PORT || 3000;
const app = express();

// Health check route
app.get('/', (req, res) => {
  res.send('Tradebot running 🚀');
});

// Optional manual bot trigger (for testing in browser)
app.get('/run', async (req, res) => {
  res.send('ok');
  setTimeout(async () => {
    try {
      await startBots();
    } catch (err) {
      console.error('Manual run failed:', err);
    }
  }, 10);
});

// External cron route
app.get('/cron/run', async (req, res) => {
  res.send('ok');
  setTimeout(async () => {
    try {
      await startBots();
    } catch (err) {
      console.error('Cron bot run failed:', err);
    }
  }, 10);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
