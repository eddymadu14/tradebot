import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { startBots } from './app.js';

const PORT = process.env.PORT || 3000;
const app = express();

// Health check
app.get('/', (req, res) => res.send('Tradebot running 🚀'));

// Run bots silently
const runBotsSilent = async () => {
try {
await startBots();
} catch (err) {
// Log errors only, do NOT log anything during wake
console.error('Bot run failed:', err);
}
};

// Manual trigger (suppress wake log)
app.get('/run', (req, res) => {
// Respond immediately before any other operation
res.send('ok');

// Run bot asynchronously after response
process.nextTick(() => runBotsSilent());
});

// Cron trigger (suppress wake log)
app.get('/cron/run', (req, res) => {
res.send('ok'); // Respond immediately
process.nextTick(() => runBotsSilent());
});

// Start server
app.listen(PORT, () => {
console.log("🚀 Server running on port ${PORT}");
});
