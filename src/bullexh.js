// exhaustion-scanner.mjs

import axios from "axios";
import { RSI } from "technicalindicators";

const BINANCE_FAPI = "https://fapi.binance.com";

// ================= SETTINGS =================
const SETTINGS = {
    MIN_VOLUME: 20_000_000, // $20M
    MIN_GAIN: 8,            // %
    TOP_LIMIT: 25,
    RSI_PERIOD: 14,
    TIMEFRAME: "4h",
    KLINE_LIMIT: 100
};

// ================= FETCH TICKERS =================
async function getTickers() {
    const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`);
    return data.filter(t => t.symbol.endsWith("USDT"));
}

// ================= FETCH KLINES =================
async function getKlines(symbol) {
    const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/klines`, {
        params: {
            symbol,
            interval: SETTINGS.TIMEFRAME,
            limit: SETTINGS.KLINE_LIMIT
        }
    });

    return data.map(k => ({
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5]
    }));
}

// ================= RSI =================
function calculateRSI(closes) {
    return RSI.calculate({
        values: closes,
        period: SETTINGS.RSI_PERIOD
    });
}

// ================= EXHAUSTION SCORING =================
function scoreExhaustion(candles) {
    let score = 0;

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const rsi = calculateRSI(closes);

    if (rsi.length < 5) return 0;

    const last = candles.at(-1);
    const prev = candles.at(-2);

    // === 1. Upper Wick Rejection (25) ===
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.close, last.open);

    if (body > 0 && upperWick > body * 1.5) {
        score += 25;
    }

    // === 2. RSI Divergence (15) ===
    if (
        closes.at(-1) > closes.at(-5) &&
        rsi.at(-1) < rsi.at(-5)
    ) {
        score += 15;
    }

    // === 3. Volume Spike Failure (25) ===
    const avgVolume =
        volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;

    if (
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
    const avgClose =
        closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    const extension = (last.close - avgClose) / avgClose;

    if (extension > 0.06) {
        score += 20;
    }

    return score; // 0–100
}

// ================= MAIN SCANNER =================
async function runScanner() {
    try {
        console.log("Scanning market...\n");

        const tickers = await getTickers();

        // === STEP 1: FILTER ===
        const filtered = tickers.filter(t => {
            const volume = +t.quoteVolume;
            const gain = +t.priceChangePercent;

            return volume >= SETTINGS.MIN_VOLUME &&
                   gain >= SETTINGS.MIN_GAIN;
        });

        console.log(`Filtered pairs: ${filtered.length}`);

        if (!filtered.length) {
            console.log("No valid pairs found.");
            return;
        }

        // === STEP 2: TOP MOVERS ===
        const topPairs = filtered
            .sort((a, b) => +b.priceChangePercent - +a.priceChangePercent)
            .slice(0, SETTINGS.TOP_LIMIT);

        const results = [];

        // === STEP 3: ANALYSIS ===
        for (const pair of topPairs) {
            const symbol = pair.symbol;

            try {
                const candles = await getKlines(symbol);

                if (candles.length < 50) continue;

                const score = scoreExhaustion(candles);

                if (score >= 50) {
                    results.push({
                        symbol,
                        gain: +pair.priceChangePercent,
                        volume: +pair.quoteVolume,
                        score
                    });
                }

            } catch {
                console.log(`Skipping ${symbol} (data issue)`);
            }
        }

        // === STEP 4: OUTPUT ===
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
        console.error("Fatal Error:", err.message);
    }
}

// ================= RUN =================
runScanner();
