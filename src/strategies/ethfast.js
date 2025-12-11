import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
import WebSocket from "ws";
dotenv.config();

// =====================================================
// CTWL-Pro — ETH stand-alone sniper (1H-dominant, 4H bias)
// Upgraded: live shadow-candle layer + instant sweep detection
// Zones still computed from previous CLOSED 1H candle (no repaint)
// =====================================================

// ----------------- CONFIG -----------------
const SYMBOL = "ETH/USDT";
const PAIR_WS = "ethusdt";
const TIMEFRAMES = { daily: "1d", intraday: "1h", bias: "4h" };

const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.2;
const ZONE_ATR_PAD = { min: 0.15, max: 0.15 };

const SNIPER_WINDOW_STRICT = false;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

// ----------------- EXCHANGE -----------------
const exchange = new ccxt.binance({
    apiKey: BINANCE_API_KEY || undefined,
    secret: BINANCE_SECRET || undefined,
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: "future" },
});

// ----------------- LIVE LAYER STATE -----------------
let ws = null;
let wsConnected = false;
let livePrice = null;
let liveTradeVolRecently = 0;
let shadowCandle = null; // evolving 1H candle (open/high/low/close/volume, not closed yet)
let lastClosed1h = null; // the last fully closed 1H candle (frozen)
let lastClosed4h = null; // last closed 4H candle (for bias)
let liveSweepState = { lastSweepAt: 0 };

// ---------- SAFE FETCH ----------
async function safeFetch(exchangeInstance, method, ...args) {
    const maxRetries = 4;
    const baseDelay = 1200;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await method.apply(exchangeInstance, args);
        } catch (err) {
            console.warn(`[safeFetch] Attempt ${attempt} failed: ${err.message}`);
            if (attempt === maxRetries) throw err;
            const delay = baseDelay * attempt;
            await new Promise((res) => setTimeout(res, delay));
        }
    }
}

async function fetchCandles(symbol, timeframe, limit = 500) {
    const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
    return raw.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ---------- TREND DETECTION (unchanged) ----------
function detectTrend(intraday1h, bias4h) {
    if (!intraday1h.length) return { trend: "invalid", reason: "No 1H data" };

    const closes1h = intraday1h.map(c => c.c);
    if (closes1h.length < EMA_STACK[3]) return { trend: "invalid", reason: "Not enough 1H data" };

    const emaArr1h = {};
    EMA_STACK.forEach(p => { emaArr1h[p] = EMA.calculate({ period: p, values: closes1h }); });

    const lastClose1h = closes1h[closes1h.length - 1];
    const emaAbove1h = EMA_STACK.every(p => lastClose1h > emaArr1h[p].slice(-1)[0]);
    const emaBelow1h = EMA_STACK.every(p => lastClose1h < emaArr1h[p].slice(-1)[0]);

    const last5 = closes1h.slice(-6);
    const hhhl = last5.every((c, i, arr) => i === 0 ? true : c > arr[i - 1]);
    const lllh = last5.every((c, i, arr) => i === 0 ? true : c < arr[i - 1]);

    const ema20 = emaArr1h[20];
    const slope20 = ema20.slice(-1)[0] - ema20.slice(-2)[0];
    const bullishMomentum = slope20 > 0;
    const bearishMomentum = slope20 < 0;

    const bullishLayers = [emaAbove1h, hhhl, bullishMomentum].filter(Boolean).length;
    const bearishLayers = [emaBelow1h, lllh, bearishMomentum].filter(Boolean).length;

    let bias = null;
    try {
        const closes4h = bias4h.map(c => c.c);
        const ema200_4h = EMA.calculate({ period: 200, values: closes4h }).slice(-1)[0];
        const last4hClose = closes4h[closes4h.length - 1];
        bias = last4hClose > ema200_4h ? 'bull' : 'bear';
    } catch { bias = null; }

    if (bullishLayers >= 2) return { trend: "bull", bias };
    if (bearishLayers >= 2) return { trend: "bear", bias };
    return { trend: "invalid", reason: "1H layers not aligned", bias };

}

// ---------- HTF OB/FVG detection (unchanged) ----------
function detectOBFVG(candles, polarity = "bull") {
    if (candles.length < ATR_PERIOD + 2) return null;

    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const closes = candles.map(c => c.c);
    const opens = candles.map(c => c.o);
    const vols = candles.map(c => c.v);

    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const lastATR = atrArr.slice(-1)[0];
    const volAvg = vols.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-ATR_PERIOD).length);

    for (let i = candles.length - 2; i >= 1; i--) {
        const body = Math.abs(closes[i] - opens[i]);
        const isBullish = closes[i] > opens[i] && closes[i] > closes[i - 1];
        const isBearish = closes[i] < opens[i] && closes[i] < closes[i - 1];
        const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;

        if (body > lastATR * 0.9 && volStrong) {
            if (polarity === "bull" && isBullish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bull" };
            if (polarity === "bear" && isBearish) return { obLow: candles[i].l, obHigh: candles[i].h, originIndex: i, strength: body / lastATR, type: "bear" };
        }
    }
    return null;
}

