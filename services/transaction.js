// services/transaction.js — Orquestrador principal
const { randomUUID } = require('crypto');
const db = require('../db');
const openpix = require('./openpix');
const binance = require('./binance');
const blockchain = require('./blockchain');
const logger = require('../config/logger');

// ─── PIX → USDT ───────────────────────────────────────────────
async function createPix2USDTTransaction({ amountBRL, walletAddress, network, userId, ip, userAgent }) {
  const minBRL = parseFloat(process.env.MIN_BRL || '20');
  const maxBRL = parseFloat(process.env.MAX_BRL_NO_KYC || '10000');

  if (amountBRL < minBRL) throw new Error(`Valor mínimo é R$ ${minBRL}`);
  if (amountBRL > maxBRL) throw new Error(`Valor máximo sem KYC é R$ ${maxBRL}`);
  if (!blockchain.validateAddress(walletAddress, network)) {
    throw new Error(`Endereço ${network.toUpperCase()} inválido`);
  }

  const swap = await binance.calculateSwap(amountBRL, 'pix2usdt');
  const id = randomUUID();
  const correlationID = `pixswap-${id}`;

  const charge = await openpix.createCharge({
    correlationID,
    valueBRL: amountBRL,
    comment: `PixSwap: ${amountBRL.toFixed(2)} BRL → ${swap.netUSDT.toFixed(4)} USDT`
  });

  db.insertTransaction({
    id, type: 'pix2usdt', status: 'awaiting_payment', user_id: userId || null,
    amount_brl: amountBRL,
    amount_usdt: swap.netUSDT,
    fee_brl: swap.feeBRL,
    fee_usdt: swap.feeUSDT,
    exchange_rate: swap.rate,
    pix_correlation_id: charge.correlationID,
    pix_code: charge.pixCode,
    pix_qr_image: charge.qrCodeImage,
    pix_expiry: charge.expiresAt,
    network, wallet_address: walletAddress,
    ip_address: ip, user_agent: userAgent
  });

  logger.info('Transação criada', { id, amountBRL, network });

  return {
    txId: id,
    status: 'awaiting_payment',
    pixCode: charge.pixCode,
    qrCodeImage: charge.qrCodeImage,
    expiresAt: charge.expiresAt,
    amountBRL,
    estimatedUSDT: swap.netUSDT,
    fee: swap.feeBRL,
    rate: swap.rate,
    network, walletAddress
  };
}

// ─── USDT → PIX ───────────────────────────────────────────────
async function createUSDT2PIXTransaction({ amountUSDT, pixKey, network, userId, ip, userAgent }) {
  const rate = await binance.getRate();
  const amountBRL = amountUSDT * rate;
  const minBRL = parseFloat(process.env.MIN_BRL || '20');

  if (amountBRL < minBRL) throw new Error(`Valor mínimo é R$ ${minBRL}`);

  const swap = await binance.calculateSwap(amountUSDT, 'usdt2pix');
  const id = randomUUID();
  const depositAddress = getDepositAddress(network);

  db.insertTransaction({
    id, type: 'usdt2pix', status: 'awaiting_payment', user_id: userId || null,
    amount_brl: swap.netBRL,
    amount_usdt: amountUSDT,
    fee_brl: swap.feeBRL,
    exchange_rate: swap.rate,
    pix_key: pixKey,
    network, wallet_address: depositAddress,
    ip_address: ip, user_agent: userAgent
  });

  logger.info('Transação USDT→PIX criada', { id, amountUSDT, pixKey });

  return {
    txId: id,
    status: 'awaiting_payment',
    depositAddress, network,
    amountUSDT,
    estimatedBRL: swap.netBRL,
    fee: swap.feeBRL,
    rate: swap.rate,
    pixKey,
    expiresInMinutes: 30
  };
}

