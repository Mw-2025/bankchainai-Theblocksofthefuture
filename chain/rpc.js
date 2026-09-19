import { CLUSTER, PROGRAMS, MINTS, LABELS } from './genesis.js';

export function handleRpc(chain, method, params = []) {
  switch (method) {
    case 'getHealth':
      return 'ok';
    case 'getVersion':
      return { 'bkc-core': '1.0.0', 'feature-set': 1, solanaCompatible: true };
    case 'getGenesisHash':
      return chain.stats().genesisHash;
    case 'getSlot':
      return chain.stats().slot;
    case 'getBlockHeight':
      return chain.stats().blockHeight;
    case 'getEpochInfo': {
      const s = chain.stats();
      return {
        epoch: s.epoch,
        slotIndex: s.epochSlotIndex,
        slotsInEpoch: s.slotsInEpoch,
        absoluteSlot: s.slot,
        blockHeight: s.blockHeight,
        transactionCount: s.transactionCount,
      };
    }
    case 'getLatestBlockhash': {
      const [b] = chain.recentBlocks(1);
      return {
        context: { slot: chain.stats().slot },
        value: { blockhash: b?.blockhash, lastValidBlockHeight: chain.stats().slot + 150 },
      };
    }
    case 'getBlock': {
      const slot = params[0];
      const block = chain.getBlock(slot);
      if (!block) return null;
      return {
        blockhash: block.blockhash,
        previousBlockhash: block.previous_blockhash,
        parentSlot: block.parent_slot,
        blockTime: block.block_time,
        blockHeight: block.slot,
        rewards: [{ pubkey: block.leader, lamports: Number(block.rewards), rewardType: 'Leader' }],
        transactions: (block.transactions || []).map((tx) => ({
          transaction: { signatures: [tx.signature], message: { accountKeys: tx.account_keys, instructions: tx.instructions } },
          meta: { err: tx.err ? { InstructionError: tx.err } : null, fee: tx.fee, logMessages: tx.logs, status: tx.status === 'success' ? { Ok: null } : { Err: tx.err } },
        })),
      };
    }
    case 'getTransaction': {
      const tx = chain.getTx(params[0]);
      if (!tx) return null;
      return {
        slot: tx.slot,
        blockTime: tx.block_time,
        transaction: { signatures: [tx.signature], message: { accountKeys: tx.account_keys, instructions: tx.instructions } },
        meta: { err: tx.err, fee: tx.fee, logMessages: tx.logs, status: tx.status === 'success' ? { Ok: null } : { Err: tx.err } },
      };
    }
    case 'getAccountInfo': {
      const acc = chain.getAccount(params[0]);
      if (!acc) return { context: { slot: chain.stats().slot }, value: null };
      return {
        context: { slot: chain.stats().slot },
        value: {
          lamports: Number(acc.lamports),
          owner: acc.owner,
          executable: !!acc.executable,
          rentEpoch: acc.rent_epoch,
          data: acc.data,
        },
      };
    }
    case 'getBalance': {
      const acc = chain.getAccount(params[0]);
      return { context: { slot: chain.stats().slot }, value: acc ? Number(acc.lamports) : 0 };
    }
    case 'getSupply': {
      const s = chain.supply();
      return { context: { slot: chain.stats().slot }, value: { total: Number(s.total), circulating: Number(s.circulating), nonCirculating: Number(s.nonCirculating), nonCirculatingAccounts: [] } };
    }
    case 'getVoteAccounts': {
      const current = chain.validators().map((v) => ({
        votePubkey: v.vote,
        nodePubkey: v.identity,
        activatedStake: Number(v.activated_stake),
        commission: v.commission,
        epochVoteAccount: true,
        lastVote: v.last_vote,
      }));
      return { current, delinquent: [] };
    }
    case 'getTokenSupply': {
      const mint = params[0] || MINTS.bkcx;
      const t = chain.getToken(mint);
      if (!t) return null;
      return { context: { slot: chain.stats().slot }, value: { amount: t.supply, decimals: t.decimals, uiAmount: Number(t.supply) / 10 ** t.decimals } };
    }
    case 'getClusterNodes':
      return chain.validators().map((v, i) => ({
        pubkey: v.identity,
        gossip: `validator-${i}.mainnet.bkc.bankchainai.net:8001`,
        rpc: i === 0 ? 'https://api.mainnet.bkc.bankchainai.net' : null,
        version: '1.0.0',
      }));
    default:
      throw new Error(`Method not found: ${method}`);
  }
}

export { CLUSTER, PROGRAMS, MINTS, LABELS };
