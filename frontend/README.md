# EthereumRock frontend

A Svelte 5 frontend for the EthereumRock wrapper and EthereumRockMarket, built with Vite into a static bundle you
can pin to IPFS. It talks straight to the contracts through an injected wallet and reads the whole
order book and price history from chain state, so there is no backend, no indexer, and no relayer.

## Stack & principles

- **Svelte 5 + Vite**, no SvelteKit. Svelte compiles away (no virtual DOM), so the whole app is a
  ~27 kB gzipped bundle.
- **Hash routing** (`#/rock/5`). Works on every IPFS gateway and from `file://`, needs no gateway
  config. Routes: `#/`, `#/market`, `#/rock/:id`, `#/account`, `#/workshop`.
- **Injected wallets only** (EIP-6963, with a `window.ethereum` fallback). No WalletConnect, no
  Coinbase SDK, no smart-wallet machinery.
- **Ships no RPC of its own.** Every call is proxied through the connected wallet's provider, so no
  third-party server sees what you browse. `config.rpcUrl` is an optional escape hatch for
  wallet-less browsing; it is empty by default.
- **No production web3 dependency.** All contract encoding/decoding goes through `src/lib/abi.js`, a
  tiny hand-rolled codec verified byte-for-byte against viem in `../test/abi.codec.test.mjs` and
  driven against real deployed bytecode in `../test/frontend.e2e.ts`.

## Layout

```
src/
  config.js              the only file you edit: chain id + contract addresses
  lib/
    abi.js               the tested ABI codec (imported by the app AND the tests)
    rpc.js               wallet-proxied JSON-RPC (raw / ethCall / send)
    contracts.js         typed reads + writes for EthereumRock and EthereumRockMarket
    wallet.svelte.js     EIP-6963 discovery + connection (reactive)
    router.svelte.js     hash router (reactive)
    log.svelte.js        the on-screen tx/status log (reactive)
    format.js            display helpers
  components/            Nav, TxLog, RockArt
  routes/                Home, Market, Rock, Account, Wrap
```

## Run it

```
cd frontend
pnpm install
pnpm dev                 # http://localhost:5173
```

1. Deploy the contracts (repo root `README.md`).
2. Edit `src/config.js`: set `chainId`, `rock`, `market`, and (for a local/testnet deploy) the
   `v1` / `wrapperSub100` / `wrapper10k` addresses.
3. `pnpm build` → `dist/`. Serve it anywhere static, or pin it to IPFS.

For a local end-to-end run: `npx hardhat node`, deploy to it, point your wallet at
`http://127.0.0.1:8545` (chain 31337), import a node key.

## How it stays serverless

- **Live book**: `listedBitmap()` / `bidBitmap()` return 40 words covering all 10,000 ids; the app
  decodes the set bits and batch-reads them with `getListings` / `getBids`. Six calls, no logs.
- **"Last sold for X"**: one `getLastSales()` call.
- **Full price history**: every sale event carries the block of that rock's previous sale, so the
  app walks the log backwards one single-block query at a time. No block-range scanning.
- **Your rocks** (Account page): the one place that reads logs — an opt-in scan of ERC-721
  `Transfer` events for your address.