// ─── PROCESSAR PIX CONFIRMADO ────────────────────────────────
async function processPix2USDTConfirmation(correlationID) {
  const tx = db.getTransactionByPixId(correlationID);
  if (!tx) throw new Error(`Transação não encontrada: ${correlationID}`);
  if (tx.status !== 'awaiting_payment') {
    logger.warn('Transação já processada', { correlationID, status: tx.status });
    return;
  }

  db.updateTransaction(tx.id, { status: 'pix_confirmed', pix_paid_at: new Date().toISOString() });
  logger.info('Pix confirmado, comprando USDT', { txId: tx.id, amountBRL: tx.amount_brl });

  try {
    // 1. Comprar USDT na Binance
    db.updateTransaction(tx.id, { status: 'exchange_ordered' });
    const order = await binance.placeBuyOrder(tx.amount_brl);
    db.updateTransaction(tx.id, { binance_order_id: order.orderId, amount_usdt: order.filledUSDT });

    // 2. Calcular valor líquido
    const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.0') / 100;
    const netUSDT = order.filledUSDT * (1 - feePercent);

    // 3. Enviar USDT
    db.updateTransaction(tx.id, { status: 'sending_crypto' });
    const sent = await blockchain.sendUSDT(tx.wallet_address, netUSDT, tx.network);

    // 4. Concluir
    db.updateTransaction(tx.id, {
      status: 'completed',
      tx_hash: sent.txHash,
      crypto_sent_at: new Date().toISOString()
    });

    logger.info('✅ Transação concluída', { txId: tx.id, txHash: sent.txHash, netUSDT });
    return { txId: tx.id, txHash: sent.txHash, netUSDT, explorerUrl: sent.explorerUrl };

  } catch (err) {
    db.updateTransaction(tx.id, { status: 'failed' });
    logger.error('❌ Erro pós-Pix', { txId: tx.id, error: err.message });
    throw err;
  }
}

// ─── PROCESSAR USDT RECEBIDO ─────────────────────────────────
async function processUSDT2PIXConfirmation(txId) {
  const tx = db.getTransaction(txId);
  if (!tx) throw new Error(`Transação não encontrada: ${txId}`);
  if (tx.type !== 'usdt2pix') throw new Error('Tipo inválido');
  if (tx.status !== 'awaiting_payment') {
    logger.warn('Transação já processada', { txId });
    return;
  }

  db.updateTransaction(txId, { status: 'pix_confirmed' });

  try {
    // 1. Vender USDT
    const order = await binance.placeSellOrder(tx.amount_usdt);
    db.updateTransaction(txId, { binance_order_id: order.orderId });

    // 2. Enviar Pix
    const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.0') / 100;
    const netBRL = order.filledBRL * (1 - feePercent);

    logger.info('Enviando Pix ao cliente', { txId, netBRL, pixKey: tx.pix_key });

    await openpix.createPixTransfer({
      correlationID: `payout-${txId}`,
      valueBRL: netBRL,
      pixKey: tx.pix_key,
      description: `PixSwap payout ${txId}`
    });

    db.updateTransaction(txId, {
      status: 'completed',
      amount_brl: netBRL,
      pix_paid_at: new Date().toISOString()
    });

    logger.info('✅ USDT→PIX concluído', { txId, netBRL });
    return { txId, netBRL, pixKey: tx.pix_key };

  } catch (err) {
    db.updateTransaction(txId, { status: 'failed' });
    logger.error('❌ Erro USDT→PIX', { txId, error: err.message });
    throw err;
  }
}

// ─── CONSULTAR TRANSAÇÃO ──────────────────────────────────────
function getTransaction(txId) {
  const tx = db.getTransaction(txId);
  if (!tx) return null;
  const { pix_qr_image, ip_address, user_agent, ...safe } = tx;
  return safe;
}

// ─── ENDEREÇO DE DEPÓSITO ─────────────────────────────────────
function getDepositAddress(network) {
  if (network === 'trc20') return process.env.TRON_HOT_WALLET_ADDRESS;
  if (network === 'erc20') return process.env.ETH_HOT_WALLET_ADDRESS;
  throw new Error(`Rede inválida: ${network}`);
}

module.exports = {
  createPix2USDTTransaction,
  createUSDT2PIXTransaction,
  processPix2USDTConfirmation,
  processUSDT2PIXConfirmation,
  getTransaction
};
