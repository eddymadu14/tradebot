// engine/fetcher.js
import axios from "axios";
import { CONFIG } from "./config.js";

export async function getFuturesUSDT() {
  const { data } = await axios.get(`${CONFIG.BASE_URL}/fapi/v1/exchangeInfo`);
  return data.symbols
    .filter(s => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
    .map(s => s.symbol);
}

export async function getKlines(symbol) {
  const { data } = await axios.get(`${CONFIG.BASE_URL}/fapi/v1/klines`, {
    params: {
      symbol,
      interval: CONFIG.INTERVAL,
      limit: CONFIG.LOOKBACK
    }
  });
  return data;
}

export async function getOpenInterest(symbol) {
  const { data } = await axios.get(`${CONFIG.BASE_URL}/fapi/v1/openInterest`, {
    params: { symbol }
  });
  return parseFloat(data.openInterest);
}

export async function getFunding(symbol) {
  const { data } = await axios.get(`${CONFIG.BASE_URL}/fapi/v1/fundingRate`, {
    params: { symbol, limit: 1 }
  });
  return parseFloat(data[0]?.fundingRate || 0);
}
