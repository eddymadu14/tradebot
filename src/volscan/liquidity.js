// engine/liquidity.js

export function detectSweep(klines) {
  const lows = klines.slice(-11, -1).map(k => parseFloat(k[3]));
  const last = klines.at(-1);

  const lastLow = parseFloat(last[3]);
  const close = parseFloat(last[4]);

  if (lastLow < Math.min(...lows) && close > lastLow) {
    return "BULLISH_SWEEP";
  }

  return null;
}
