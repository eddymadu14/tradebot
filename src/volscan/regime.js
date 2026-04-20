// engine/regime.js
import { ATR } from "./indicators.js";

export function detectRegime(klines) {
  const atr = ATR(klines);
  const avgRange = klines
    .slice(-20)
    .map(k => parseFloat(k[2]) - parseFloat(k[3]))
    .reduce((a, b) => a + b) / 20;

  if (avgRange < atr * 0.7) return "LOW_VOL";
  return "NORMAL";
}
