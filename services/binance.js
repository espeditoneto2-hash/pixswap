// services/binance.js — Integração com Binance API
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../config/logger');

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const SYMBOL   = 'USDTBRL';

function sign(queryString) {
  return crypto
    .createHmac('sha256', process.env.BINANCE_API_SECRET)
    .update(queryString)
    .digest('hex');
}

function publicApi() {
  return axios.create({ baseURL: BASE_URL, timeout: 10000 });
}

function privateApi() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
  });
}

// ─── COTAÇÃO ATUAL ────────────────────────────────────────────
async function getRate() {
  try {
    const { data } = await publicApi().get('/api/v3/ticker/price', {
      params: { symbol: SYMBOL }
    });
    return parseFloat(data.price);
  } catch (err) {
    logger.error('Binance: erro na cotação', { error: err.message });
    throw new Error('Não foi possível obter cotação USDT/BRL');
  }
}

// ─── CALCULAR SWAP ────────────────────────────────────────────
async function calculateSwap(amount, direction) {
  const rate = await getRate();
  const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.0') / 100;

  if (direction === 'pix2usdt') {
    const grossUSDT = amount / rate;
    const feeUSDT   = grossUSDT * feePercent;
    return {
      direction, amountBRL: amount,
      grossUSDT: +grossUSDT.toFixed(6),
      feeUSDT:   +feeUSDT.toFixed(6),
      netUSDT:   +(grossUSDT - feeUSDT).toFixed(6),
      feeBRL:    +(amount * feePercent).toFixed(2),
      rate, feePercent: feePercent * 100
    };
  } else {
    const grossBRL = amount * rate;
    const feeBRL   = grossBRL * feePercent;
    return {
      direction, amountUSDT: amount,
      grossBRL: +grossBRL.toFixed(2),
      feeBRL:   +feeBRL.toFixed(2),
      netBRL:   +(grossBRL - feeBRL).toFixed(2),
      rate, feePercent: feePercent * 100
    };
  }
}

// ─── ORDEM DE COMPRA (BRL → USDT) ────────────────────────────
async function placeBuyOrder(amountBRL) {
  try {
    const qs = `symbol=${SYMBOL}&side=BUY&type=MARKET&quoteOrderQty=${amountBRL.toFixed(2)}&timestamp=${Date.now()}`;
    const signature = sign(qs);

    logger.info('Binance: ordem de compra', { amountBRL });
    const { data } = await privateApi().post(`/api/v3/order?${qs}&signature=${signature}`);

    const filledQty = parseFloat(data.executedQty);
    const filledBRL = parseFloat(data.cummulativeQuoteQty);

    logger.info('Binance: compra executada', { orderId: data.orderId, filledQty, filledBRL });

    return {
      orderId: data.orderId.toString(),
      filledUSDT: filledQty,
      filledBRL,
      avgPrice: filledBRL / filledQty,
      status: data.status
    };
  } catch (err) {
    logger.error('Binance: erro na compra', { error: err.response?.data || err.message });
    throw new Error(`Erro ordem Binance: ${err.response?.data?.msg || err.message}`);
  }
}

// ─── ORDEM DE VENDA (USDT → BRL) ─────────────────────────────
async function placeSellOrder(amountUSDT) {
  try {
    const qs = `symbol=${SYMBOL}&side=SELL&type=MARKET&quantity=${amountUSDT.toFixed(2)}&timestamp=${Date.now()}`;
    const signature = sign(qs);

    logger.info('Binance: ordem de venda', { amountUSDT });
    const { data } = await privateApi().post(`/api/v3/order?${qs}&signature=${signature}`);

    return {
      orderId: data.orderId.toString(),
      filledUSDT: parseFloat(data.executedQty),
      filledBRL: parseFloat(data.cummulativeQuoteQty),
      status: data.status
    };
  } catch (err) {
    logger.error('Binance: erro na venda', { error: err.response?.data || err.message });
    throw new Error(`Erro venda Binance: ${err.response?.data?.msg || err.message}`);
  }
}

// ─── SALDO ────────────────────────────────────────────────────
async function getBalance() {
  try {
    const qs = `timestamp=${Date.now()}`;
    const signature = sign(qs);
    const { data } = await privateApi().get(`/api/v3/account?${qs}&signature=${signature}`);

    const usdt = data.balances.find(b => b.asset === 'USDT');
    const brl  = data.balances.find(b => b.asset === 'BRL');

    return {
      USDT: parseFloat(usdt?.free || 0),
      BRL:  parseFloat(brl?.free  || 0)
    };
  } catch (err) {
    logger.error('Binance: erro no saldo', { error: err.message });
    throw new Error('Erro ao consultar saldo Binance');
  }
}

module.exports = { getRate, calculateSwap, placeBuyOrder, placeSellOrder, getBalance };
