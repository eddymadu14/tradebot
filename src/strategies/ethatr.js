import ccxt from "ccxt";
import { EMA, ATR } from "technicalindicators";
import fetch from "node-fetch";
import dotenv from 'dotenv';
dotenv.config();

// =====================================================
// CTWL-Pro — ETH stand-alone sniper (1H-dominant, 4H bias)
// Fully integrated ATR-adaptive SL/TP with LTF bias
// =====================================================

// ----------------- CONFIG -----------------
const SYMBOL = "ETH/USDT";
const TIMEFRAMES = { daily: "1d", intraday: "1h", bias: "4h" };
const ATR_PERIOD = 14;
const EMA_STACK = [20, 50, 100, 200];
const IMPULSE_VOLUME_FACTOR = 1.2;
const ZONE_ATR_PAD = { min: 0.15, max: 0.15 };

const SNIPER_WINDOW_STRICT = false;
const ENTRY_WINDOWS_UTC = [0, 4, 8, 12, 16, 20];

// 🔴 EXECUTION THRESHOLD
const MIN_TELEGRAM_STRENGTH = 2.4;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET = process.env.BINANCE_SECRET;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("Warning: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID should be set in .env to receive alerts.");
}

// ----------------- EXCHANGE -----------------
const exchange = new ccxt.binance({
  apiKey: BINANCE_API_KEY || undefined,
  secret: BINANCE_SECRET || undefined,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: "future" },
});

