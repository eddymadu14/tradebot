/**
 * CTWL-1H PRO — Single Call Trade Engine
 * ------------------------------------
 * Returns FULL trade parameters or NO_TRADE
 * ES Module (.js)
 */

export function 1hr({
  symbol = "BTCUSDT",
  candles5m = [],
  candles15m = [],
  candles1h = [],
  candles4h = []
}) {
  if (
    candles5m.length < 50 ||
    candles15m.length < 50 ||
    candles1h.length < 100 ||
    candles4h.length < 50
  ) {
    return noTrade("INSUFFICIENT_DATA");
  }

  /* ======================
     ANALYSIS LAYERS
  ====================== */

  const htf = analyzeHTF(candles4h);
  const liquidity = detectLiquidity(candles15m);
  const flip = detectExecutionFlip(candles5m);
  const volatility = volatilityGate(candles1h);

  if (
    !flip.flipped ||
    !liquidity.sweep ||
    !volatility.expand ||
    htf.trend !== flip.direction
  ) {
    return noTrade("CONDITIONS_NOT_MET");
  }

  /* ======================
     TRADE CONSTRUCTION
  ====================== */

  const zone = buildEntryZone(candles5m, flip.direction);
  const atr = ATR(candles1h.slice(-14));

  const trade = buildTrade({
    symbol,
    direction: flip.direction,
    zone,
    atr
  });

  const probability = computeProbability({
    htf,
    liquidity,
    flip,
    volatility
  });

  if (probability < 70) {
    return noTrade("LOW_PROBABILITY");
  }

  return {
    permission: "TRADE",
    symbol,
    timeframe: "1H",
    direction: trade.direction,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    rr: trade.rr,
    probability,
    context: {
      htf: htf.trend,
      liquidity: liquidity.direction,
      volatility: volatility.state
    },
    timestamp: Date.now()
  };
}

/* ======================
   CORE LOGIC
====================== */

function analyzeHTF(candles) {
  const a = candles.at(-1);
  const b = candles.at(-2);

  if (a.close > b.high && a.low > b.low) return { trend: "BULL" };
  if (a.close < b.low && a.high < b.high) return { trend: "BEAR" };

  return { trend: "RANGE" };
}

function detectLiquidity(candles) {
  const a = candles.at(-1);
  const b = candles.at(-2);

  const highSweep = a.high > b.high && a.close < b.high;
  const lowSweep = a.low < b.low && a.close > b.low;

  return {
    sweep: highSweep || lowSweep,
    direction: lowSweep ? "BULL" : highSweep ? "BEAR" : null
  };
}

function detectExecutionFlip(candles) {
  const a = candles.at(-1);
  const b = candles.at(-2);

  if (a.close > b.high && a.low > b.low)
    return { flipped: true, direction: "BULL" };

  if (a.close < b.low && a.high < b.high)
    return { flipped: true, direction: "BEAR" };

  return { flipped: false };
}

function volatilityGate(candles) {
  const fast = ATR(candles.slice(-14));
  const slow = ATR(candles.slice(-50));

  const expand = fast > slow * 1.1;

  return {
    expand,
    state: expand ? "EXPANDING" : "COMPRESSED"
  };
}

/* ======================
   TRADE BUILDER
====================== */

function buildEntryZone(candles, direction) {
  const c = candles.at(-1);

  if (direction === "BULL") {
    return {
      entry: (c.low + c.close) / 2,
      invalidation: c.low
    };
  }

  if (direction === "BEAR") {
    return {
      entry: (c.high + c.close) / 2,
      invalidation: c.high
    };
  }

  return null;
}

function buildTrade({ symbol, direction, zone, atr }) {
  const risk = atr * 0.75; // 🔥 volatility-normalized risk

  let stopLoss, takeProfit;

  if (direction === "BULL") {
    stopLoss = zone.invalidation - risk;
    takeProfit = zone.entry + risk * 2.5;
  } else {
    stopLoss = zone.invalidation + risk;
    takeProfit = zone.entry - risk * 2.5;
  }

  const rr =
    Math.abs(takeProfit - zone.entry) /
    Math.abs(zone.entry - stopLoss);

  return {
    symbol,
    direction,
    entry: zone.entry,
    stopLoss,
    takeProfit,
    rr: Number(rr.toFixed(2))
  };
}

/* ======================
   SCORING
====================== */

function computeProbability({ htf, liquidity, flip, volatility }) {
  let score = 0;

  if (htf.trend === flip.direction) score += 30;
  if (liquidity.sweep) score += 25;
  if (flip.flipped) score += 25;
  if (volatility.expand) score += 20;

  return Math.min(score, 100);
}

/* ======================
   INDICATORS
====================== */

function ATR(candles) {
  let sum = 0;

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;

    sum += Math.max(
      h - l,
      Math.abs(h - pc),
      Math.abs(l - pc)
    );
  }

  return sum / (candles.length - 1);
}

/* ======================
   UTIL
====================== */

function noTrade(reason) {
  return {
    permission: "NO_TRADE",
    reason,
    timestamp: Date.now()
  };
}
