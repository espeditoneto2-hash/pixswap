// server.js — Ponto de entrada do PixSwap
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const apiRoutes = require('./routes/api');
const logger = require('./config/logger');
const cron = require('./services/cron');

// ─── VERIFICAR CONFIGURAÇÃO ───────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';

const required = [
  'OPENPIX_APP_ID',
  'BINANCE_API_KEY', 'BINANCE_API_SECRET',
  'WEBHOOK_HMAC_SECRET'
];

const missing = required.filter(k => !process.env[k]);
if (missing.length > 0 && !isDev) {
  logger.error('❌ Variáveis faltando:', { missing });
  logger.error('Configure o arquivo .env. Veja .env.example');
  process.exit(1);
}
if (missing.length > 0 && isDev) {
  logger.warn('⚠️ Modo DEV: variáveis faltando (funcionalidade limitada):', { missing });
}

// ─── APP ──────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-internal-secret']
}));

// ─── RATE LIMITING ────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Muitas requisições. Aguarde 15 minutos.' }
}));

app.use('/api/swap', rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, error: 'Limite de 5 swaps por minuto.' }
}));

// ─── BODY PARSING ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/webhook/openpix') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// ─── ROTAS ────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// Servir frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', uptime: process.uptime() });
});

// ─── ERROS ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Rota não encontrada' });
});

app.use((err, req, res, next) => {
  logger.error('Erro não tratado', { error: err.message, path: req.path });
  res.status(500).json({ success: false, error: 'Erro interno' });
});

// ─── INICIAR ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 PixSwap rodando em http://localhost:${PORT}`);
  logger.info(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.BASE_URL) {
    logger.info(`📡 Webhook: ${process.env.BASE_URL}/api/webhook/openpix`);
  }
  cron.startAll();
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejeitada:', { reason: String(reason) });
});

module.exports = app;
