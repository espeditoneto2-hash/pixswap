// routes/api.js — Todas as rotas da API
const express = require('express');
const router = express.Router();

const txService = require('../services/transaction');
const binance = require('../services/binance');
const openpix = require('../services/openpix');
const blockchain = require('../services/blockchain');
const db = require('../db');
const logger = require('../config/logger');
const auth = require('../services/auth');
const { randomUUID } = require('crypto');

// ─── POST /api/auth/register ──────────────────────────────────
router.post('/auth/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ success: false, error: 'Informe seu nome' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'E-mail inválido' });
    if (!password || password.length < 6) return res.status(400).json({ success: false, error: 'Senha precisa de no mínimo 6 caracteres' });
    if (db.getUserByEmail(email)) return res.status(409).json({ success: false, error: 'Este e-mail já tem conta. Faça login.' });

    const user = db.createUser({
      id: randomUUID(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password_hash: auth.hashPassword(password)
    });

    const token = auth.signToken({ uid: user.id, email: user.email, name: user.name });
    logger.info('Novo usuário registrado', { email: user.email });
    res.status(201).json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    logger.error('Erro no registro', { error: err.message });
    res.status(500).json({ success: false, error: 'Erro ao criar conta' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = email && db.getUserByEmail(email);
    if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos' });
    }
    const token = auth.signToken({ uid: user.id, email: user.email, name: user.name });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erro ao entrar' });
  }
});

// ─── GET /api/me ──────────────────────────────────────────────
router.get('/me', auth.requireAuth, (req, res) => {
  const user = db.getUserById(req.user.uid);
  if (!user) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
  res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, created_at: user.created_at } });
});

// ─── GET /api/me/transactions ─────────────────────────────────
router.get('/me/transactions', auth.requireAuth, (req, res) => {
  const txs = db.getUserTransactions(req.user.uid);
  const totalBRL = txs.filter(t => t.status === 'completed').reduce((s, t) => s + (t.amount_brl || 0), 0);
  const totalUSDT = txs.filter(t => t.status === 'completed').reduce((s, t) => s + (t.amount_usdt || 0), 0);
  res.json({ success: true, transactions: txs, summary: { count: txs.length, totalBRL, totalUSDT } });
});

// ─── GET /api/rate ────────────────────────────────────────────
router.get('/rate', async (req, res) => {
  try {
    const rate = await binance.getRate();
    res.json({
      success: true,
      rate,
      feePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.0'),
      minBRL: parseFloat(process.env.MIN_BRL || '20'),
      maxBRL: parseFloat(process.env.MAX_BRL_NO_KYC || '10000'),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ success: false, error: 'Serviço de cotação indisponível' });
  }
});

// ─── POST /api/quote ──────────────────────────────────────────
router.post('/quote', async (req, res) => {
  try {
    const { amount, direction } = req.body;
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }
    if (!['pix2usdt', 'usdt2pix'].includes(direction)) {
      return res.status(400).json({ success: false, error: 'Direção inválida' });
    }
    const quote = await binance.calculateSwap(parseFloat(amount), direction);
    res.json({ success: true, ...quote });
  } catch (err) {
    logger.error('Erro /quote', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/swap/pix2usdt ─────────────────────────────────
router.post('/swap/pix2usdt', auth.optionalAuth, async (req, res) => {
  try {
    const { amountBRL, walletAddress, network } = req.body;

    if (!amountBRL || isNaN(amountBRL)) {
      return res.status(400).json({ success: false, error: 'amountBRL inválido' });
    }
    if (!walletAddress) {
      return res.status(400).json({ success: false, error: 'walletAddress obrigatório' });
    }
    if (!['trc20', 'erc20'].includes(network)) {
      return res.status(400).json({ success: false, error: "network deve ser 'trc20' ou 'erc20'" });
    }
    if (!blockchain.validateAddress(walletAddress, network)) {
      return res.status(400).json({ success: false, error: `Endereço ${network.toUpperCase()} inválido` });
    }

    const result = await txService.createPix2USDTTransaction({
      amountBRL: parseFloat(amountBRL),
      walletAddress, network,
      userId: req.user?.uid || null,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('Erro /swap/pix2usdt', { error: err.message });
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /api/swap/usdt2pix ─────────────────────────────────
router.post('/swap/usdt2pix', auth.optionalAuth, async (req, res) => {
  try {
    const { amountUSDT, pixKey, network } = req.body;

    if (!amountUSDT || isNaN(amountUSDT)) {
      return res.status(400).json({ success: false, error: 'amountUSDT inválido' });
    }
    if (!pixKey || pixKey.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'pixKey inválida' });
    }
    if (!['trc20', 'erc20'].includes(network)) {
      return res.status(400).json({ success: false, error: "network deve ser 'trc20' ou 'erc20'" });
    }

    const result = await txService.createUSDT2PIXTransaction({
      amountUSDT: parseFloat(amountUSDT),
      pixKey: pixKey.trim(),
      network,
      userId: req.user?.uid || null,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('Erro /swap/usdt2pix', { error: err.message });
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/transaction/:id ─────────────────────────────────
router.get('/transaction/:id', (req, res) => {
  try {
    const tx = txService.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ success: false, error: 'Transação não encontrada' });
    res.json({ success: true, transaction: tx });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/webhook/openpix ───────────────────────────────
router.post('/webhook/openpix', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const rawBody = req.body;

    if (!openpix.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Webhook com assinatura inválida');
      return res.status(401).json({ error: 'Assinatura inválida' });
    }

    const payload = JSON.parse(rawBody.toString());
    db.logWebhook('openpix', payload.event, payload, true);

    logger.info('Webhook OpenPix', { event: payload.event });

    if (payload.event === 'OPENPIX:CHARGE_COMPLETED') {
      const correlationID = payload.charge?.correlationID;
      if (correlationID) {
        setImmediate(async () => {
          try {
            await txService.processPix2USDTConfirmation(correlationID);
          } catch (err) {
            logger.error('Erro ao processar webhook', { correlationID, error: err.message });
          }
        });
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Erro webhook OpenPix', { error: err.message });
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── POST /api/webhook/crypto ─────────────────────────────────
router.post('/webhook/crypto', async (req, res) => {
  try {
    const { txId, txHash } = req.body;
    const secret = req.headers['x-internal-secret'];

    if (secret !== process.env.WEBHOOK_HMAC_SECRET) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
    if (!txId) return res.status(400).json({ error: 'txId obrigatório' });

    if (txHash) db.updateTransaction(txId, { tx_hash: txHash });

    await txService.processUSDT2PIXConfirmation(txId);
    res.json({ success: true });
  } catch (err) {
    logger.error('Erro webhook crypto', { error: err.message });
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── ADMIN ────────────────────────────────────────────────────
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== process.env.WEBHOOK_HMAC_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

router.get('/admin/stats', requireAdminKey, (req, res) => {
  try {
    res.json({ success: true, stats: db.getStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/balance', requireAdminKey, async (req, res) => {
  try {
    const balance = await binance.getBalance();
    res.json({ success: true, balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
