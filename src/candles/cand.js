import axios from "axios";

const BINANCE_BASE = "https://api.binance.com";
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "1d";
const LIMIT = 365;

// ---------- HELPERS ----------

const pct = (a, b) => ((a - b) / b) * 100;

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.floor((p / 100) * s.length);
  return s[i];
};

// ---------- FETCH ----------

async function fetchCandles(symbol) {
  const { data } = await axios.get(
    `${BINANCE_BASE}/api/v3/klines`,
    { params: { symbol, interval: INTERVAL, limit: LIMIT } }
  );

  return data.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    rangePct: pct(c[2], c[3]),
    bodyPct: Math.abs(pct(c[4], c[1])),
    closeLocation: (c[4] - c[3]) / (c[2] - c[3])
  }));
}

// ---------- ANALYSIS ----------

function analyze(symbol, candles) {
  let bull = 0, bear = 0;
  let bullBody = [], bearBody = [];
  let bullMove = 0, bearMove = 0;
  let ranges = [];
  let efficiency = [];

  candles.forEach(c => {
    ranges.push(c.rangePct);
    efficiency.push(c.closeLocation);

    if (c.close > c.open) {
      bull++;
      bullBody.push(c.bodyPct);
      bullMove += c.bodyPct;
    } else {
      bear++;
      bearBody.push(c.bodyPct);
      bearMove += c.bodyPct;
    }
  });

  const avgBullBody = bullBody.reduce((a, b) => a + b, 0) / bullBody.length;
  const avgBearBody = bearBody.reduce((a, b) => a + b, 0) / bearBody.length;

  const expectancy =
    (bull / candles.length) * avgBullBody -
    (bear / candles.length) * avgBearBody;

  console.log(`\n==============================`);
  console.log(`${symbol} STRUCTURAL SUMMARY`);
  console.log(`==============================`);

  console.log(`Total Candles: ${candles.length}`);
  console.log(`Bull Candles: ${bull}`);
  console.log(`Bear Candles: ${bear}`);

  console.log(`\n--- BODY STRENGTH ---`);
  console.log(`Avg Bull Body %: ${avgBullBody.toFixed(2)}`);
  console.log(`Avg Bear Body %: ${avgBearBody.toFixed(2)}`);

  console.log(`\n--- VOLATILITY ---`);
  console.log(`Median Daily Move %: ${median(ranges).toFixed(2)}`);
  console.log(`90th Percentile Expansion %: ${percentile(ranges, 90).toFixed(2)}`);

  console.log(`\n--- CONTROL ---`);
  console.log(`Avg Close Location (0–1): ${(efficiency.reduce((a,b)=>a+b,0)/efficiency.length).toFixed(2)}`);
  console.log(`Directional Expectancy: ${expectancy.toFixed(3)}`);

  console.log(
    expectancy > 0
      ? `Bias: STRUCTURALLY BULLISH`
      : `Bias: STRUCTURALLY BEARISH`
  );
}

// ---------- RUN ----------

(async () => {
  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol);
    analyze(symbol, candles);
  }
})();