// ----------------- SAFE FETCH -----------------
async function safeFetch(exchangeInstance, method, ...args) {
  const maxRetries = 4;
  const baseDelay = 1200;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await method.apply(exchangeInstance, args); }
    catch (err) {
      console.warn(`[safeFetch] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelay * attempt));
    }
  }
}

async function fetchCandles(symbol, timeframe, limit = 500) {
  const raw = await safeFetch(exchange, exchange.fetchOHLCV, symbol, timeframe, undefined, limit);
  return raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

// ----------------- TREND + BIAS -----------------
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
    bias = closes4h[closes4h.length - 1] > ema200_4h ? 'bull' : 'bear';
  } catch { bias = null; }

  if (bullishLayers >= 2) return { trend: "bull", bias };
  if (bearishLayers >= 2) return { trend: "bear", bias };
  return { trend: "invalid", reason: "1H layers not aligned", bias };
}

// ----------------- OB/FVG + ZONE -----------------
function detectOBFVG(candles, polarity = "bull") {
  if (candles.length < ATR_PERIOD + 2) return null;
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l), closes = candles.map(c => c.c), opens = candles.map(c => c.o), vols = candles.map(c => c.v);
  const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: ATR_PERIOD });
  const lastATR = atrArr.slice(-1)[0];
  const volAvg = vols.slice(-ATR_PERIOD).reduce((a,b)=>a+b,0)/Math.max(1,ATR_PERIOD);

  for (let i = candles.length-2;i>=1;i--){
    const body = Math.abs(closes[i]-opens[i]);
    const isBullish = closes[i]>opens[i] && closes[i]>closes[i-1];
    const isBearish = closes[i]<opens[i] && closes[i]<closes[i-1];
    const volStrong = vols[i] >= volAvg * IMPULSE_VOLUME_FACTOR;
    if (body > lastATR*0.9 && volStrong){
      if (polarity==="bull" && isBullish) return { obLow:lows[i], obHigh:highs[i], originIndex:i, strength:body/lastATR, type:"bull" };
      if (polarity==="bear" && isBearish) return { obLow:lows[i], obHigh:highs[i], originIndex:i, strength:body/lastATR, type:"bear" };
    }
  }
  return null;
}

// ----------------- Liquidity Sweep -----------------
function detectLiquiditySweep(candles, polarity='bull'){
  const recent = candles.slice(-12);
  for(let i=recent.length-3;i>=2;i--){
    const c=recent[i],prev=recent[i-1];
    if(polarity==='bull'){
      if(c.l<prev.l && prev.l<recent[i-2].l && recent.slice(i+1).some(x=>x.c>c.o)) return true;
    } else {
      if(c.h>prev.h && prev.h>recent[i-2].h && recent.slice(i+1).some(x=>x.c<c.o)) return true;
    }
  }
  return false;
}

// ----------------- Retest Validation -----------------
function validateRetest(intraday, zone, polarity="bull"){
  const lookback=8;
  for(let i=intraday.length-1;i>=Math.max(0,intraday.length-lookback);i--){
    const candle=intraday[i];
    const touched=candle.h>=zone.min && candle.l<=zone.max;
    if(!touched) continue;
    if(polarity==="bear"){
      const upper=candle.h-Math.max(candle.o,candle.c);
      if(upper>0.45*(candle.h-candle.l) && candle.c<candle.o) return {index:i,candle};
    } else {
      const lower=Math.min(candle.o,candle.c)-candle.l;
      if(lower>0.45*(candle.h-candle.l) && candle.c>candle.o) return {index:i,candle};
    }
  }
  return null;
}

// ----------------- Zone Compute -----------------
function computeBuyZone(intraday){
  const ob=detectOBFVG(intraday,"bull");
  if(!ob) return null;
  const highs=intraday.map(c=>c.h),lows=intraday.map(c=>c.l);
  const atr=ATR.calculate({high:highs,low:lows,close:intraday.map(c=>c.c),period:ATR_PERIOD}).slice(-1)[0];
  const zoneMin=ob.obLow-ZONE_ATR_PAD.min;
  const zoneMax=ob.obHigh+ZONE_ATR_PAD.max;
  const midpoint=(zoneMin+zoneMax)/2;
  const sweep=detectLiquiditySweep(intraday,'bull');
  const retest=validateRetest(intraday,{min:zoneMin,max:zoneMax},'bull');
  return {min:zoneMin,max:zoneMax,midpoint,strength:ob.strength,sweep,retest:!!retest};
}

function computeSellZone(intraday){
  const ob=detectOBFVG(intraday,"bear");
  if(!ob) return null;
  const highs=intraday.map(c=>c.h),lows=intraday.map(c=>c.l);
  const atr=ATR.calculate({high:highs,low:lows,close:intraday.map(c=>c.c),period:ATR_PERIOD}).slice(-1)[0];
  const zoneMin=ob.obLow-ZONE_ATR_PAD.min;
  const zoneMax=ob.obHigh+ZONE_ATR_PAD.max;
  const midpoint=(zoneMin+zoneMax)/2;
  const sweep=detectLiquiditySweep(intraday,'bear');
  const retest=validateRetest(intraday,{min:zoneMin,max:zoneMax},'bear');
  return {min:zoneMin,max:zoneMax,midpoint,strength:ob.strength,sweep,retest:!!retest};
}

// ----------------- ATR-adaptive SL/TP -----------------
function computeSLTP(zone, trend, intraday){
  if(!zone) return null;
  const highs=intraday.map(c=>c.h),lows=intraday.map(c=>c.l),closes=intraday.map(c=>c.c);
  const atr=ATR.calculate({high:highs,low:lows,close:closes,period:ATR_PERIOD}).slice(-1)[0];
  if(!atr) return null;
  const sl=trend==="bull"? zone.min-0.05*atr : zone.max+0.05*atr;
  const tp1=trend==="bull"? zone.midpoint+1*atr : zone.midpoint-1*atr;
  const tp2=trend==="bull"? zone.midpoint+2*atr : zone.midpoint-2*atr;
  const tp3=trend==="bull"? zone.midpoint+3*atr : zone.midpoint-3*atr;
  const risk=trend==="bull"? zone.midpoint-sl : sl-zone.midpoint;
  return {sl,tp1,tp2,tp3,risk};
}

// ----------------- Chop Detection -----------------
function isChop(candles){
  if(candles.length<8) return false;
  const highs=candles.map(c=>c.h),lows=candles.map(c=>c.l),closes=candles.map(c=>c.c);
  const atrAvg=ATR.calculate({high:highs,low:lows,close:closes,period:ATR_PERIOD}).slice(-8).reduce((a,b)=>a+b,0)/8;
  const avgBody=candles.slice(-8).map(c=>Math.abs(c.c-c.o)).reduce((a,b)=>a+b,0)/8;
  return avgBody<0.45*atrAvg;
}

// ----------------- Sniper Window -----------------
function isInSniperWindow(ts=Date.now()){
  if(!SNIPER_WINDOW_STRICT) return true;
  return ENTRY_WINDOWS_UTC.includes(new Date(ts).getUTCHours());
}

// ----------------- Telegram -----------------
async function sendTelegramMessage(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url=`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload={chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"};
  for(let i=1;i<=3;i++){
    try{
      const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const data=await res.json();
      if(!data.ok) throw new Error(JSON.stringify(data));
      return data;
    } catch(err){
      console.warn(`[telegram] attempt ${i} failed: ${err.message}`);
      if(i===3) console.error("[telegram] all attempts failed.");
      else await new Promise(r=>setTimeout(r,1000*i));
    }
  }
}

// ----------------- Formatter -----------------
function fmt(n){ return typeof n!=="number"?String(n):n>=1000?n.toFixed(2):n.toFixed(6); }

function buildZoneMessage({symbol,trend,zone,sltp,label,note}){
  const nowUTC=new Date().toISOString().replace("T"," ").replace("Z"," UTC");
  let msg=`*CTWL-Pro ETH Alert*\n\n*Symbol:* ${symbol}\n*Trend:* ${trend.toUpperCase()}\n*When:* ${nowUTC}\n\n`;
  msg+=`*Zone:* ${fmt(zone.min)} — ${fmt(zone.max)} (mid ${fmt(zone.midpoint)})\n`;
  msg+=`*Strength:* ${zone.strength?zone.strength.toFixed(2):"n/a"}\n`;
  if(zone.retest) msg+="Retest observed: yes\n";
  if(zone.sweep) msg+="Liquidity sweep observed: yes\n";
  if(note) msg+=`*Note:* ${note}\n`;
  if(sltp) msg+=`\n*SL:* ${fmt(sltp.sl)}\n*TP1:* ${fmt(sltp.tp1)}   *TP2:* ${fmt(sltp.tp2)}   *TP3:* ${fmt(sltp.tp3)}\n*Estimated risk:* ${fmt(sltp.risk)}\n`;
  if(label) msg+=`\n_${label}_\n`;
  msg+="\n_Source: CTWL-Pro ETH (1H-dominant, ATR-adaptive SL/TP)_";
  return msg;
}

// ----------------- MAIN RUNNER -----------------
export async function runethatr(){
  try{
    if(!isInSniperWindow()) return console.log(`[${new Date().toISOString()}] Outside sniper window. Skipping...`);

    const [intraday1h,bias4h]=await Promise.all([
      fetchCandles(SYMBOL,TIMEFRAMES.intraday,500),
      fetchCandles(SYMBOL,TIMEFRAMES.bias,500)
    ]);

    const {trend,bias}=detectTrend(intraday1h,bias4h);
    if(trend==="invalid") return console.log(`[${new Date().toISOString()}] Trend invalid: Skipping.`);

    let zone=null;
    if(trend==="bull") zone=computeBuyZone(intraday1h);
    if(trend==="bear") zone=computeSellZone(intraday1h);
    if(!zone|| zone.strength < MIN_TELEGRAM_STRENGTH) return console.log(`[${new Date().toISOString()}] No valid zone found. Skipped Telegram — strength=${zone.strength.toFixed(2)}`);

    if(isChop(intraday1h)) return console.log(`[${new Date().toISOString()}] Market choppy. Skipping.`);

    const sltp=computeSLTP(zone,trend,intraday1h);
    if(!sltp) return console.log(`[${new Date().toISOString()}] SL/TP not computed. Skipping.`);

    let note=null;
    if(zone.sweep) note="Liquidity sweep detected";
    if(zone.retest) note=note?note+" & retest observed":"Retest observed";

    const price=intraday1h.slice(-1)[0].c;

    const msg=buildZoneMessage({symbol:SYMBOL,trend,zone,sltp,label:bias?`Bias: ${bias}`:null,note});
    await sendTelegramMessage(msg);

    console.log(`[${new Date().toISOString()}] Signal sent. Trend: ${trend}, Bias: ${bias}, Price: ${fmt(price)}, SL: ${fmt(sltp.sl)}, TP1: ${fmt(sltp.tp1)}, TP2: ${fmt(sltp.tp2)}, TP3: ${fmt(sltp.tp3)}`);
  } catch(err){
    console.error(`[${new Date().toISOString()}] Error in runeth(): ${err.message}`);
  }
}
