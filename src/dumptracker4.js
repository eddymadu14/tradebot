// dump-tracker-v2.js
// npm install axios p-limit
// Run: node dump-tracker-v2.js

import axios from "axios";
import pLimit from "p-limit";

const BASE_URL = "https://fapi.binance.com";
const CONCURRENCY = 8;

const MIN_24H_VOLUME = 40_000_000;
const TOP_RESULTS = 15;
const LOOP_MS = 60_000;

// Timeframes
const TF_MAIN = "5m";
const TF_CONFIRM = "15m";
const TF_TREND = "1h";

const LOOKBACK_MAIN = 60;
const LOOKBACK_CONFIRM = 60;
const LOOKBACK_TREND = 80;

// ----------------------------
// WEIGHTS
// ----------------------------
const WEIGHTS = {
  momentum: 18,
  volume: 18,
  multiTFBreakdown: 18,
  oi: 16,
  funding: 8,
  structure: 10,
  btcWeakness: 7,
  sellPressure: 10,
  cascadeBonus: 8,
  exhaustionPenalty: -8,
};

// ----------------------------
// AXIOS
// ----------------------------
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 12000,
});

// ----------------------------
// HELPERS
// ----------------------------
const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

const num = (v) => Number(v || 0);

function avg(arr) {
  if (!arr.length) return 0;

  return (
    arr.reduce((a, b) => a + b, 0) /
    arr.length
  );
}

function pct(a, b) {
  if (!b) return 0;

  return ((a - b) / b) * 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getRecentLow(arr, bars = 20) {
  return Math.min(
    ...arr.slice(-bars - 1, -1)
  );
}

function getRecentHigh(arr, bars = 20) {
  return Math.max(
    ...arr.slice(-bars - 1, -1)
  );
}

// ----------------------------
// ADVANCED DUMP AGE DETECTOR
// ----------------------------
function detectDumpAge(closes) {
  const latestClose = closes.at(-1);

  let barsAgo = 0;

  // Minimum cumulative decline
  const MIN_DUMP_PCT = 1.5;

  // Walk backwards through candles
  for (
    let i = closes.length - 2;
    i >= 0;
    i--
  ) {
    const historicalClose = closes[i];

    const declinePct =
      ((latestClose - historicalClose) /
        historicalClose) *
      100;

    // Still significantly below past price
    if (declinePct <= -MIN_DUMP_PCT) {
      barsAgo =
        closes.length - 1 - i;
    } else {
      break;
    }
  }

  const minutes = barsAgo * 5;

  let freshness = "FRESH";

  if (barsAgo >= 4 && barsAgo <= 12) {
    freshness = "ACTIVE";
  } else if (
    barsAgo >= 13 &&
    barsAgo <= 24
  ) {
    freshness = "AGING";
  } else if (barsAgo > 24) {
    freshness = "OLD";
  }

  return {
    barsAgo,
    minutes,
    freshness,
  };
}

// ----------------------------
// FETCHERS
// ----------------------------
async function get24hTickers() {
  const { data } = await api.get(
    "/fapi/v1/ticker/24hr"
  );

  return data;
}

async function getKlines(
  symbol,
  interval,
  limit
) {
  const { data } = await api.get(
    "/fapi/v1/klines",
    {
      params: {
        symbol,
        interval,
        limit,
      },
    }
  );

  return data;
}

async function getOpenInterest(symbol) {
  const { data } = await api.get(
    "/fapi/v1/openInterest",
    {
      params: { symbol },
    }
  );

  return num(data.openInterest);
}

async function getFunding(symbol) {
  const { data } = await api.get(
    "/fapi/v1/premiumIndex",
    {
      params: { symbol },
    }
  );

  return num(data.lastFundingRate);
}

// ----------------------------
// ELIGIBLE PAIRS
// ----------------------------
async function getEligiblePairs() {
  const tickers =
    await get24hTickers();

  return tickers
    .filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("_") &&
        num(x.quoteVolume) >=
          MIN_24H_VOLUME
    )
    .map((x) => ({
      symbol: x.symbol,
      quoteVolume: num(
        x.quoteVolume
      ),
    }));
}

// ----------------------------
// BTC WEAKNESS FILTER
// ----------------------------
async function getBTCWeakness() {
  try {
    const k = await getKlines(
      "BTCUSDT",
      TF_MAIN,
      30
    );

    const closes = k.map((x) =>
      num(x[4])
    );

    const last = closes.at(-1);
    const prev = closes.at(-2);

    const move = pct(last, prev);

    return move < 0
      ? Math.abs(move)
      : 0;
  } catch {
    return 0;
  }
}

