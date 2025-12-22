import ccxt from "ccxt";

// ----------------------
// CONFIG
// ----------------------
const symbol = "BTC/USDT";
const timeframe = "1w"; // weekly candles
const atrPeriod = 14; // ATR lookback
const A_TIER_MAX_PERCENT = 6; // max ATR% for A-tier

// ----------------------
// FETCH CANDLES
// ----------------------
async function fetchCandles() {
  const binance = new ccxt.binance();
  const since = undefined; // fetch maximum available
  const limit = 200; // number of weekly candles

  const ohlcv = await binance.fetchOHLCV(symbol, timeframe, since, limit);
  // ohlcv format: [ timestamp, open, high, low, close, volume ]
  return ohlcv.map(c => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
  }));
}

// ----------------------
// CALCULATE ATR
// ----------------------
function calculateATR(candles, period) {
  const trList = [];
  const atrList = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trList.push(candles[i].high - candles[i].low);
      continue;
    }

    const current = candles[i];
    const prev = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );

    trList.push(tr);

    // ATR calculation
    if (i < period) {
      // Not enough data for full ATR, simple average
      const sum = trList.slice(1, i + 1).reduce((a, b) => a + b, 0);
      atrList.push(sum / i);
    } else if (i === period) {
      // first ATR is simple average of first period TRs
      const sum = trList.slice(1, period + 1).reduce((a, b) => a + b, 0);
      atrList.push(sum / period);
    } else {
      // subsequent ATRs: Wilder's method
      const prevATR = atrList[atrList.length - 1];
      const atr = (prevATR * (period - 1) + tr) / period;
      atrList.push(atr);
    }
  }

  return atrList;
}

// ----------------------
// ASSIGN TIERS
// ----------------------
function assignTier(atr, close) {
  const atrPercent = (atr / close) * 100;

  if (atrPercent <= A_TIER_MAX_PERCENT) return "A-Tier";
  if (atrPercent <= 9) return "B-Tier";
  if (atrPercent <= 12) return "C-Tier";
  return "D-Tier";
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  const candles = await fetchCandles();
  const atrList = calculateATR(candles, atrPeriod);

  console.log("Week Ending | Close | ATR | ATR % | Tier");
  console.log("--------------------------------------------");

  for (let i = atrPeriod; i < candles.length; i++) {
    const candle = candles[i];
    const atr = atrList[i - 1]; // align with candle
    const atrPercent = ((atr / candle.close) * 100).toFixed(2);
    const tier = assignTier(atr, candle.close);

    const date = new Date(candle.timestamp).toISOString().split("T")[0];
    console.log(`${date} | ${candle.close.toFixed(2)} | ${atr.toFixed(2)} | ${atrPercent}% | ${tier}`);
  }
}

main().catch(console.error);
