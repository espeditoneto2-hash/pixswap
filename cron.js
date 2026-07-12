// services/cron.js — Jobs agendados
const cron = require('node-cron');
const db = require('../db');
const openpix = require('./openpix');
const logger = require('../config/logger');

// ─── EXPIRAR COBRANÇAS ────────────────────────────────────────
function startExpiredChecker() {
  cron.schedule('*/5 * * * *', async () => {
    const now = new Date().toISOString();
    const expired = db.findTransactions(t =>
      t.status === 'awaiting_payment' &&
      t.type === 'pix2usdt' &&
      t.pix_expiry && t.pix_expiry < now
    );

    for (const tx of expired) {
      try {
        const charge = await openpix.getCharge(tx.pix_correlation_id);
        if (charge.status === 'EXPIRED' || charge.status === 'ACTIVE') {
          db.updateTransaction(tx.id, { status: 'expired' });
          logger.info('Transação expirada', { txId: tx.id });
        }
      } catch (err) {
        logger.error('Erro ao verificar expiração', { txId: tx.id, error: err.message });
      }
    }
  });
  logger.info('⏰ Cron: verificador de expiração iniciado (5 min)');
}

// ─── MONITOR DE FALHAS ────────────────────────────────────────
function startFailedRetry() {
  cron.schedule('*/15 * * * *', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stuck = db.findTransactions(t =>
      ['pix_confirmed', 'exchange_ordered', 'sending_crypto'].includes(t.status) &&
      t.type === 'pix2usdt' &&
      t.updated_at < tenMinAgo
    );

    if (stuck.length > 0) {
      logger.warn(`⚠️ ${stuck.length} transações travadas`, { ids: stuck.map(t => t.id) });
    }
  });
  logger.info('🔄 Cron: monitor de falhas iniciado (15 min)');
}

// ─── MONITOR DE SALDO ─────────────────────────────────────────
function startBalanceMonitor() {
  cron.schedule('0 * * * *', async () => {
    try {
      const binance = require('./binance');
      const balance = await binance.getBalance();
      if (balance.USDT < 100) {
        logger.warn(`⚠️ SALDO BAIXO Binance: ${balance.USDT} USDT`);
      } else {
        logger.info('Saldo Binance OK', balance);
      }
    } catch (err) {
      logger.error('Erro monitor saldo', { error: err.message });
    }
  });
  logger.info('💰 Cron: monitor de saldo iniciado (1h)');
}

function startAll() {
  startExpiredChecker();
  startFailedRetry();
  startBalanceMonitor();
}

module.exports = { startAll };