// ----------------------------
// CLASSIFIER
// ----------------------------
function classifyDump({
  dropPct,
  relVol,
  oiPct,
  rangePct,
  structureBearish,
}) {
  if (
    dropPct <= -2.5 &&
    relVol > 3 &&
    oiPct < 0
  ) {
    return "PANIC LIQUIDATION";
  }

  if (
    dropPct <= -1.2 &&
    oiPct > 0 &&
    structureBearish
  ) {
    return "CONTROLLED SHORTING";
  }

  if (
    dropPct <= -1.8 &&
    relVol > 2.5 &&
    rangePct > 2
  ) {
    return "MOMENTUM BREAKDOWN";
  }

  if (
    dropPct > -1 &&
    structureBearish
  ) {
    return "SLOW BLEED";
  }

  return "MIXED";
}

// ----------------------------
// MAIN ANALYSIS
// ----------------------------
async function analyzeSymbol(
  meta,
  btcWeakness
) {
  const symbol = meta.symbol;

  try {
    // Initial OI snapshot
    const oi1 =
      await getOpenInterest(symbol);

    await sleep(200);

    const [
      k5m,
      k15m,
      k1h,
      funding,
    ] = await Promise.all([
      getKlines(
        symbol,
        TF_MAIN,
        LOOKBACK_MAIN
      ),

      getKlines(
        symbol,
        TF_CONFIRM,
        LOOKBACK_CONFIRM
      ),

      getKlines(
        symbol,
        TF_TREND,
        LOOKBACK_TREND
      ),

      getFunding(symbol),
    ]);

    await sleep(200);

    // Second OI snapshot
    const oi2 =
      await getOpenInterest(symbol);

    if (
      !k5m?.length ||
      !k15m?.length ||
      !k1h?.length
    ) {
      return null;
    }

    // ----------------------------
    // 5m ARRAYS
    // ----------------------------
    const o5 = k5m.map((x) =>
      num(x[1])
    );

    const h5 = k5m.map((x) =>
      num(x[2])
    );

    const l5 = k5m.map((x) =>
      num(x[3])
    );

    const c5 = k5m.map((x) =>
      num(x[4])
    );

    const v5 = k5m.map((x) =>
      num(x[5])
    );

    // ----------------------------
    // 15m ARRAYS
    // ----------------------------
    const l15 = k15m.map((x) =>
      num(x[3])
    );

    const c15 = k15m.map((x) =>
      num(x[4])
    );

    // ----------------------------
    // 1H ARRAYS
    // ----------------------------
    const h1 = k1h.map((x) =>
      num(x[2])
    );

    const l1 = k1h.map((x) =>
      num(x[3])
    );

    const c1 = k1h.map((x) =>
      num(x[4])
    );

    // ----------------------------
    // CURRENT CANDLE DATA
    // ----------------------------
    const lastOpen = o5.at(-1);

    const lastHigh = h5.at(-1);

    const lastLow = l5.at(-1);

    const lastClose = c5.at(-1);

    const prevClose = c5.at(-2);

    const lastVol = v5.at(-1);

    const avgVol = avg(
      v5.slice(0, -1)
    );

    // ----------------------------
    // DUMP AGE DETECTION
    // ----------------------------
    const dumpAge =
      detectDumpAge(c5);

    // ---------------------------------
    // 1 MOMENTUM
    // ---------------------------------
    const dropPct = pct(
      lastClose,
      prevClose
    );

    // ---------------------------------
    // 2 VOLUME SPIKE
    // ---------------------------------
    const relVol = avgVol
      ? lastVol / avgVol
      : 0;

    // ---------------------------------
    // 3 MULTI-TF BREAKDOWN
    // ---------------------------------
    const low5 = getRecentLow(
      l5,
      20
    );

    const low15 = getRecentLow(
      l15,
      20
    );

    const low1h = getRecentLow(
      l1,
      20
    );

    const break5 =
      lastClose < low5;

    const break15 =
      c15.at(-1) < low15;

    const break1h =
      c1.at(-1) < low1h;

    // ---------------------------------
    // 4 OI BEHAVIOR
    // ---------------------------------
    const oiPct = pct(oi2, oi1);

    // ---------------------------------
    // 5 STRUCTURE LOWER HIGHS
    // ---------------------------------
    const hA = h5.at(-2);
    const hB = h5.at(-3);
    const hC = h5.at(-4);

    const structureBearish =
      hC > hB && hB > hA;

    // ---------------------------------
    // SELL AGGRESSION
    // ---------------------------------
    const redBody =
      lastClose < lastOpen;

    const bodyPct = pct(
      lastOpen,
      lastClose
    );

    const rangePct = pct(
      lastHigh,
      lastLow
    );

    // ================================
    // SCORING ENGINE
    // ================================

    // Momentum score
    const momentumScore =
      dropPct < 0
        ? clamp(
            (Math.abs(dropPct) /
              2.5) *
              WEIGHTS.momentum,
            0,
            WEIGHTS.momentum
          )
        : 0;

    // Volume score
    const volumeScore =
      redBody
        ? clamp(
            (relVol / 4) *
              WEIGHTS.volume,
            0,
            WEIGHTS.volume
          )
        : 0;

    // Breakdown score
    let breakdownHits = 0;

    if (break5) breakdownHits++;

    if (break15) breakdownHits++;

    if (break1h) breakdownHits++;

    const breakdownScore =
      (breakdownHits / 3) *
      WEIGHTS.multiTFBreakdown;

    // OI score
    let oiScore = 0;

    // Fresh shorts opening
    if (
      dropPct < 0 &&
      oiPct > 0
    ) {
      oiScore = clamp(
        (oiPct / 2) *
          WEIGHTS.oi,
        0,
        WEIGHTS.oi
      );
    }

    // Long liquidation
    else if (
      dropPct < 0 &&
      oiPct < 0
    ) {
      oiScore = clamp(
        (Math.abs(oiPct) / 3) *
          WEIGHTS.oi,
        0,
        WEIGHTS.oi
      );
    }

    // Funding score
    let fundingScore = 0;

    if (
      funding <= 0 &&
      funding >= -0.0012
    ) {
      fundingScore =
        WEIGHTS.funding;
    } else if (
      funding < -0.0012
    ) {
      fundingScore =
        WEIGHTS.funding * 0.5;
    }

    // Structure score
    const structureScore =
      structureBearish
        ? WEIGHTS.structure
        : 0;

    // BTC weakness score
    const btcScore = clamp(
      (btcWeakness / 1.2) *
        WEIGHTS.btcWeakness,
      0,
      WEIGHTS.btcWeakness
    );

    // Sell pressure score
    let sellPressureScore = 0;

    if (redBody) {
      sellPressureScore = clamp(
        ((bodyPct + rangePct) /
          3) *
          WEIGHTS.sellPressure,
        0,
        WEIGHTS.sellPressure
      );
    }

    // Cascade liquidation bonus
    let cascadeBonus = 0;

    if (
      dropPct <= -1.5 &&
      relVol > 2.5 &&
      oiPct < 0 &&
      breakdownHits >= 2
    ) {
      cascadeBonus =
        WEIGHTS.cascadeBonus;
    }

    // Exhaustion penalty
    let exhaustionPenalty = 0;

    if (
      dropPct <= -4 &&
      relVol > 5 &&
      funding < -0.003
    ) {
      exhaustionPenalty =
        WEIGHTS.exhaustionPenalty;
    }

    // ----------------------------
    // FINAL SCORE
    // ----------------------------
    const total =
      momentumScore +
      volumeScore +
      breakdownScore +
      oiScore +
      fundingScore +
      structureScore +
      btcScore +
      sellPressureScore +
      cascadeBonus +
      exhaustionPenalty;

    // ----------------------------
    // CLASSIFICATION
    // ----------------------------
    const label = classifyDump({
      dropPct,
      relVol,
      oiPct,
      rangePct,
      structureBearish,
    });

    // ----------------------------
    // RETURN OUTPUT
    // ----------------------------
    return {
      symbol,

      score:
        total.toFixed(2),

      dropPct:
        dropPct.toFixed(2) + "%",

      relVol:
        relVol.toFixed(2),

      oiPct:
        oiPct.toFixed(2) + "%",

      funding:
        funding.toFixed(6),

      breaks:
        `${breakdownHits}/3`,

      type: label,

      dumpAge:
        `${dumpAge.minutes}m`,

      phase:
        dumpAge.freshness,

      bars:
        dumpAge.barsAgo,

      vol24h: Math.round(
        meta.quoteVolume
      ).toLocaleString(),
    };
  } catch {
    return null;
  }
}

