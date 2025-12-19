/**
 * CTWL-24H PRO — Full Enhanced Directional Predictive Engine
 * ----------------------------------------------------------
 * Predicts BTC/ETH 24H direction with probability scoring
 * Implements all enhancements:
 * 1. HTF bias filter
 * 2. ATR-based volatility regime
 * 3. Zone survival logic
 * 4. Time-of-day weighting
 * 5. News / funding spike filter
 * 6. Liquidity alignment filter
 * 7. Backtesting module included
 */

import fetch from "node-fetch";

const BINANCE_BASE = "https://api.binance.com/api/v3";

// === UTILITY FUNCTIONS ===
async function fetchCandles(symbol, interval = "1h", limit = 200) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.map(c => ({
        openTime: c[0],
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5])
    }));
}

function calculateATR(candles, period = 14) {
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const highLow = candles[i].high - candles[i].low;
        const highClose = Math.abs(candles[i].high - candles[i - 1].close);
        const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
        trs.push(Math.max(highLow, highClose, lowClose));
    }
    const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    return atr;
}

function detectHTFBias(candles, htfPeriod = 24) {
    const recent = candles.slice(-htfPeriod);
    const closes = recent.map(c => c.close);
    if (closes[closes.length - 1] > closes[0]) return "BULL";
    else if (closes[closes.length - 1] < closes[0]) return "BEAR";
    else return "RANGE";
}

function findZones(candles, lookback = 50) {
    const highs = candles.slice(-lookback).map(c => c.high);
    const lows = candles.slice(-lookback).map(c => c.low);
    return {
        support: Math.min(...lows),
        resistance: Math.max(...highs)
    };
}

// Optional: time-of-day adjustment
function timeOfDayWeight(probability) {
    const hour = new Date().getUTCHours();
    if (hour >= 0 && hour <= 6) probability -= 3; // low liquidity
    return Math.max(probability, 50);
}

// Optional: news/funding spike filter (placeholder)
function newsFilter(probability, spike = false) {
    return spike ? 50 : probability; // 50 = neutral / ignore signal
}

// Optional: liquidity alignment (placeholder)
function liquidityFilter(currentPrice, zones, orderBook) {
    // Simplified example: check if buy pressure above support
    const buyPressure = orderBook?.bids?.reduce((sum, bid) => sum + bid[1], 0) || 0;
    const sellPressure = orderBook?.asks?.reduce((sum, ask) => sum + ask[1], 0) || 0;
    if (buyPressure > sellPressure && currentPrice > zones.support) return true;
    if (sellPressure > buyPressure && currentPrice < zones.resistance) return true;
    return false; // ignore if pressure misaligned
}

// === CORE 24H PREDICTION LOGIC ===
function predict24H(symbol, currentPrice, HTF, ATR, zones, options = {}) {
    let probabilityUp, probabilityDown;

    // --- Step 0: HTF filter ---
    if (HTF === "RANGE") return { prediction: "NO_TRADE", probability: 50, reason: "HTF range, skip prediction" };

    // --- Step 1: Base probability ---
    if (HTF === "BULL") { probabilityUp = 60; probabilityDown = 40; }
    else if (HTF === "BEAR") { probabilityUp = 40; probabilityDown = 60; }

    // --- Step 2: Volatility adjustment ---
    const atrPct = ATR / currentPrice;
    if (atrPct > 0.012) probabilityUp += HTF === "BULL" ? 5 : 0;
    if (atrPct < 0.005) probabilityUp -= HTF === "BULL" ? 5 : 0;

    // --- Step 3: Zone survival adjustment ---
    if (currentPrice > zones.support && HTF === "BULL") probabilityUp += 5;
    if (currentPrice < zones.resistance && HTF === "BEAR") probabilityDown += 5;

    // --- Step 4: Time-of-day adjustment ---
    probabilityUp = timeOfDayWeight(probabilityUp);
    probabilityDown = timeOfDayWeight(probabilityDown);

    // --- Step 5: Optional news/funding spike filter ---
    probabilityUp = newsFilter(probabilityUp, options.spike || false);
    probabilityDown = newsFilter(probabilityDown, options.spike || false);

    // --- Step 6: Optional liquidity alignment ---
    if (options.orderBook) {
        const validLiquidity = liquidityFilter(currentPrice, zones, options.orderBook);
        if (!validLiquidity) return { prediction: "NO_TRADE", probability: 50, reason: "Liquidity misalignment" };
    }

    // --- Step 7: Cap probabilities ---
    probabilityUp = Math.min(Math.max(probabilityUp, 50), 80);
    probabilityDown = Math.min(Math.max(probabilityDown, 50), 80);

    // --- Step 8: Decide prediction ---
    const prediction = probabilityUp >= probabilityDown ? "UP" : "DOWN";

    return {
        symbol,
        timeframe: "24H",
        reference_level: currentPrice,
        prediction,
        probability: prediction === "UP" ? probabilityUp : probabilityDown,
        valid_boundary: zones.support,
        invalid_boundary: zones.support - ATR * 0.5,
        context: { HTF, ATR_24H: ATR, zones }
    };
}

// === FULL RUNNER ===
export async function run24HPrediction(symbol = "BTCUSDT", options = {}) {
    const candles1H = await fetchCandles(symbol, "1h", 200);
    const currentPrice = candles1H[candles1H.length - 1].close;
    const ATR_24 = calculateATR(candles1H, 24);
    const HTF = detectHTFBias(candles1H, 24);
    const zones = findZones(candles1H, 50);

    const prediction = predict24H(symbol, currentPrice, HTF, ATR_24, zones, options);
    return prediction;
}

// === BACKTESTING MODULE ===
export async function backtest(symbol = "BTCUSDT", historyLength = 100, options = {}) {
    const candles1H = await fetchCandles(symbol, "1h", historyLength);
    const results = [];
    for (let i = 50; i < candles1H.length; i++) {
        const slice = candles1H.slice(0, i);
        const currentPrice = slice[slice.length - 1].close;
        const ATR_24 = calculateATR(slice, 24);
        const HTF = detectHTFBias(slice, 24);
        const zones = findZones(slice, 50);

        const prediction = predict24H(symbol, currentPrice, HTF, ATR_24, zones, options);

        if (prediction.prediction !== "NO_TRADE") {
            // Check survival over next 24 candles (next 24H)
            const nextCandles = candles1H.slice(i, i + 24);
            const survived = prediction.prediction === "UP"
                ? nextCandles.every(c => c.close >= prediction.valid_boundary)
                : nextCandles.every(c => c.close <= prediction.valid_boundary);

            results.push({ ...prediction, survived });
        }
    }

    const total = results.length;
    const wins = results.filter(r => r.survived).length;
    const accuracy = total ? (wins / total) * 100 : 0;

    return { totalSignals: total, wins, accuracy, results };
}

// === EXAMPLE USAGE ===
// (async () => {
//     const liveSignal = await run24HPrediction("BTCUSDT");
//     console.log(liveSignal);

//     const backtestResults = await backtest("BTCUSDT", 200);
//     console.log("Backtest accuracy:", backtestResults.accuracy);
// })();
