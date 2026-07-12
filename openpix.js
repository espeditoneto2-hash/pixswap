// services/openpix.js — Integração com OpenPix (gateway Pix)
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../config/logger');

const BASE_URL = process.env.OPENPIX_BASE_URL || 'https://api.openpix.com.br';

function api() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': process.env.OPENPIX_APP_ID,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
}

// ─── CRIAR COBRANÇA PIX ───────────────────────────────────────
async function createCharge({ correlationID, valueBRL, comment, expiresIn }) {
  try {
    const valueInCents = Math.round(valueBRL * 100);
    const expiresInSeconds = (expiresIn || parseInt(process.env.PIX_EXPIRY_MINUTES || '15')) * 60;

    const payload = {
      correlationID,
      value: valueInCents,
      comment: comment || 'PixSwap - Conversão Pix→USDT',
      expiresIn: expiresInSeconds
    };

    logger.info('OpenPix: criando cobrança', { correlationID, valueBRL });
    const { data } = await api().post('/api/v1/charge', payload);

    return {
      correlationID: data.charge.correlationID,
      status: data.charge.status,
      pixCode: data.charge.brCode,
      qrCodeImage: data.charge.qrCodeImage,
      expiresAt: data.charge.expiresAt,
      paymentLinkUrl: data.charge.paymentLinkUrl
    };
  } catch (err) {
    logger.error('OpenPix: erro ao criar cobrança', {
      error: err.response?.data || err.message, correlationID
    });
    throw new Error(`Erro OpenPix: ${err.response?.data?.error || err.message}`);
  }
}

// ─── CONSULTAR COBRANÇA ───────────────────────────────────────
async function getCharge(correlationID) {
  try {
    const { data } = await api().get(`/api/v1/charge/${correlationID}`);
    return {
      correlationID: data.charge.correlationID,
      status: data.charge.status,
      valueBRL: data.charge.value / 100,
      paidAt: data.charge.paidAt || null
    };
  } catch (err) {
    logger.error('OpenPix: erro ao consultar', { error: err.message, correlationID });
    throw new Error(`Erro ao consultar charge: ${err.message}`);
  }
}

// ─── TRANSFERÊNCIA PIX (USDT→PIX payout) ─────────────────────
async function createPixTransfer({ correlationID, valueBRL, pixKey, pixKeyType, description }) {
  try {
    const valueInCents = Math.round(valueBRL * 100);
    const payload = {
      value: valueInCents,
      destinationAlias: {
        pixAlias: { alias: pixKey, type: pixKeyType || detectPixKeyType(pixKey) }
      },
      correlationID,
      comment: description || 'PixSwap - Conversão USDT→PIX'
    };

    logger.info('OpenPix: criando transferência', { correlationID, valueBRL });
    const { data } = await api().post('/api/v1/transfer', payload);

    return {
      correlationID: data.transfer.correlationID,
      status: data.transfer.status,
      endToEndId: data.transfer.endToEndId
    };
  } catch (err) {
    logger.error('OpenPix: erro na transferência', { error: err.response?.data || err.message });
    throw new Error(`Erro transferência Pix: ${err.response?.data?.error || err.message}`);
  }
}

// ─── VERIFICAR HMAC DO WEBHOOK ────────────────────────────────
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.WEBHOOK_HMAC_SECRET;
  if (!secret) {
    logger.warn('WEBHOOK_HMAC_SECRET não configurado — pulando verificação');
    return true;
  }
  try {
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(computed, 'hex'),
      Buffer.from(signatureHeader || '', 'hex')
    );
  } catch (e) {
    return false;
  }
}

// ─── DETECTAR TIPO DE CHAVE PIX ───────────────────────────────
function detectPixKeyType(key) {
  const digits = key.replace(/\D/g, '');
  if (/^\d{11}$/.test(digits) && !key.includes('@')) return 'CPF';
  if (/^\d{14}$/.test(digits)) return 'CNPJ';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return 'EMAIL';
  if (/^\+?55?\d{10,11}$/.test(digits)) return 'PHONE';
  return 'RANDOM_KEY';
}

module.exports = {
  createCharge,
  getCharge,
  createPixTransfer,
  verifyWebhookSignature,
  detectPixKeyType
};
