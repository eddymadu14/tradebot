import axios from "axios";
import { RSI } from "technicalindicators";

const BINANCE_FAPI = "https://fapi.binance.com";

const SETTINGS = {
    MIN_VOLUME: 20_000_000,
    MIN_GAIN: 8,
    TOP_LIMIT: 25,
    RSI_PERIOD: 14,
    TIMEFRAME: "4h",
    KLINE_LIMIT: 100
};

// ================= FETCH =================
async function getTickers() {
    const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`);
    return data.filter(t => t.symbol.endsWith("USDT"));
}

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

// ================= INDICATORS =================
function calculateRSI(closes) {
    return RSI.calculate({
        values: closes,
        period: SETTINGS.RSI_PERIOD
    });
}

// ================= SCORING + DIAGNOSTICS =================
function analyzeExhaustion(candles) {
    let score = 0;
    const reasons = [];
    const details = {};

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const rsi = calculateRSI(closes);

    if (rsi.length < 5) return { score: 0, reasons, details };

    const last = candles.at(-1);
    const prev = candles.at(-2);

    // === 1. Upper Wick (25) ===
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.close, last.open);

    details.upperWick = {
        body,
        wick: upperWick,
        ratio: body > 0 ? (upperWick / body).toFixed(2) : 0
    };

    if (body > 0 && upperWick > body * 1.5) {
        score += 25;
        reasons.push("Upper wick rejection");
    }

    // === 2. RSI Divergence (15) ===
    const rsiNow = rsi.at(-1);
    const rsiPast = rsi.at(-5);
    const priceNow = closes.at(-1);
    const pricePast = closes.at(-5);

    details.rsi = {
        current: rsiNow,
        past: rsiPast,
        priceNow,
        pricePast
    };

    if (priceNow > pricePast && rsiNow < rsiPast) {
        score += 15;
        reasons.push("RSI divergence");
    }

    // === 3. Volume Spike Failure (25) ===
    const avgVolume =
        volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;

    details.volume = {
        current: last.volume,
        avg: avgVolume,
        ratio: (last.volume / avgVolume).toFixed(2)
    };

    if (last.volume > avgVolume * 1.8 && last.close <= prev.close) {
        score += 25;
        reasons.push("Volume spike without continuation");
    }

    // === 4. Bullish Run (15) ===
    const last5 = candles.slice(-5);
    const bullishCount = last5.filter(c => c.close > c.open).length;

    details.bullishCandles = {
        count: bullishCount
    };

    if (bullishCount >= 4) {
        score += 15;
        reasons.push("Overextended bullish run");
    }

    // === 5. Overextension (20) ===
    const avgClose =
        closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    const extension = (last.close - avgClose) / avgClose;

    details.extension = {
        percent: (extension * 100).toFixed(2)
    };

    if (extension > 0.06) {
        score += 20;
        reasons.push("Price overextended from mean");
    }

    return { score, reasons, details };
}

// ================= MAIN =================
async function runScanner() {
    console.log("Scanning market...\n");

    const tickers = await getTickers();

    const filtered = tickers.filter(t => {
        const volume = +t.quoteVolume;
        const gain = +t.priceChangePercent;
        return volume >= SETTINGS.MIN_VOLUME && gain >= SETTINGS.MIN_GAIN;
    });

    console.log(`Filtered pairs: ${filtered.length}`);

    const topPairs = filtered
        .sort((a, b) => +b.priceChangePercent - +a.priceChangePercent)
        .slice(0, SETTINGS.TOP_LIMIT);

    const results = [];

    for (const pair of topPairs) {
        const symbol = pair.symbol;

        try {
            const candles = await getKlines(symbol);
            if (candles.length < 50) continue;

            const { score, reasons, details } = analyzeExhaustion(candles);

            if (score >= 50) {
                results.push({
                    symbol,
                    gain: +pair.priceChangePercent,
                    score,
                    reasons,
                    details
                });
            }

        } catch {
            console.log(`Skipping ${symbol}`);
        }
    }

    console.log("\n=== EXHAUSTION ANALYSIS ===\n");

    if (!results.length) {
        console.log("No exhaustion signals.");
        return;
    }

    results
        .sort((a, b) => b.score - a.score)
        .forEach(r => {
            console.log(`\n${r.symbol}`);
            console.log(`Gain: ${r.gain.toFixed(2)}% | Score: ${r.score}%`);
            console.log(`Reasons: ${r.reasons.join(", ")}`);

            console.log("Details:");
            console.log(JSON.stringify(r.details, null, 2));
        });
}

runScanner();
