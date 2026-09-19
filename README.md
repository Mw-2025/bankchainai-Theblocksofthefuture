# BankChainAI — The Blocks of the Future

Canonical public working tree for **Bank Coin (BKC)** and **Bank Tokens (BKCX)**.

Private canonical platform: [bankchainai/BankchainAI-TheBlocksofthefuture](https://github.com/bankchainai/BankchainAI-TheBlocksofthefuture)

## Native chain

BKC is a Solana-style account-model L1:

| Asset | Symbol | Decimals | Role |
| --- | --- | --- | --- |
| Bank Coin | **BKC** | 9 | Native coin / fees / stake |
| Bank Tokens | **BKCX** | 6 | Platform settlement token (`balanceBankToken`) |

- Slot time: 400ms
- Epoch: 4320 slots
- JSON-RPC: Solana-compatible subset (`getSlot`, `getBlock`, `getTransaction`, `getAccountInfo`, `getBalance`, `getSupply`, `getEpochInfo`, `getVoteAccounts`, …)

```bash
bun run node
# RPC http://localhost:8899
```

Ledger lives in `data/bkc-mainnet.db`. The platform tracker writes every block, transfer, mint, and banking-ledger row so the explorer stays in lockstep with this repository.

## Explorer

Solana Explorer layout (cluster stats, search, blocks, txs, accounts, tokens, supply, validators) served as the `bkc-explorer` dashboard. It talks to this chain and shows GitHub linkage on the Platform tab.

## Banking bridge

`application-layer/backend/banking-service` posts ledger entries on-chain via `src/chain-bridge.js`. `TransactionLedger.blockchainHash` is the BKC signature.
