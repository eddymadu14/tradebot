/**
 * CTWL-FlipX v2.1 - Live + Telegram Alerts
 * Node.js Engine
 */

const Binance = require('node-binance-api');
const axios = require('axios'); // For Telegram webhook
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
    HTF_TREND: 'BEAR',  // can be dynamic
    HTF_ZONE: { low: 86267.85, high: 90140.75 },
    TELEGRAM_BOT_TOKEN: 'YOUR_TELEGRAM_BOT_TOKEN',  // Replace
    TELEGRAM_CHAT_ID: 'YOUR_CHAT_ID',              // Replace
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

function calculateChop(candles, lookback = CONFIG.CHOP_LOOKBACK) {
    if (candles.length < lookback) return 0;
    const highs = candles.slice(-lookback).map(c => c.high);
    const lows = candles.slice(-lookback).map(c => c.low);
    const range = Math.max(...highs) - Math.min(...lows);
    const atr = calculateATR(candles.slice(-lookback));
    return range / atr; // Lower = less chop
}

function isATRCompressed(candles, lookback = CONFIG.COMPRESSION_LOOKBACK) {
    if (candles.length < lookback) return false;
    const atrs = [];
    for (let i = candles.length - lookback; i < candles.length; i++) {
        atrs.push(candles[i].high - candles[i].low);
    }
    const maxATR = Math.max(...atrs);
    const minATR = Math.min(...atrs);
    return (maxATR - minATR) / maxATR < 0.3;
}

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

function calculatePullbackEntry(flipImpulse, fibLevels = CONFIG.PULLBACK_FIB) {
    return fibLevels.map(fib => flipImpulse.high - fib * (flipImpulse.high - flipImpulse.low));
}

function assignTier(signal) {
    const imp = signal.flipImpulseATR;
    const dev = signal.deviation;
    if (imp >= CONFIG.TIER_CRITERIA.STRONG.minImpulseATR && dev <= CONFIG.TIER_CRITERIA.STRONG.maxDeviation) return "STRONG";
    if (imp >= CONFIG.TIER_CRITERIA.MEDIUM.minImpulseATR && dev <= CONFIG.TIER_CRITERIA.MEDIUM.maxDeviation) return "MEDIUM";
    return "WEAK";
}

// ---------------------------
// TELEGRAM ALERT
// ---------------------------
async function sendTelegramAlert(signal) {
    const message = `
🚀 CTWL-FlipX Signal
Symbol: ${signal.symbol}
Flip: ${signal.flipDirection} (${signal.trendAlignment} HTF: ${signal.htfTrend})
Tier: ${signal.tier}
Impulse ATR: ${signal.flipImpulseATR.toFixed(2)}
Deviation: ${signal.deviation.toFixed(2)}
Entry Levels: ${signal.entryLevels.map(e => e.toFixed(2)).join(", ")}
SL: ${signal.SL.toFixed(2)}
TPs: ${signal.TPs.map(tp => tp.toFixed(2)).join(", ")}
Max Risk: ${signal.maxRiskPercent}%
Time: ${new Date(signal.time).toLocaleString()}
    `;
    try {
        await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: CONFIG.TELEGRAM_CHAT_ID,
            text: message
        });
    } catch (err) {
        console.error("Telegram send error:", err);
    }
}

// ---------------------------
// MAIN FLIPX LIVE ENGINE
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

        for (let i = CONFIG.ATR_PERIOD; i < candles.length; i++) {
            const candle = candles[i];
            const prevCandle = candles[i - 1];
            const currentRegime = detectLTFRegime(candle, prevCandle);

            if (detectFlip(prevRegime, currentRegime)) {
                const flipImpulse = { high: candle.high, low: candle.low };
                const atr = calculateATR(candles.slice(i - CONFIG.ATR_PERIOD, i + 1));
                const deviation = calculateDeviation(candle.close, (CONFIG.HTF_ZONE.high + CONFIG.HTF_ZONE.low)/2, atr);
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

                // Filter valid signals
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

                    // Send Telegram alert
                    await sendTelegramAlert(signal);
                    console.log(`📲 FlipX Signal Sent: ${signal.flipDirection} | Tier: ${signal.tier}`);
                }
            }

            prevRegime = currentRegime;
        }

    } catch (err) {
        console.error("Error in live FlipX engine:", err);
    }
}

// Run live engine periodically
setInterval(runFlipXLive, 60 * 1000); // Every 1 min
