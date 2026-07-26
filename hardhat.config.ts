import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

// Hardhat 3 (TypeScript + viem). This repo is contracts and tests only, so there are no signing
// keys and no public networks configured here: nothing in it can spend anything. Deployment lives
// with the deploy scripts, which carry their own network and keystore configuration.
//
// If the pinned versions drift, run `npx hardhat --init` in a scratch folder and copy its generated
// config and package.json, then drop these contracts and tests back in.
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: {
      // Deployment settings. The optimizer run count is part of the bytecode, so changing it changes
      // every deployed address that commits to an init code hash. Treat it as frozen.
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // An in-process chain for the test suite. blockGasLimit is pinned to EIP-7825's per-transaction
    // cap (16,777,216) rather than left at the 60,000,000 default, because a block limit above the
    // transaction cap lets a test pass on a transaction no real chain would accept.
    local: { type: "edr-simulated", blockGasLimit: 16_777_216 },
    // Mainnet fork, for the tests that run against the live 2017 contracts. The URL comes from the
    // ENVIRONMENT, so a normal test run never needs a secret:
    //   FORK=1 MAINNET_RPC_URL=<archive rpc> npx hardhat test test/EthereumRock.fork.test.ts
    // Without FORK=1 those tests skip themselves, which is what keeps `npx hardhat test` offline.
    mainnetFork: {
      type: "edr-simulated",
      chainType: "l1",
      forking: {
        url: process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
        // A pinned block is reproducible but ages out of any non-archive endpoint within days, and
        // the public default is not an archive. FORK_BLOCK overrides it; "latest" uses current
        // state, which is what a gas measurement wants anyway.
        ...(process.env.FORK_BLOCK === "latest"
          ? {}
          : { blockNumber: Number(process.env.FORK_BLOCK ?? 25546637) }),
      },
    },
  },
});
