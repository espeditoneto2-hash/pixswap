// db/index.js — Banco de dados JSON puro (sem compilação, funciona em qualquer Windows)
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'pixswap-data.json');

// ─── ESTRUTURA INICIAL ────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (!d.users) d.users = [];
      return d;
    }
  } catch (e) {
    console.error('Erro ao ler banco, criando novo:', e.message);
  }
  return { transactions: [], webhook_logs: [], users: [], config: {
    platform_fee_percent: '1.0',
    min_brl: '20',
    max_brl_no_kyc: '10000',
    maintenance_mode: 'false'
  }};
}

function saveData(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── TRANSAÇÕES ───────────────────────────────────────────────
function insertTransaction(tx) {
  const data = loadData();
  tx.created_at = new Date().toISOString();
  tx.updated_at = new Date().toISOString();
  data.transactions.push(tx);
  saveData(data);
  return tx;
}

function updateTransaction(id, fields) {
  const data = loadData();
  const tx = data.transactions.find(t => t.id === id);
  if (!tx) return null;
  Object.assign(tx, fields, { updated_at: new Date().toISOString() });
  saveData(data);
  return tx;
}

function getTransaction(id) {
  const data = loadData();
  return data.transactions.find(t => t.id === id) || null;
}

function getTransactionByPixId(correlationID) {
  const data = loadData();
  return data.transactions.find(t => t.pix_correlation_id === correlationID) || null;
}

function findTransactions(filterFn) {
  const data = loadData();
  return data.transactions.filter(filterFn);
}

function getStats() {
  const data = loadData();
  const txs = data.transactions;
  const completed = txs.filter(t => t.status === 'completed');
  return {
    total: txs.length,
    completed: completed.length,
    pending: txs.filter(t => ['awaiting_payment','pix_confirmed','exchange_ordered','sending_crypto'].includes(t.status)).length,
    failed: txs.filter(t => t.status === 'failed').length,
    volumeBRL: completed.reduce((s, t) => s + (t.amount_brl || 0), 0),
    volumeUSDT: completed.reduce((s, t) => s + (t.amount_usdt || 0), 0),
    recent: txs.slice(-20).reverse().map(t => ({
      id: t.id, type: t.type, status: t.status,
      amount_brl: t.amount_brl, amount_usdt: t.amount_usdt,
      created_at: t.created_at
    }))
  };
}

// ─── WEBHOOK LOGS ─────────────────────────────────────────────
function logWebhook(source, event, payload, verified) {
  const data = loadData();
  data.webhook_logs.push({
    id: data.webhook_logs.length + 1,
    source, event,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    verified: verified ? 1 : 0,
    processed: 0,
    created_at: new Date().toISOString()
  });
  // Manter apenas os últimos 500 logs
  if (data.webhook_logs.length > 500) {
    data.webhook_logs = data.webhook_logs.slice(-500);
  }
  saveData(data);
}

// ─── USUÁRIOS ─────────────────────────────────────────────────
function createUser(user) {
  const data = loadData();
  user.created_at = new Date().toISOString();
  data.users.push(user);
  saveData(data);
  return user;
}

function getUserByEmail(email) {
  const data = loadData();
  return data.users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
}

function getUserById(id) {
  const data = loadData();
  return data.users.find(u => u.id === id) || null;
}

function getUserTransactions(userId, limit = 50) {
  const data = loadData();
  return data.transactions
    .filter(t => t.user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit)
    .map(t => {
      const { pix_qr_image, ip_address, user_agent, ...safe } = t;
      return safe;
    });
}

module.exports = {
  insertTransaction,
  updateTransaction,
  getTransaction,
  getTransactionByPixId,
  findTransactions,
  getStats,
  logWebhook,
  createUser,
  getUserByEmail,
  getUserById,
  getUserTransactions
};
