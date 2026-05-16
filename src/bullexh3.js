// exhaustion-scanner.mjs

import axios from "axios";
import { RSI } from "technicalindicators";

// ================= CONFIG =================
const BINANCE_FAPI = "https://fapi.binance.com";

const SETTINGS = {
    MIN_VOLUME: 20_000_000,
    MIN_GAIN: 8,
    TOP_LIMIT: 25,
    RSI_PERIOD: 14,
    TIMEFRAME: "4h",
    KLINE_LIMIT: 120,
    RETRIES: 2,
    TIMEOUT: 10000
};

// ================= GLOBAL SAFETY =================
process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});

// ================= AXIOS =================
const api = axios.create({
    baseURL: BINANCE_FAPI,
    timeout: SETTINGS.TIMEOUT
});

// ================= HELPERS =================
const num = (v) => Number(v || 0);

function safeAvg(arr, len) {
    if (!arr || arr.length < len) return null;
    const slice = arr.slice(-len);
    return slice.reduce((a, b) => a + b, 0) / len;
}

// ================= SAFE FETCH =================
async function safeFetch(fn, retries = SETTINGS.RETRIES) {
    try {
        return await fn();
    } catch (err) {
        if (retries > 0) {
            return safeFetch(fn, retries - 1);
        }
        throw err;
    }
}

// ================= FETCH TICKERS =================
async function getTickers() {
    const { data } = await safeFetch(() =>
        api.get("/fapi/v1/ticker/24hr")
    );

    if (!Array.isArray(data)) {
        throw new Error("Invalid ticker response");
    }

    return data.filter(t => t.symbol.endsWith("USDT"));
}

// ================= FETCH KLINES =================
async function getKlines(symbol) {
    const { data } = await safeFetch(() =>
        api.get("/fapi/v1/klines", {
            params: {
                symbol,
                interval: SETTINGS.TIMEFRAME,
                limit: SETTINGS.KLINE_LIMIT
            }
        })
    );

    if (!Array.isArray(data) || data.length < 30) {
        return null;
    }

    return data.map(k => ({
        open: num(k[1]),
        high: num(k[2]),
        low: num(k[3]),
        close: num(k[4]),
        volume: num(k[5])
    }));
}

// ================= RSI =================
function calculateRSI(closes) {
    if (!closes || closes.length < SETTINGS.RSI_PERIOD + 5) return null;

    const rsi = RSI.calculate({
        values: closes,
        period: SETTINGS.RSI_PERIOD
    });

    return rsi.length ? rsi : null;
}

// ================= EXHAUSTION SCORING =================
function scoreExhaustion(candles) {
    if (!candles || candles.length < 30) return 0;

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    if (!last || !prev) return 0;

    let score = 0;

    // === RSI ===
    const rsi = calculateRSI(closes);
    if (!rsi || rsi.length < 5) return 0;

    const rsiLast = rsi[rsi.length - 1];
    const rsiPast = rsi[rsi.length - 5];

    const closeNow = closes[closes.length - 1];
    const closePast = closes[closes.length - 5];

    if (
        rsiLast === undefined ||
        rsiPast === undefined ||
        closeNow === undefined ||
        closePast === undefined
    ) {
        return 0;
    }

    // === 1. Upper Wick Rejection (25) ===
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.close, last.open);

    if (body > 0 && upperWick > body * 1.5) {
        score += 25;
    }

    // === 2. RSI Divergence (15) ===
    if (closeNow > closePast && rsiLast < rsiPast) {
        score += 15;
    }

    // === 3. Volume Spike Failure (25) ===
    const avgVolume = safeAvg(volumes, 10);

    if (
        avgVolume &&
        last.volume > avgVolume * 1.8 &&
        last.close <= prev.close
    ) {
        score += 25;
    }

    // === 4. Consecutive Bullish Candles (15) ===
    const bullishCount = candles
        .slice(-5)
        .filter(c => c.close > c.open).length;

    if (bullishCount >= 4) {
        score += 15;
    }

    // === 5. Overextension (20) ===
    const avgClose = safeAvg(closes, 20);

    if (avgClose) {
        const extension = (last.close - avgClose) / avgClose;

        if (extension > 0.06) {
            score += 20;
        }
    }

    return score;
}

// ================= MAIN SCANNER =================
async function runScanner() {
    try {
        console.log("Scanning market...\n");

        const tickers = await getTickers();

        const filtered = tickers.filter(t => {
            const volume = num(t.quoteVolume);
            const gain = num(t.priceChangePercent);

            return volume >= SETTINGS.MIN_VOLUME &&
                   gain >= SETTINGS.MIN_GAIN;
        });

        console.log(`Filtered pairs: ${filtered.length}`);

        if (!filtered.length) {
            console.log("No valid pairs found.");
            return;
        }

        const topPairs = filtered
            .sort((a, b) => num(b.priceChangePercent) - num(a.priceChangePercent))
            .slice(0, SETTINGS.TOP_LIMIT);

        const results = [];

        for (const pair of topPairs) {
            const symbol = pair.symbol;

            try {
                const candles = await getKlines(symbol);
                if (!candles) continue;

                const score = scoreExhaustion(candles);

                if (score >= 50) {
                    results.push({
                        symbol,
                        gain: num(pair.priceChangePercent),
                        volume: num(pair.quoteVolume),
                        score
                    });
                }

            } catch (err) {
                console.warn(`Skipping ${symbol}: ${err.message}`);
            }
        }

        console.log("\n=== BULLISH EXHAUSTION CANDIDATES ===\n");

        if (!results.length) {
            console.log("No exhaustion signals detected.");
            return;
        }

        results
            .sort((a, b) => b.score - a.score)
            .forEach(r => {
                let strength = "WEAK";

                if (r.score >= 80) strength = "HIGH";
                else if (r.score >= 65) strength = "STRONG";

                console.log(
                    `${r.symbol} | Gain: ${r.gain.toFixed(2)}% | Score: ${r.score}% | ${strength}`
                );
            });

    } catch (err) {
        console.error("=== FATAL ERROR ===");
        console.error(err);
        console.error(err.stack);
    }
}

// ================= RUN =================
runScanner();
