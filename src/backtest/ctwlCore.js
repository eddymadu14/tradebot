import { EMA, ATR } from "technicalindicators";

/* ================= CONSTANTS ================= */
const ATR_PERIOD = 14;
const ATR_SHORT = 20;
const ATR_LONG = 30;
const ENTRY_MULT = 2.0;
const STOP_MULT = 0.5;
const EMA_STACK = [20, 50, 100, 200];

/* ================= HELPERS ================= */
function computeATRSeries(candles, period) {
  if (!candles || candles.length < period + 1) return [];
  return ATR.calculate({
    high: candles.map(c => c.h),
    low: candles.map(c => c.l),
    close: candles.map(c => c.c),
    period
  });
}

/* ================= TREND ================= */
function detectTrend(daily) {
  if (!daily || daily.length < 200) return null;

  const closes = daily.map(c => c.c);
  const emas = EMA_STACK.map(p =>
    EMA.calculate({ period: p, values: closes }).at(-1)
  );

  const last = closes.at(-1);
  if (emas.every(e => last > e)) return "bull";
  if (emas.every(e => last < e)) return "bear";
  return null;
}

/* ================= LTF ================= */
function detectLTFBias(ltf) {
  if (!ltf || ltf.length < 21) return "neutral";
  const closes = ltf.map(c => c.c);
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const slope = ema20.at(-1) - ema20.at(-2);
  return slope > 0 ? "bull" : slope < 0 ? "bear" : "neutral";
}

/* ================= CHOP ================= */
function computeChopDetails(candles) {
  if (!candles || candles.length < 30) return { isChop: false };

  const atr = computeATRSeries(candles, ATR_PERIOD);
  if (!atr.length) return { isChop: false };

  const avgATR = atr.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const range =
    Math.max(...candles.slice(-8).map(c => c.h)) -
    Math.min(...candles.slice(-8).map(c => c.l));

  return { isChop: range < 2 * avgATR };
}

/* ================= ZONE DETECTION ================= */
function detectImpulseOriginZone(intraday, trend) {
  if (!intraday || intraday.length < 50) return null;

  const atrShort = computeATRSeries(intraday, ATR_SHORT);
  const atrLong = computeATRSeries(intraday, ATR_LONG);
  const atr = atrShort.at(-1);
  if (!atr) return null;

  for (let i = intraday.length - 2; i >= 10; i--) {
    const c = intraday[i];
    const body = Math.abs(c.c - c.o);
    const impulse = body / atr;
    if (impulse < 1) continue;

    return {
      min: c.l - 0.25 * atr,
      max: c.h + 0.25 * atr,
      entry:
        trend === "bull"
          ? c.o + ENTRY_MULT * atr
          : c.o - ENTRY_MULT * atr,
      atrShort: atr,
      atrLong: atrLong.at(-1),
      isCompressed: atrShort.at(-1) < atrLong.at(-1),
      latentStrength: impulse
    };
  }

  return null;
}

/* ================= RETEST ================= */
function validateRetest(intraday, zone, trend) {
  for (let i = intraday.length - 10; i < intraday.length; i++) {
    const c = intraday[i];
    if (c.h >= zone.min && c.l <= zone.max) {
      if (trend === "bull" && c.c > c.o) return true;
      if (trend === "bear" && c.c < c.o) return true;
    }
  }
  return false;
}

/* ================= STRENGTH ================= */
function computeStrength({ zone, trend, ltfBias, chop }) {
  let s = Math.min(zone.latentStrength, 1.5);

  if (ltfBias !== "neutral" && ltfBias !== trend) s -= 0.7;
  if (zone.retest && ltfBias === trend) s += 0.4;
  if (zone.isCompressed && ltfBias === trend) s += 0.3;
  if (chop?.isChop) s -= 0.6;

  return Math.max(0, s);
}

/* ================= SL / TP ================= */
function computeSLTP(zone, trend) {
  const entry = zone.entry;
  const sl =
    trend === "bull"
      ? entry - zone.atrShort * STOP_MULT
      : entry + zone.atrShort * STOP_MULT;

  const risk = Math.abs(entry - sl);
  return {
    entry,
    sl,
    tp: trend === "bull" ? entry + 3 * risk : entry - 3 * risk
  };
}

/* ================= PURE EVALUATOR ================= */
export function evaluateCTWL({ daily, intraday, ltf }) {
  const trend = detectTrend(daily);
  if (!trend) return null;

  const zone = detectImpulseOriginZone(intraday, trend);
  if (!zone) return null;

  zone.retest = validateRetest(intraday, zone, trend);

  const ltfBias = detectLTFBias(ltf);
  const chop = computeChopDetails(intraday);

  const strength = computeStrength({
    zone,
    trend,
    ltfBias,
    chop
  });

  const sltp = computeSLTP(zone, trend);

  return {
    trend,
    zone,
    strength,
    ltfBias,
    chop,
    ...sltp
  };
}
