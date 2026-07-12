// services/blockchain.js — Envio de USDT TRC-20 e ERC-20
const logger = require('../config/logger');

// ─── TRC-20 (TRON) ────────────────────────────────────────────
async function sendUSDT_TRC20(toAddress, amountUSDT) {
  const TronWeb = require('tronweb');

  const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '' },
    privateKey: process.env.TRON_PRIVATE_KEY
  });

  const USDT_CONTRACT = process.env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const DECIMALS = 6;

  try {
    if (!tronWeb.isAddress(toAddress)) {
      throw new Error(`Endereço TRC-20 inválido: ${toAddress}`);
    }

    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const rawBal   = await contract.balanceOf(process.env.TRON_HOT_WALLET_ADDRESS).call();
    const balUSDT  = parseInt(rawBal.toString()) / 10 ** DECIMALS;

    if (balUSDT < amountUSDT) {
      throw new Error(`Saldo insuficiente TRC-20: ${balUSDT} USDT (necessário: ${amountUSDT})`);
    }

    const rawAmount = Math.floor(amountUSDT * 10 ** DECIMALS);
    logger.info('TRC-20: enviando USDT', { toAddress, amountUSDT });

    const tx = await contract.transfer(toAddress, rawAmount).send({
      feeLimit: 50_000_000,
      callValue: 0
    });

    logger.info('TRC-20: USDT enviado', { txHash: tx });
    return {
      txHash: tx,
      network: 'trc20',
      explorerUrl: `https://tronscan.org/#/transaction/${tx}`
    };
  } catch (err) {
    logger.error('TRC-20: erro', { error: err.message, toAddress });
    throw new Error(`Erro envio TRC-20: ${err.message}`);
  }
}

// ─── ERC-20 (ETHEREUM) ────────────────────────────────────────
async function sendUSDT_ERC20(toAddress, amountUSDT) {
  const { ethers } = require('ethers');

  const USDT_CONTRACT = process.env.USDT_ERC20_CONTRACT || '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const DECIMALS = 6;
  const ERC20_ABI = [
    'function transfer(address to, uint256 value) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)'
  ];

  try {
    const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
    const wallet   = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, wallet);

    if (!ethers.isAddress(toAddress)) {
      throw new Error(`Endereço ERC-20 inválido: ${toAddress}`);
    }

    const rawBal  = await contract.balanceOf(wallet.address);
    const balUSDT = Number(rawBal) / 10 ** DECIMALS;

    if (balUSDT < amountUSDT) {
      throw new Error(`Saldo insuficiente ERC-20: ${balUSDT} USDT`);
    }

    const ethBalance = await provider.getBalance(wallet.address);
    if (ethBalance < ethers.parseEther('0.005')) {
      throw new Error('Saldo ETH insuficiente para gas');
    }

    const rawAmount = BigInt(Math.floor(amountUSDT * 10 ** DECIMALS));
    logger.info('ERC-20: enviando USDT', { toAddress, amountUSDT });

    const gasEstimate = await contract.transfer.estimateGas(toAddress, rawAmount);
    const feeData     = await provider.getFeeData();

    const tx = await contract.transfer(toAddress, rawAmount, {
      gasLimit: gasEstimate * 120n / 100n,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
    });

    const receipt = await tx.wait(1);
    logger.info('ERC-20: USDT confirmado', { txHash: receipt.hash });

    return {
      txHash: receipt.hash,
      network: 'erc20',
      explorerUrl: `https://etherscan.io/tx/${receipt.hash}`
    };
  } catch (err) {
    logger.error('ERC-20: erro', { error: err.message, toAddress });
    throw new Error(`Erro envio ERC-20: ${err.message}`);
  }
}

// ─── DISPATCHER ───────────────────────────────────────────────
async function sendUSDT(toAddress, amountUSDT, network) {
  if (network === 'trc20') return sendUSDT_TRC20(toAddress, amountUSDT);
  if (network === 'erc20') return sendUSDT_ERC20(toAddress, amountUSDT);
  throw new Error(`Rede inválida: ${network}`);
}

// ─── VALIDAR ENDEREÇO ─────────────────────────────────────────
function validateAddress(address, network) {
  if (network === 'trc20') return /^T[A-Za-z0-9]{33}$/.test(address);
  if (network === 'erc20') {
    try {
      const { ethers } = require('ethers');
      return ethers.isAddress(address);
    } catch (e) {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }
  }
  return false;
}

module.exports = { sendUSDT, validateAddress };
