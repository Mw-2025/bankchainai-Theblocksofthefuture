import { pubkeyFromSeed, LAMPORTS_PER_BKC } from './crypto.js';

export const CLUSTER = {
  name: 'Block of the Future',
  cluster: 'mainnet',
  genesisHash: pubkeyFromSeed('BKC.genesis.v1'),
  nativeSymbol: 'BKC',
  nativeName: 'Bank Coin',
  tokenSymbol: 'BKCX',
  tokenName: 'Bank Tokens',
  slotMs: 400,
  slotsPerEpoch: 4320,
  ticksPerSlot: 64,
  feeLamports: 5000,
};

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: pubkeyFromSeed('BKC.BankTokenProgram'),
  stake: pubkeyFromSeed('BKC.StakeProgram'),
  vote: pubkeyFromSeed('BKC.VoteProgram'),
  memo: pubkeyFromSeed('BKC.MemoProgram'),
  computeBudget: pubkeyFromSeed('BKC.ComputeBudget'),
  config: pubkeyFromSeed('BKC.ConfigProgram'),
};

export const MINTS = {
  bkcx: pubkeyFromSeed('BKC.BKCX.mint'),
};

const bkc = (n) => BigInt(Math.round(n * Number(LAMPORTS_PER_BKC)));
const bkcx = (n) => BigInt(Math.round(n * 1_000_000));

export const ACCOUNTS = {
  treasury: { seed: 'BKC.treasury', label: 'BKF Treasury', lamports: bkc(300_000_000) },
  reserves: { seed: 'BKC.reserves', label: 'BKF Reserves (non-circulating)', lamports: bkc(250_000_000) },
  foundation: { seed: 'BKC.foundation', label: 'BKF Foundation', lamports: bkc(100_000_000) },
  liquidity: { seed: 'BKC.liquidity', label: 'BKC Liquidity Pool', lamports: bkc(80_000_000) },
  rewards: { seed: 'BKC.rewards', label: 'Epoch Rewards Vault', lamports: bkc(50_000_000) },
};

export const VALIDATORS = [
  { seed: 'val.foundation', name: 'BKF Foundation', commission: 0, stakeBkc: 40_000_000 },
  { seed: 'val.alpha', name: 'Bank Node Alpha', commission: 5, stakeBkc: 28_000_000 },
  { seed: 'val.reserve', name: 'Reserve Validator', commission: 7, stakeBkc: 24_000_000 },
  { seed: 'val.labs', name: 'BKC Labs', commission: 8, stakeBkc: 22_000_000 },
  { seed: 'val.future', name: 'Future Stake', commission: 6, stakeBkc: 20_000_000 },
  { seed: 'val.ledger', name: 'Ledger One', commission: 9, stakeBkc: 16_000_000 },
  { seed: 'val.coinhouse', name: 'Coinhouse', commission: 10, stakeBkc: 16_000_000 },
  { seed: 'val.vault', name: 'Vault Prime', commission: 8, stakeBkc: 14_000_000 },
];

export const CUSTOMERS = Array.from({ length: 24 }, (_, i) => ({
  seed: `customer.${String(i + 1).padStart(2, '0')}`,
  label: `Bank Customer ${String(i + 1).padStart(2, '0')}`,
  lamports: bkc(1_200_000 + i * 80_000),
  bkcx: bkcx(2_500_000 + i * 125_000),
}));

export const TOKEN_HOLDERS_EXTRA = [
  { key: 'liquidity', amount: bkcx(3_500_000_000) },
  { key: 'treasury', amount: bkcx(4_000_000_000) },
  { key: 'rewards', amount: bkcx(500_000_000) },
];

export function materializeKeys() {
  const accounts = {};
  for (const [key, meta] of Object.entries(ACCOUNTS)) {
    accounts[key] = { ...meta, pubkey: pubkeyFromSeed(meta.seed) };
  }
  const customers = CUSTOMERS.map((c) => ({ ...c, pubkey: pubkeyFromSeed(c.seed) }));
  const validators = VALIDATORS.map((v) => {
    const identity = pubkeyFromSeed(v.seed);
    return {
      ...v,
      identity,
      vote: pubkeyFromSeed(`vote:${v.seed}`),
      stakeAccount: pubkeyFromSeed(`stake:${v.seed}`),
      lamports: bkc(v.stakeBkc),
    };
  });
  return { accounts, customers, validators };
}

export const LABELS = (() => {
  const map = {
    [PROGRAMS.system]: 'System Program',
    [PROGRAMS.token]: 'Bank Token Program',
    [PROGRAMS.stake]: 'Stake Program',
    [PROGRAMS.vote]: 'Vote Program',
    [PROGRAMS.memo]: 'Memo Program',
    [PROGRAMS.computeBudget]: 'Compute Budget',
    [PROGRAMS.config]: 'Config Program',
    [MINTS.bkcx]: 'BKCX (Bank Tokens)',
  };
  const keys = materializeKeys();
  for (const a of Object.values(keys.accounts)) map[a.pubkey] = a.label;
  for (const c of keys.customers) map[c.pubkey] = c.label;
  for (const v of keys.validators) {
    map[v.identity] = v.name;
    map[v.vote] = `${v.name} (vote)`;
    map[v.stakeAccount] = `${v.name} (stake)`;
  }
  return map;
})();
