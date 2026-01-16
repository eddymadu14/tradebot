/******************************************************************
 * CTWL-XMR v2.1 – FULL LIVE ENGINE
 * Author: Brutal Mentor Mode
 * Purpose: Live Mean-Reversion Zone Engine for Monero (XMR)
 ******************************************************************/

import ccxt from "ccxt";
import fetch from "node-fetch";

// ========================= CONFIG =========================
const CONFIG = {
  ASSET: "XMR/USDT",
  TIMEFRAMES: { intraday: "1h", bias: "4h" },
  EMA_STACK: [20, 50, 100, 200],
  ATR_PERIOD: 14,
  ZONE_ATR_MULTIPLIER: 1.2,
  LIQ_WICK_BODY_RATIO: 1.5,
  VOLUME_LOOKBACK: 20,
  VOLUME_SPIKE_MULTIPLIER: 1.3,
  MIN_STRENGTH: 3.2,
  MAX_TRADES_PER_WEEK: 3,
  ADX_RANGE_MAX: 18,
  SESSIONS: { LONDON: [7, 10], NEW_YORK: [13, 16] },
  TELEGRAM: { BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, CHAT_ID: process.env.TELEGRAM_CHAT_ID }
};

// ========================= EXCHANGE =========================
const exchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: "future" } });

// ========================= HELPERS =========================
function mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function last(arr) { return arr[arr.length-1]; }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function fmt(n){return typeof n!=="number"?String(n):n>=1000?n.toFixed(2):n.toFixed(6);}

// ========================= SESSION FILTER =========================
function getSession(timestamp){
  const hour = new Date(timestamp).getUTCHours();
  for(const [name,[start,end]] of Object.entries(CONFIG.SESSIONS)){
    if(hour>=start && hour<=end) return name;
  }
  return "OFF";
}

// ========================= SAFE FETCH =========================
async function safeFetch(symbol, timeframe, limit=500){
  const maxRetries = 4, baseDelay = 1000;
  for(let i=1;i<=maxRetries;i++){
    try{
      const raw = await exchange.fetchOHLCV(symbol,timeframe,undefined,limit);
      return raw.map(r=>({timestamp:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]}));
    }catch(err){
      console.warn(`[safeFetch] Attempt ${i} failed: ${err.message}`);
      if(i===maxRetries) throw err;
      await sleep(baseDelay*i);
    }
  }
}

// ========================= INDICATORS =========================
function EMA(values, period){
  let k = 2/(period+1), emaArr=[values[0]];
  for(let i=1;i<values.length;i++){ emaArr.push(values[i]*k + emaArr[i-1]*(1-k)); }
  return emaArr;
}

function calculateATR(candles, period=CONFIG.ATR_PERIOD){
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
  }
  return mean(trs.slice(-period));
}

function bollingerWidth(candles, period=20){
  const closes = candles.slice(-period).map(c => c.close);
  const m = mean(closes);
  const variance = mean(closes.map(c=>Math.pow(c-m,2)));
  return (2*Math.sqrt(variance))/m;
}

function volumeSpikeRatio(candles){
  const vols = candles.slice(-CONFIG.VOLUME_LOOKBACK).map(c=>c.volume);
  return last(candles).volume / mean(vols);
}

// ========================= TREND + BIAS =========================
function detectTrend(candles1h, candles4h){
  const closes1h = candles1h.map(c=>c.close);
  if(closes1h.length<CONFIG.EMA_STACK[3]) return {trend:"invalid", reason:"Not enough 1H data"};

  const emaArrs={};
  CONFIG.EMA_STACK.forEach(p=>emaArrs[p]=EMA(closes1h,p));

  const lastClose=last(closes1h);
  const emaAbove = CONFIG.EMA_STACK.every(p=>lastClose>last(emaArrs[p]));
  const emaBelow = CONFIG.EMA_STACK.every(p=>lastClose<last(emaArrs[p]));

  const last5=closes1h.slice(-6);
  const hhhl=last5.every((c,i,arr)=>i===0?true:c>arr[i-1]);
  const lllh=last5.every((c,i,arr)=>i===0?true:c<arr[i-1]);

  const slope20=emaArrs[20].slice(-1)[0]-emaArrs[20].slice(-2)[0];
  const bullishMomentum = slope20>0;
  const bearishMomentum = slope20<0;

  const bullishLayers=[emaAbove, hhhl, bullishMomentum].filter(Boolean).length;
  const bearishLayers=[emaBelow, lllh, bearishMomentum].filter(Boolean).length;

  let bias=null;
  try{
    const closes4=candles4h.map(c=>c.close);
    const ema200_4h=EMA(closes4,200);
    bias=last(closes4)>last(ema200_4h)?"bull":"bear";
  }catch{bias=null;}

  if(bullishLayers>=2) return {trend:"bull", bias};
  if(bearishLayers>=2) return {trend:"bear", bias};
  return {trend:"invalid", reason:"1H layers not aligned", bias};
}

// ========================= REGIME DETECTION =========================
function detectRegime(candles){
  const atr = calculateATR(candles);
  const bbWidth = bollingerWidth(candles);
  if(atr<CONFIG.ADX_RANGE_MAX && bbWidth<0.02) return "RANGE";
  return "TREND";
}

