/**
 * CTWL-FlipX v2.0 - Live Trade Ready
 * Node.js Engine
 * Features:
 * 1. Live OHLC feed from Binance
 * 2. LTF regime flip detection
 * 3. ATR compression + chop calculation
 * 4. Trend alignment tagging
 * 5. Pullback-based entry + dynamic SL/TP
 * 6. Tiered signal output
 */

const Binance = require('node-binance-api');
const binance = new Binance().options({ reconnect: true });

// ---------------------------
// CONFIG
// ---------------------------
const CONFIG = {
    SYMBOL: 'BTCUSDT',
    INTERVAL: '15m',   // LTF timeframe
    ATR_PERIOD: 14,
    COMPRESSION_LOOKBACK: 5,
    CHOP_LOOKBACK: 10,
    CHOP_MAX_SCORE: 1,
    PULLBACK_FIB: [0.382, 0.5],
    MAX_RISK_WITH_TREND: 0.5,
    MAX_RISK_AGAINST_TREND: 0.3,
    TIER_CRITERIA: {
        STRONG: { minImpulseATR: 0.6, maxDeviation: 2 },
        MEDIUM: { minImpulseATR: 0.4, maxDeviation: 3 },
        WEAK: { minImpulseATR: 0.3, maxDeviation: 4 },
    },
    HTF_TREND: 'BEAR',  // can be dynamic if needed
    HTF_ZONE: { low: 86267.85, high: 90140.75 },
};

// ---------------------------
// UTILITY FUNCTIONS
// ---------------------------
function calculateATR(candles, period = CONFIG.ATR_PERIOD) {
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateDeviation(entry, midZone, atr) {
    return Math.abs(entry - midZone) / atr;
}

// Simple chop score based on range vs ATR
function calculateChop(candles, lookback = CONFIG.CHOP_LOOKBACK) {
    if (candles.length < lookback) return 0;
    let high = Math.max(...candles.slice(-lookback).map(c => c.high));
    let low = Math.min(...candles.slice(-lookback).map(c => c.low));
    let range = high - low;
    let atr = calculateATR(candles.slice(-lookback));
    return range / atr; // Lower = less chop
}

// ATR compression detection
function isATRCompressed(candles, lookback = CONFIG.COMPRESSION_LOOKBACK) {
    if (candles.length < lookback) return false;
    const atrs = [];
    for (let i = candles.length - lookback; i < candles.length; i++) {
        atrs.push(candles[i].high - candles[i].low);
    }
    const maxATR = Math.max(...atrs);
    const minATR = Math.min(...atrs);
    return (maxATR - minATR) / maxATR < 0.3; // threshold adjustable
}

// ---------------------------
// LTF REGIME DETECTION
// ---------------------------
function detectLTFRegime(candle, prevCandle) {
    if (!prevCandle) return "NEUTRAL";
    if (candle.close > prevCandle.high) return "BULL";
    if (candle.close < prevCandle.low) return "BEAR";
    return "NEUTRAL";
}

function detectFlip(prevRegime, currentRegime) {
    if (prevRegime === "NEUTRAL" || currentRegime === "NEUTRAL") return false;
    return prevRegime !== currentRegime;
}

// Pullback entry levels
function calculatePullbackEntry(flipImpulse, fibLevels = CONFIG.PULLBACK_FIB) {
    return fibLevels.map(fib => flipImpulse.high - fib * (flipImpulse.high - flipImpulse.low));
}

// Tier assignment
function assignTier(signal) {
    const imp = signal.flipImpulseATR;
    const dev = signal.deviation;
    if (imp >= CONFIG.TIER_CRITERIA.STRONG.minImpulseATR && dev <= CONFIG.TIER_CRITERIA.STRONG.maxDeviation) return "STRONG";
    if (imp >= CONFIG.TIER_CRITERIA.MEDIUM.minImpulseATR && dev <= CONFIG.TIER_CRITERIA.MEDIUM.maxDeviation) return "MEDIUM";
    return "WEAK";
}

// ---------------------------
// LIVE FLIPX ENGINE
// ---------------------------
async function runFlipXLive() {
    try {
        const rawCandles = await binance.candlesticks(CONFIG.SYMBOL, CONFIG.INTERVAL, { limit: 50 });
        const candles = rawCandles.map(c => ({
            time: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4])
        }));

        let prevRegime = null;
        const signals = [];

        for (let i = CONFIG.ATR_PERIOD; i < candles.length; i++) {
            const candle = candles[i];
            const prevCandle = candles[i - 1];
            const currentRegime = detectLTFRegime(candle, prevCandle);

            if (detectFlip(prevRegime, currentRegime)) {
                // Flip detected
                const flipImpulse = { high: candle.high, low: candle.low };
                const atr = calculateATR(candles.slice(i - CONFIG.ATR_PERIOD, i + 1));
                const deviation = calculateDeviation(candle.close, (CONFIG.HTF_ZONE.high + CONFIG.HTF_ZONE.low) / 2, atr);
                const chopScore = calculateChop(candles);
                const atrCompression = isATRCompressed(candles);

                const signal = {
                    time: candle.time,
                    symbol: CONFIG.SYMBOL,
                    flipDirection: currentRegime,
                    htfTrend: CONFIG.HTF_TREND,
                    trendAlignment: currentRegime === CONFIG.HTF_TREND ? "WITH" : "AGAINST",
                    flipImpulse,
                    flipImpulseATR: atr,
                    entryLevels: calculatePullbackEntry(flipImpulse),
                    deviation,
                    chopScore,
                    atrCompression,
                };

                // Filter signals
                if (atrCompression && chopScore <= CONFIG.CHOP_MAX_SCORE && deviation <= 4) {
                    signal.tier = assignTier(signal);

                    if (signal.trendAlignment === "WITH") {
                        signal.SL = flipImpulse.low - 0.1 * atr;
                        signal.TPs = [flipImpulse.high, CONFIG.HTF_ZONE.high, CONFIG.HTF_ZONE.high + 0.5 * atr];
                        signal.maxRiskPercent = CONFIG.MAX_RISK_WITH_TREND;
                    } else {
                        signal.SL = flipImpulse.low - 0.2 * atr;
                        signal.TPs = [flipImpulse.high, flipImpulse.high + atr];
                        signal.maxRiskPercent = CONFIG.MAX_RISK_AGAINST_TREND;
                    }

                    signals.push(signal);
                }
            }

            prevRegime = currentRegime;
        }

        console.log("CTWL-FlipX Live Signals:", JSON.stringify(signals, null, 2));

    } catch (err) {
        console.error("Error fetching or processing live candles:", err);
    }
}

// Run live engine every INTERVAL
setInterval(runFlipXLive, 60 * 1000); // 1 min for testing; can adjust to INTERVAL
