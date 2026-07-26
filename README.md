```
      ##
      ####          E T H E R E U M R O C K
    ########
    ########        a fully on-chain wrapper for EtherRock v1, 2017
    ########
      ######
```

# EthereumRock

An ERC-721 wrapper for **EtherRock v1** (`0x37504AE0282f5f334ED29b4548646f887977b7cC`), plus a
zero-fee market for the wrapped rocks. The Art and metadata are generated on chain.

This repo is contracts, tests and the frontend.

## Why

EtherRock launched 26 December 2017 as one of the first NFTs on mainnet. Seventeen hours earlier the
same developer had deployed a buggy version and replaced it the next morning. That one is v1.

It was meant to be a hundred rocks. A mistyped `=` in `buyRock` left every rock permanently for sale
at its stored price, and ids 100 and up had `0` stored, so anyone could take those for gas. That bug
is why v1 has thousands of rocks and why anyone outside the first hundred owns one.

Both EtherRock contracts predate ERC-721, so no wallet or marketplace can show them without a
wrapper. The 2021 attempt shipped as *two* contracts, ids 0-99 and 100-9999, splitting collectors
into an elite hundred and everyone else. The developer had disowned v1 by then, its collection was
delisted and the whole thing was abandoned again.

## What's different here

- **One wrapper for all 10,000 ids.**
- **Nobody owns it.** No owner, pause, fee switch, proxy, or admin function. `renderer` is
  `immutable`, so the art can never be swapped.
- **Supply can shrink to the hundred that were intended.** `merge` burns the higher id into the
  lower, which keeps both masses. Ids 0-99 can never burn, so consolidation stops at the original
  hundred. You pick which rock's art survives, or reroll. Nothing rewards merging, so it is the
  collectors' call.
- **The Art is being generated on chain.** Unlike EtherRock or the split wrapper, the art and metadata is being fully generated on chain for each rock separately.
- **The website is on chain too.** `EthereumRockSite` stores one self-contained `index.html` in
  SSTORE2 chunks and served via ERC-8244 `html()` and web3://.

## Wrapping, and the bug it has to survive

`buyRock` still works on v1, and an unpriced rock is priced at zero.

1. Every rock in custody is listed at `type(uint256).max`, so there is no price to buy it at.
2. Nothing here can receive ETH. No `receive()`, no `fallback()`, so v1's `owner.transfer(price)`
   reverts while a rock is held. Adding a payable function to the token or the warden would break
   this.

v1 ownership moves by `giftRock` with no approvals, so the token contract cannot pull a rock. Instead
each holder deploys a personal escrow **warden** once (`createWarden`), gifts the rock into it, then
calls `wrap(id)`.

| | |
| --- | --- |
| `wrap(id)` | from your warden, after you gift the raw rock in |
| `onERC721Received` | migrates a 2021-wrapped rock in one transaction |
| `unwrap(id)` | burns the wrapper NFT and gives you the raw rock back. Seed, mass and dust persist, so rewrapping is identical |
| `absorb(id, into)` | ids >= 10000 are not part of the set but can still be absorbed as `+1 dust` |

## Market

`EthereumRockMarket` is optional and standalone but has 0 fees and is immutable.

- `list` / `buy` at a fixed price with an expiry, or `listTo` for a private sale.
- Offers escrow ETH. Being outbid refunds you. Raising your own bid is a top-up, so 10 to 20 costs
  10, not another 20.
- Paying a **third party** is pull-based (`pendingWithdrawals` + `withdraw()`): a push at an address
  that reverts on receive would brick someone else's transaction, with no owner to rescue it. Your
  **own** bid pays out directly, since refusing there only fails your own call.
- Listings snapshot `mass` and `burns` and recheck on `buy`, so a merge cannot sell a grown rock cheap
  and an `unwrap` cannot leave a listing that re-arms later. They expire, and anyone can
  `pruneListing`.
- No indexer. Two bitmaps cover all 10,000 ids in 40 words each, and every sale event points at that
  rock's previous sale, so history is a linked list of single-block queries.

## Layout

```
contracts/
  EthereumRock.sol           wrap, unwrap, migrate, merge, absorb, and the warden
  EthereumRockMarket.sol     zero-fee, ownerless, non-custodial market
  EthereumRockRenderer.sol   on-chain art and metadata
  EthereumRockSite.sol       the frontend, stored on chain
  mocks/                     tests only: a stand-in v1, the 2021 wrappers, hostile receivers
frontend/                    Svelte 5, no backend, builds to one self-contained index.html
artBuildingBlocks/           the 8x8 source art the renderer and the page both draw from
test/                        *.ts drives the contracts, *.mjs drives the frontend's codec
```

## Frontend

`frontend/` reads the whole order book and price history straight from chain state through an injected
wallet, and ships no RPC of its own. The build inlines every asset into a single `dist/index.html`,
which is both what you can host anywhere and the exact bytes `EthereumRockSite` stores on chain.

```
cd frontend && pnpm install && pnpm build
```

Point it at a deployment in `frontend/src/config.js`, which also carries the mainnet addresses to
restore for a real build.

## Tests

```
npm install
npx hardhat test        # 108 tests, offline
```

```
FUZZ_SEED=7 FUZZ_SEQUENCES=40 FUZZ_ACTIONS=200 npx hardhat test test/EthereumRockMarket.invariant.test.ts
FORK=1 MAINNET_RPC_URL=<archive rpc> npx hardhat test test/EthereumRock.fork.test.ts
```

## Deploy

| `EthereumRock` argument | mainnet |
| --- | --- |
| `rocks_` | `0x37504AE0282f5f334ED29b4548646f887977b7cC` EtherRock v1 |
| `wrapperSub100_` | `0xb895cAffECb62B5E49828c9d64116Fd07Dd33DEF` GenesisRocks 0-99 |
| `wrapper10k_` | `0x39b780E8062CE299ab60ed3D48F447e97511a2eD` GenesisRocks10000 |
| `renderer_` | the renderer deployed alongside |

`rocks_` is immutable, so a deployment pointed at a mock is pointed at a mock forever. No testnet has
a real EtherRock, which is what `contracts/mocks/` is for. The optimizer run count is part of the
bytecode, so treat `hardhat.config.ts` as frozen once addresses matter.

## Status

**Not externally audited.** These contracts custody NFTs, escrow ETH, and have no owner and no upgrade path.
Nothing here has had an external review. I checked the code myself, I will ask some chads to have a look at it as well and will update the readme accordingly with findings and or potential bugs.

## License

MIT (`LICENSE`). The art is CC0 1.0.