// ---------- Liquidity sweep detector (unchanged for closed candles) ----------
function detectLiquiditySweep(candles, polarity = 'bull') {
    const recent = candles.slice(-12);
    for (let i = recent.length - 3; i >= 2; i--) {
        const c = recent[i], prev = recent[i - 1];
        if (polarity === 'bull') {
            const swept = c.l < prev.l && prev.l < recent[i - 2].l;
            const reclaimed = recent.slice(i + 1).some(x => x.c > c.o);
            if (swept && reclaimed) return true;
        } else {
            const swept = c.h > prev.h && prev.h > recent[i - 2].h;
            const reclaimed = recent.slice(i + 1).some(x => x.c < c.o);
            if (swept && reclaimed) return true;
        }
    }
    return false;
}

// ---------- LIVE sweep detection using livePrice vs previous closed candle ----------
function detectLiveSweepFromClosed(prevClosedCandle, polarity = 'bull', livePriceValue = null) {
    // instant detection: if livePrice pierced prev candle's high/low and then reclaimed within short period
    if (!prevClosedCandle || !livePriceValue) return false;
    const now = Date.now();
    const timeSinceLast = now - (liveSweepState.lastSweepAt || 0);
    // small debounce to avoid spam
    if (timeSinceLast < 10_000) return false;

    if (polarity === 'bull') {
        if (livePriceValue < prevClosedCandle.l * 0.999) {
            // touched below previous low -> possible bullish sweep (liquidity grab)
            liveSweepState.lastSweepAt = now;
            return true;
        }
    } else {
        if (livePriceValue > prevClosedCandle.h * 1.001) {
            liveSweepState.lastSweepAt = now;
            return true;
        }
    }
    return false;
}

// ---------- Retest validation (unchanged) ----------
function validateRetest(intraday, zone, polarity = "bull") {
    const lookback = 8;
    const c = intraday;
    for (let i = c.length - 1; i >= Math.max(0, c.length - lookback); i--) {
        const candle = c[i];
        const touched = candle.h >= zone.min && candle.l <= zone.max;
        if (!touched) continue;
        if (polarity === "bear") {
            const upperWick = candle.h - Math.max(candle.o, candle.c);
            const rejected = upperWick > 0.45 * (candle.h - candle.l) && candle.c < candle.o;
            if (rejected) return { index: i, candle };
        } else {
            const lowerWick = Math.min(candle.o, candle.c) - candle.l;
            const rejected = lowerWick > 0.45 * (candle.h - candle.l) && candle.c > candle.o;
            if (rejected) return { index: i, candle };
        }
    }
    return null;
}

// ---------- Buy/Sell zones (modified: freeze zone from previous closed 1H candle) ----------
function computeBuyZoneFromClosed(prevClosed1hArray) {
    // prevClosed1hArray should include at least the last N candles (closed)
    const ob = detectOBFVG(prevClosed1hArray, "bull");
    if (!ob) return null;
    const highs = prevClosed1hArray.map(c => c.h), lows = prevClosed1hArray.map(c => c.l), closes = prevClosed1hArray.map(c => c.c);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const atr = atrArr.slice(-1)[0];
    const zoneMin = ob.obLow - ZONE_ATR_PAD.min;
    const zoneMax = ob.obHigh + ZONE_ATR_PAD.max;
    const midpoint = (zoneMin + zoneMax) / 2;
    const sweep = detectLiquiditySweep(prevClosed1hArray, 'bull');
    const retest = validateRetest(prevClosed1hArray, { min: zoneMin, max: zoneMax }, 'bull');
    return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false, atr };
}