// ========================= OB/FVG + ZONE =========================
function detectOBFVG(candles, polarity="bull"){
  if(candles.length<CONFIG.ATR_PERIOD+2) return null;
  const highs=candles.map(c=>c.high), lows=candles.map(c=>c.low), closes=candles.map(c=>c.close), opens=candles.map(c=>c.open), vols=candles.map(c=>c.volume);
  const atr=calculateATR(candles);
  const volAvg = mean(vols.slice(-CONFIG.ATR_PERIOD));

  for(let i=candles.length-2;i>=1;i--){
    const body=Math.abs(closes[i]-opens[i]);
    const isBullish=closes[i]>opens[i] && closes[i]>closes[i-1];
    const isBearish=closes[i]<opens[i] && closes[i]<closes[i-1];
    const volStrong=vols[i]>=volAvg*CONFIG.VOLUME_SPIKE_MULTIPLIER;
    if(body>atr*0.9 && volStrong){
      if(polarity==="bull" && isBullish) return {obLow:lows[i], obHigh:highs[i], originIndex:i, strength:body/atr, type:"bull"};
      if(polarity==="bear" && isBearish) return {obLow:lows[i], obHigh:highs[i], originIndex:i, strength:body/atr, type:"bear"};
    }
  }
  return null;
}

// ========================= LIQUIDITY SWEEP & RETEST =========================
function detectLiquiditySweep(candles, polarity="bull"){
  const recent=candles.slice(-12);
  for(let i=recent.length-3;i>=2;i--){
    const c=recent[i], prev=recent[i-1];
    if(polarity==="bull"){
      if(c.low<prev.low && prev.low<recent[i-2].low && recent.slice(i+1).some(x=>x.close>c.open)) return true;
    } else {
      if(c.high>prev.high && prev.high>recent[i-2].high && recent.slice(i+1).some(x=>x.close<c.open)) return true;
    }
  }
  return false;
}

function validateRetest(candles, zone, polarity="bull"){
  const lookback=8;
  for(let i=candles.length-1;i>=Math.max(0,candles.length-lookback);i--){
    const candle=candles[i];
    const touched=candle.high>=zone.min && candle.low<=zone.max;
    if(!touched) continue;
    if(polarity==="bear"){
      const upper=candle.high-Math.max(candle.open,candle.close);
      if(upper>0.45*(candle.high-candle.low) && candle.close<candle.open) return true;
    } else {
      const lower=Math.min(candle.open,candle.close)-candle.low;
      if(lower>0.45*(candle.high-candle.low) && candle.close>candle.open) return true;
    }
  }
  return false;
}

// ========================= ZONE INVALIDATION =========================
function isZoneInvalidated(candles, zone){
  const lastTwo=candles.slice(-2);
  const prevVol=candles[candles.length-3]?.volume ?? 0;
  return lastTwo.every(c=>c.close>zone.high && c.volume>prevVol);
}

// ========================= STRENGTH SCORING =========================
function computeStrength({regime, liquidity, htfBias, volumeRatio, zone}){
  let score=0;
  if(regime==="RANGE") score+=1.2;
  if(liquidity) score+=0.8;
  if(volumeRatio>1) score+=0.7;
  if(zone.thickness>0) score+=0.5;
  if(htfBias) score+=0.5;
  return Number(score.toFixed(2));
}

// ========================= SL/TP =========================
function computeSLTP(zone, trend, candles){
  const atr=calculateATR(candles);
  const sl=trend==="bull"? zone.min-0.05*atr : zone.max+0.05*atr;
  const tp1=trend==="bull"? zone.mid+1*atr : zone.mid-1*atr;
  const tp2=trend==="bull"? zone.mid+2*atr : zone.mid-2*atr;
  const tp3=trend==="bull"? zone.mid+3*atr : zone.mid-3*atr;
  return {sl,tp1,tp2,tp3,risk:Math.abs(zone.mid-sl)};
}

// ========================= MAIN ENGINE =========================
async function runCTWL_XMR(){
  try{
    const [intraday1h, bias4h] = await Promise.all([
      safeFetch(CONFIG.ASSET, CONFIG.TIMEFRAMES.intraday, 500),
      safeFetch(CONFIG.ASSET, CONFIG.TIMEFRAMES.bias, 500)
    ]);

    const {trend,bias}=detectTrend(intraday1h,bias4h);
    if(trend==="invalid") return console.log("NO_TRADE: Trend invalid");

    const regime = detectRegime(intraday1h);
    if(regime!=="RANGE") return console.log("NO_TRADE: Non-range regime");

    let zone=null;
    if(trend==="bull") zone=detectOBFVG(intraday1h,"bull");
    if(trend==="bear") zone=detectOBFVG(intraday1h,"bear");
    if(!zone) return console.log("NO_TRADE: No zone found");

    zone.thickness = zone.obHigh - zone.obLow;
    zone.mid = (zone.obHigh+zone.obLow)/2;

    const volRatio = volumeSpikeRatio(intraday1h);
    const liquidity = detectLiquiditySweep(intraday1h, trend);
    const retest = validateRetest(intraday1h, {min:zone.obLow,max:zone.obHigh}, trend);

    if(!liquidity || !retest) return console.log("NO_TRADE: Missing sweep/retest");
    if(isZoneInvalidated(intraday1h, zone)) return console.log("NO_TRADE: Zone invalidated");

    const strength = computeStrength({regime, liquidity, htfBias:bias, volumeRatio:volRatio, zone});
    if(strength<CONFIG.MIN_STRENGTH) return console.log("NO_TRADE: Strength too low");

    const sltp = computeSLTP(zone, trend, intraday1h);

    console.log({
      decision:"TRADE",
      asset:CONFIG.ASSET,
      trend,
      bias,
      regime,
      zone,
      sltp,
      sweep:liquidity,
      retest,
      strength
    });

  }catch(err){console.error("CTWL-XMR ERROR:",err.message);}
}

// ========================= RUN =========================
runCTWL_XMR();
