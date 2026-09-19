import { pubkeyFromSeed } from '../../../chain/crypto.js';

const REPO = 'bankchainai/BankchainAI-TheBlocksofthefuture';

export function ledgerToChainPayload(entry) {
  return {
    repo: REPO,
    ledgerId: entry.id,
    accountId: entry.accountId,
    amount: String(entry.amount),
    currency: entry.currency === 'BKCX' || entry.currency === 'BANK_TOKEN' ? 'BKCX' : entry.currency || 'BKC',
    note: entry.note || 'banking-service',
    status: entry.status,
  };
}

export async function submitLedgerToChain(rpcUrl, entry) {
  const payload = ledgerToChainPayload(entry);
  const from = entry.fromPubkey || pubkeyFromSeed(`bank:${entry.accountId}`);
  const to = entry.toPubkey || pubkeyFromSeed('BKC.treasury');
  const res = await fetch(new URL('/api/platform/submit', rpcUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      amount: payload.amount,
      currency: payload.currency,
      note: `ledger:${payload.ledgerId} ${payload.note}`,
    }),
  });
  const json = await res.json();
  return {
    blockchainHash: json.signature,
    validatorNodeId: json.slot,
    repo: REPO,
    ...json,
  };
}

export const GITHUB_REPO = REPO;
export const EXPLORER_CLUSTER = 'mainnet';
export const NATIVE = { symbol: 'BKC', name: 'Bank Coin', decimals: 9 };
export const BANK_TOKEN = { symbol: 'BKCX', name: 'Bank Tokens', decimals: 6 };