function computeSellZoneFromClosed(prevClosed1hArray) {
    const ob = detectOBFVG(prevClosed1hArray, "bear");
    if (!ob) return null;
    const highs = prevClosed1hArray.map(c => c.h), lows = prevClosed1hArray.map(c => c.l), closes = prevClosed1hArray.map(c => c.c);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const atr = atrArr.slice(-1)[0];
    const zoneMin = ob.obLow - ZONE_ATR_PAD.min;
    const zoneMax = ob.obHigh + ZONE_ATR_PAD.max;
    const midpoint = (zoneMin + zoneMax) / 2;
    const sweep = detectLiquiditySweep(prevClosed1hArray, 'bear');
    const retest = validateRetest(prevClosed1hArray, { min: zoneMin, max: zoneMax }, 'bear');
    return { min: zoneMin, max: zoneMax, midpoint, strength: ob.strength, sweep, retest: retest ? true : false, atr };
}

// ---------- ATR-adaptive SL/TP (unchanged, but accepts atr if available) ----------
function computeSLTP(zone, trend, intraday, overrideAtr = null) {
    if (!zone) return null;
    const highs = intraday.map(c => c.h), lows = intraday.map(c => c.l), closes = intraday.map(c => c.c);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const atr = overrideAtr || atrArr.slice(-1)[0];
    if (!atr) return null;

    const sl = trend === "bull" ? zone.min - 0.05 * atr : zone.max + 0.05 * atr;
    const tp1 = trend === "bull" ? zone.midpoint + 1 * atr : zone.midpoint - 1 * atr;
    const tp2 = trend === "bull" ? zone.midpoint + 2 * atr : zone.midpoint - 2 * atr;
    const tp3 = trend === "bull" ? zone.midpoint + 3 * atr : zone.midpoint - 3 * atr;
    const risk = trend === "bull" ? zone.midpoint - sl : sl - zone.midpoint;

    return { sl, tp1, tp2, tp3, risk };
}

// ---------- Chop detection (unchanged) ----------
function isChop(candles) {
    if (candles.length < 8) return false;
    const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
    const last8 = atrArr.slice(-8);
    if (last8.length < 8) return false;
    const atrAvg = last8.reduce((a, b) => a + b, 0) / 8;
    const bodySizes = candles.slice(-8).map(c => Math.abs(c.c - c.o));
    const avgBody = bodySizes.reduce((a, b) => a + b, 0) / 8;
    return avgBody < 0.45 * atrAvg;
}

// ---------- Sniper window (unchanged) ----------
function isInSniperWindow(ts = Date.now()) {
    if (!SNIPER_WINDOW_STRICT) return true;
    const hourUTC = new Date(ts).getUTCHours();
    return ENTRY_WINDOWS_UTC.includes(hourUTC);
}

