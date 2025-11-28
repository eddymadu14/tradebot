import { runBTC } from './strategies/btc.js';
import { runSUI } from './strategies/sui1.js';
import { runSOL } from './strategies/sol.js';

export async function startBots() {
  await runBTC();
  await runSUI();
  await runSOL();
}

export function msUntilNext4HBoundary() {
  const now = new Date();

  // compute next boundary hour (0, 4, 8, 12, 16, 20)
  const nextHour = Math.ceil((now.getUTCHours() + now.getUTCMinutes()/60) / 4) * 4;

  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    nextHour
  ));

  let diff = next.getTime() - now.getTime();

  // If diff <= 0 (shouldn't happen but safe), add 4h
  if (diff <= 0) diff += 4 * 60 * 60 * 1000;

  return diff;
}

export async function startScheduler() {
  console.log("⏳ Immediate 4H bot run at startup...");
  await startBots();

  const delay = msUntilNext4HBoundary();
  console.log(
    `📆 Scheduler: next 4H run in ${Math.round(delay / 1000)} seconds (${(delay/3600000).toFixed(2)} hours)`
  );

  // ❗ Correct: do NOT call startScheduler() here.
  setTimeout(startScheduler, delay);
}
