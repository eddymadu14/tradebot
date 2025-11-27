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
  const nextHour = Math.ceil(now.getUTCHours() / 4) * 4;
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    nextHour
  ));
  return next.getTime() - now.getTime();
}

export async function startScheduler() {
  console.log("Immediate run at startup.");
  await startBots();

  const delay = msUntilNext4HBoundary();
  console.log(`Scheduler: waiting ${Math.round(delay / 1000)}s until next 4H boundary`);
  setTimeout(startScheduler, delay); // schedule next run
}