// ---------- Telegram (unchanged) ----------
async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };
    for (let i = 1; i <= 3; i++) {
        try {
            const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            const data = await res.json();
            if (!data.ok) throw new Error(JSON.stringify(data));
            return data;
        } catch (err) {
            console.warn(`[telegram] attempt ${i} failed: ${err.message}`);
            if (i === 3) console.error("[telegram] all attempts failed.");
            else await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
}

function fmt(n) { return typeof n !== "number" ? String(n) : n >= 1000 ? Number(n).toFixed(2) : Number(n).toFixed(6); }

function buildZoneMessage({ symbol, trend, zone, sltp, label, note, liveHint }) {
    const nowUTC = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
    let msg = `*CTWL-Pro ETH Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n`;
    msg += `*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
    msg += `*Strength:* ${zone.strength ? zone.strength.toFixed(2) : "n/a"}\n`;
    if (zone.retest) msg += `Retest observed: yes\n`;
    if (zone.sweep) msg += `Liquidity sweep observed: yes\n`;
    if (note) msg += `*Note:* ${note}\n`;
    if (liveHint) msg += `*Live:* ${liveHint}\n`;
    if (sltp) msg += `\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
    if (label) msg += `\n_${label}_\n`;
    msg += `\n_Source: CTWL-Pro ETH (1H-dominant)_`;
    return msg;
}

// ---------- WEBSOCKET SHADOW CANDLE SETUP ----------
function buildWsUrl() {
    // combined streams: 1h kline, 4h kline, trade
    return `wss://stream.binance.com:9443/stream?streams=${PAIR_WS}@kline_1h/${PAIR_WS}@kline_4h/${PAIR_WS}@trade`;
}

function initWebsocket(onKlineUpdate, onTrade) {
    const url = buildWsUrl();
    const reconnectDelay = 2000;
    if (ws) {
        try { ws.terminate(); } catch (e) {}
        ws = null;
        wsConnected = false;
    }

    ws = new WebSocket(url);

    ws.on('open', () => {
        wsConnected = true;
        console.log(`[WS] connected to ${url}`);
    });

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            if (!parsed || !parsed.stream) return;
            const stream = parsed.stream;
            const payload = parsed.data;

            if (stream.endsWith('@kline_1h')) {
                const k = payload.k;
                // k = { t, T, s, i, f, L, o, c, h, l, v, n, x, q, V, Q, B }
                // x -> is this kline closed?
                const kObj = {
                    t: k.t,
                    o: Number(k.o),
                    h: Number(k.h),
                    l: Number(k.l),
                    c: Number(k.c),
                    v: Number(k.v),
                    x: k.x
                };
                onKlineUpdate('1h', kObj);
            } else if (stream.endsWith('@kline_4h')) {
                const k = payload.k;
                const kObj = {
                    t: k.t,
                    o: Number(k.o),
                    h: Number(k.h),
                    l: Number(k.l),
                    c: Number(k.c),
                    v: Number(k.v),
                    x: k.x
                };
                onKlineUpdate('4h', kObj);
            } else if (stream.endsWith('@trade')) {
                const p = Number(payload.p);
                const q = Number(payload.q);
                onTrade({ price: p, qty: q });
            }
        } catch (err) {
            console.warn("[WS] parse error:", err.message);
        }
    });

    ws.on('close', (code) => {
        wsConnected = false;
        console.warn(`[WS] closed ${code}. reconnecting in ${reconnectDelay}ms`);
        setTimeout(() => initWebsocket(onKlineUpdate, onTrade), reconnectDelay);
    });

    ws.on('error', (err) => {
        wsConnected = false;
        console.warn(`[WS] error: ${err.message}. reconnecting in ${reconnectDelay}ms`);
        try { ws.terminate(); } catch (e) {}
        setTimeout(() => initWebsocket(onKlineUpdate, onTrade), reconnectDelay);
    });
}

