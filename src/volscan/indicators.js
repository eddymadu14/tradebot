// engine/indicators.js

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

export function zScore(value, arr) {
  return (value - mean(arr)) / std(arr);
}

export function ATR(klines, period = 14) {
  const trs = [];

  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i - 1][4]);

    trs.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));
  }

  return mean(trs.slice(-period));
}

export function trueRange(lastCandle) {
  return parseFloat(lastCandle[2]) - parseFloat(lastCandle[3]);
}
