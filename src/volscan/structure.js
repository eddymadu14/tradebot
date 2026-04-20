// engine/structure.js

export function detectStructure(klines) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));

  const lastHigh = highs.at(-1);
  const prevHigh = highs.at(-2);
  const lastLow = lows.at(-1);
  const prevLow = lows.at(-2);

  if (lastHigh > prevHigh && lastLow > prevLow) return "HHHL";
  if (lastHigh < prevHigh && lastLow < prevLow) return "LLLH";
  return "RANGE";
}
