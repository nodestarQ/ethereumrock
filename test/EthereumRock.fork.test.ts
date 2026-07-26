import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, maxUint256 } from "viem";

// "Near mainnet deployment" test: fork mainnet and wrap a REAL rock straight off the live
// EtherRock v1 contract, so the warden + sellRock(max) defense are exercised against the actual
// 2017 bytecode (bug and all), not a mock.
//
// Guarded behind FORK so the normal `npx hardhat test` (offline) does not try to fork.
// Run: FORK=1 MAINNET_RPC_URL=<archive rpc> npx hardhat test test/EthereumRock.fork.test.ts

const V1 = "0x37504AE0282f5f334ED29b4548646f887977b7cC"; // EtherRock v1
const SUB100 = "0xb895cAffECb62B5E49828c9d64116Fd07Dd33DEF"; // GenesisRocks (0-99)
const TENK = "0x39b780E8062CE299ab60ed3D48F447e97511a2eD"; // GenesisRocks10000 (100-9999)
const ID = 0n;
const ZERO = getAddress("0x0000000000000000000000000000000000000000");

const V1_ABI = [
  {
    type: "function",
    name: "rocks",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "giftRock",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sellRock",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [],
  },
] as const;

describe("EthereumRock on a mainnet fork", { skip: !process.env.FORK }, () => {
  it("wraps a real rock straight off the live EtherRock v1 contract", async () => {
    const conn = await network.create("mainnetFork");
    const { viem } = conn;
    const publicClient = await viem.getPublicClient();

    const renderer = await viem.deployContract("EthereumRockRenderer");
    const rock = await viem.deployContract("EthereumRock", [V1, SUB100, TENK, renderer.address]);

    // whoever actually owns rock 0 at the fork block
    const before = await publicClient.readContract({ address: V1, abi: V1_ABI, functionName: "rocks", args: [ID] });
    const owner = getAddress(before[0] as string);
    assert.notEqual(owner, ZERO); // rock 0 exists and is owned

    // impersonate the real owner and fund gas
    await conn.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });
    await conn.provider.request({ method: "hardhat_setBalance", params: [owner, "0x8ac7230489e80000"] }); // 10 ETH
    const wallet = await viem.getWalletClient(owner);
    const rockAsOwner = await viem.getContractAt("EthereumRock", rock.address, { client: { wallet } });

    // wrap flow against the real contract, in the order the frontend sends it: lock the rock at an
    // unpayable price, gift it into your warden, wrap. Gas is captured because this is the only
    // place it can be measured honestly: the two v1 legs run against 2017 bytecode, and the mock
    // used everywhere else is much simpler than the real thing.
    const gas: Record<string, bigint> = {};
    const measure = async (label: string, hash: `0x${string}`) => {
      gas[label] = (await publicClient.waitForTransactionReceipt({ hash })).gasUsed;
    };

    await measure("createWarden (once per address)", await rockAsOwner.write.createWarden());
    const warden = await rock.read.wardens([owner]);
    await measure(
      "sellRock(id, max) on live v1",
      await wallet.writeContract({ address: V1, abi: V1_ABI, functionName: "sellRock", args: [ID, maxUint256] }),
    );
    await measure(
      "giftRock(id, warden) on live v1",
      await wallet.writeContract({ address: V1, abi: V1_ABI, functionName: "giftRock", args: [ID, warden] }),
    );
    await measure("wrap(id)", await rockAsOwner.write.wrap([ID]));

    const wrapTotal = gas["sellRock(id, max) on live v1"] + gas["giftRock(id, warden) on live v1"] + gas["wrap(id)"];
    console.log("\n  gas against LIVE EtherRock v1 bytecode:");
    for (const [k, v] of Object.entries(gas)) console.log(`    ${k.padEnd(34)} ${v.toLocaleString("en-US").padStart(9)}`);
    console.log(`    ${"a complete wrap (the three above)".padEnd(34)} ${wrapTotal.toLocaleString("en-US").padStart(9)}\n`);

    // the new NFT is minted to the real owner, at base mass
    assert.equal(getAddress(await rock.read.ownerOf([ID])), owner);
    assert.equal(await rock.read.mass([ID]), 21000n);

    // the LIVE v1 contract now records our wrapper as the rock's owner, defended at max price
    const after = await publicClient.readContract({ address: V1, abi: V1_ABI, functionName: "rocks", args: [ID] });
    assert.equal(getAddress(after[0] as string), getAddress(rock.address));
    assert.equal(after[2], maxUint256);

    // tokenURI renders from real state
    assert.ok((await rock.read.tokenURI([ID])).startsWith("data:application/json;base64,"));
    console.log(`  forked wrap OK: real rock ${ID} (owner ${owner}) -> wrapped; v1 owner now ${rock.address}`);
  });
});
