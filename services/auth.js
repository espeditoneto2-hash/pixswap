// services/auth.js — Autenticação (100% JS puro, sem dependências nativas)
const crypto = require('crypto');
const logger = require('../config/logger');

const JWT_SECRET = () => process.env.JWT_SECRET || process.env.WEBHOOK_HMAC_SECRET || 'dev-secret';

// ─── HASH DE SENHA (PBKDF2) ───────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// ─── JWT SIMPLES (HS256) ──────────────────────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString();
}

function signToken(payload, expiresInSec = 7 * 24 * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET()).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

function verifyToken(token) {
  try {
    const [h, p, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET()).update(`${h}.${p}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (sig !== expected) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Faça login para continuar' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ success: false, error: 'Sessão expirada. Entre novamente.' });
  req.user = payload;
  next();
}

// Auth opcional: identifica o usuário se houver token, mas não bloqueia
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth, optionalAuth };