// ----------------------------
// MAIN LOOP
// ----------------------------
async function run() {
  console.clear();

  console.log(
    "=== BINANCE FUTURES DUMP TRACKER V2 ==="
  );

  console.log(
    "Institution Grade"
  );

  console.log(
    "Min 24h Vol:",
    MIN_24H_VOLUME.toLocaleString()
  );

  console.log("");

  while (true) {
    try {
      const [
        pairs,
        btcWeakness,
      ] = await Promise.all([
        getEligiblePairs(),
        getBTCWeakness(),
      ]);

      const limit =
        pLimit(CONCURRENCY);

      const jobs = pairs.map((p) =>
        limit(() =>
          analyzeSymbol(
            p,
            btcWeakness
          )
        )
      );

      const results = (
        await Promise.all(jobs)
      )
        .filter(Boolean)

        .filter(
          (x) =>
            Number(x.score) >= 45
        )

        .sort(
          (a, b) =>
            Number(b.score) -
            Number(a.score)
        )

        .slice(0, TOP_RESULTS);

      console.clear();

      console.log(
        `=== LIVE DUMP TRACKER V2 | ${new Date().toLocaleTimeString()} ===`
      );

      console.log("");

      if (!results.length) {
        console.log(
          "No elite dump setups detected."
        );
      } else {
        console.table(results);
      }
    } catch (err) {
      console.log(
        "Loop Error:",
        err.message
      );
    }

    await sleep(LOOP_MS);
  }
}

run();