// ---------- LIVE HANDLERS ----------
function onKlineUpdateHandler(tf, k) {
    // If closed, record to lastClosedX and update shadow reset when 1h closed
    if (tf === '1h') {
        if (k.x) {
            // closed 1h candle - freeze
            lastClosed1h = { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
            // also reset live shadow after a small delay to avoid race
            shadowCandle = null;
        } else {
            // evolving 1H candle -> keep as shadow candle
            if (!shadowCandle) {
                shadowCandle = { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, start: Date.now() };
            } else {
                // update dynamic fields
                shadowCandle.h = Math.max(shadowCandle.h, k.h);
                shadowCandle.l = Math.min(shadowCandle.l, k.l);
                shadowCandle.c = k.c;
                shadowCandle.v = k.v;
            }
        }
    } else if (tf === '4h') {
        if (k.x) {
            lastClosed4h = { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
        }
    }
}

function onTradeHandler(trade) {
    livePrice = trade.price;
    liveTradeVolRecently = trade.qty;
}

// ---------- MAIN RUNNER (refactored to use live layer) ----------
export async function runethfast() {
    try {
        // 0. init websocket if not
        if (!wsConnected) initWebsocket(onKlineUpdateHandler, onTradeHandler);

        // 1. Verify sniper window
        if (!isInSniperWindow()) return console.log(`[${new Date().toISOString()}] Outside sniper window. Skipping...`);

        // 2. Fetch closed candle arrays (we keep closed logic identical to your base)
        // We use REST for history (closed candles) and WS for live detection
        const [intraday1hClosed, bias4hClosed] = await Promise.all([
            fetchCandles(SYMBOL, TIMEFRAMES.intraday, 500),
            fetchCandles(SYMBOL, TIMEFRAMES.bias, 500)
        ]);

        // Make sure we keep lastClosed1h / 4h from REST fallback if WS didn't set them yet
        if (!lastClosed1h) lastClosed1h = intraday1hClosed.slice(-2)[0]; // the previous closed candle (second last)
        if (!lastClosed4h) lastClosed4h = bias4hClosed.slice(-2)[0];

        // 3. Detect trend (closed-candle based, unchanged)
        const { trend, bias } = detectTrend(intraday1hClosed, bias4hClosed);
        if (trend === "invalid") return console.log(`[${new Date().toISOString()}] Trend invalid: Skipping.`);

        // 4. Compute frozen zone from previous closed 1H candle array
        // Use the entire closed intraday array (unchanged) but zone building functions now explicitly compute from closed data
        let zone = null;
        if (trend === "bull") zone = computeBuyZoneFromClosed(intraday1hClosed);
        if (trend === "bear") zone = computeSellZoneFromClosed(intraday1hClosed);
        if (!zone) return console.log(`[${new Date().toISOString()}] No valid zone found (closed-candle computation).`);

        // 5. Chop check (unchanged)
        if (isChop(intraday1hClosed)) return console.log(`[${new Date().toISOString()}] Market choppy. Skipping.`);

        // 6. Compute ATR-adaptive SL/TP (pass atr from zone if available)
        const sltp = computeSLTP(zone, trend, intraday1hClosed, zone.atr);
        if (!sltp) return console.log(`[${new Date().toISOString()}] SL/TP not computed. Skipping.`);

        // 7. LIVE DETECTION: immediate sweep detection vs previous closed candle
        let liveNote = null;
        let liveHint = null;
        const nowPrice = livePrice || intraday1hClosed.slice(-1)[0].c;
        // live sweep detection - instant
        const liveSweepDetected = detectLiveSweepFromClosed(intraday1hClosed.slice(-2)[0], trend === 'bull' ? 'bull' : 'bear', nowPrice);
        if (liveSweepDetected) {
            liveNote = "Live liquidity sweep detected";
            liveHint = `Price touched ${fmt(nowPrice)} (live).`;
        }

        // 8. Build "probable live zone" for sniper (fast hint) — derived from prev closed zone but including shadow expansion
        let liveProbableZone = { min: zone.min, max: zone.max, midpoint: zone.midpoint };
        if (shadowCandle) {
            // allow a small expansion when shadow wicks extend beyond closed zone, but do not mutate official zone
            liveProbableZone.min = Math.min(zone.min, shadowCandle.l);
            liveProbableZone.max = Math.max(zone.max, shadowCandle.h);
            liveProbableZone.midpoint = (liveProbableZone.min + liveProbableZone.max) / 2;
        }

        // 9. Build and send Telegram message — official zone is closed-based, liveHint indicates immediate changes
        const msg = buildZoneMessage({
            symbol: SYMBOL,
            trend,
            zone,
            sltp,
            label: bias ? `Bias: ${bias}` : null,
            note: liveNote,
            liveHint: liveHint ? `${liveHint} — Probable live zone: ${fmt(liveProbableZone.min)} - ${fmt(liveProbableZone.max)}` : `No live sweep. Probable live zone: ${fmt(liveProbableZone.min)} - ${fmt(liveProbableZone.max)}`
        });

        await sendTelegramMessage(msg);

        // 10. Logging
        console.log(`[${new Date().toISOString()}] Signal sent. Trend: ${trend}, Price (live): ${fmt(nowPrice)}, SL: ${fmt(sltp.sl)}, TP1: ${fmt(sltp.tp1)}, TP2: ${fmt(sltp.tp2)}, TP3: ${fmt(sltp.tp3)}`);

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error in runeth(): ${err.message}`);
    }
}

// ---------- Optional helper: graceful shutdown ----------
export function stopLiveLayer() {
    try {
        if (ws) ws.terminate();
        wsConnected = false;
        console.log("[WS] terminated by stopLiveLayer()");
    } catch (e) {
        console.warn("[WS] stop error:", e.message);
    }
}
