// The listing lifecycle across a burn.
//
// `unwrap` burns the token and `wrap` re-mints THE SAME id, and neither contract can see the other's
// state: the market holds a listing keyed by id, and nothing in EthereumRock tells it that the token
// underneath was destroyed and rebuilt. Operator approval survives a burn, mass and seed survive an
// unwrap by design, and the seller is the same address again, so every guard `buy` had would come
// back true and sell a re-wrapped rock at a price its owner set in another life.
//
// The fix is a per-id burn counter (EthereumRock._update) snapshotted into every listing
// (Listing.burnSnap), so any burn in between voids it. No timing assumption, nothing for the two
// contracts to coordinate, and it costs the listing slot's last 24 free bits.
//
// These tests are the fix's proof. The first one is the exploit, and it must revert with
// BurnedSince. The suite's older "an expired listing cannot be bought" covers the case where the
// expiry saved you instead; this one is what happens when it would not have.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, parseEther } from "viem";

const lower = (a: string) => a.toLowerCase();
const HOUR = 3600;
const DAY = 24 * HOUR;

async function setup() {
  const conn = await network.create();
  const { viem } = conn;
  const [alice, bob] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const mock = await viem.deployContract("MockEtherRock");
  const renderer = await viem.deployContract("EthereumRockRenderer");
  const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
  const market = await viem.deployContract("EthereumRockMarket", [rock.address]);
  return { conn, viem, publicClient, alice, bob, mock, rock, market };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Wallet = Ctx["alice"];

const asRock = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("EthereumRock", ctx.rock.address, { client: { wallet: w } });
const asMock = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("MockEtherRock", ctx.mock.address, { client: { wallet: w } });
const asMarket = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("EthereumRockMarket", ctx.market.address, { client: { wallet: w } });

async function ownRock(ctx: Ctx, id: bigint, w: Wallet) {
  const r = await asRock(ctx, w);
  const m = await asMock(ctx, w);
  let warden = await ctx.rock.read.wardens([w.account.address]);
  if (lower(warden) === zeroAddress) {
    await r.write.createWarden();
    warden = await ctx.rock.read.wardens([w.account.address]);
  }
  await m.write.mint([id]);
  await m.write.giftRock([id, warden]);
  await r.write.wrap([id]);
}

// put the raw rock back in alice's warden and wrap it again, exactly as the app's flow does
async function rewrap(ctx: Ctx, id: bigint, w: Wallet) {
  const warden = await ctx.rock.read.wardens([w.account.address]);
  await (await asMock(ctx, w)).write.giftRock([id, warden]);
  await (await asRock(ctx, w)).write.wrap([id]);
}

async function warp(ctx: Ctx, seconds: number) {
  await ctx.conn.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await ctx.conn.provider.request({ method: "evm_mine", params: [] });
}

async function soon(ctx: Ctx, seconds: number) {
  const b = await ctx.publicClient.getBlock();
  return Number(b.timestamp) + seconds;
}

describe("EthereumRockMarket: a listing across a burn", () => {
  it("cannot be revived by re-wrapping, even with everything else still true", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    // a year, which the contract accepts: `_list` bounds expiry only from below
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("0.5"), await soon(ctx, 365 * DAY)]);
    assert.equal((await ctx.market.read.listings([5n]))[5], 0); // burnSnap: never burned at list time

    await (await asRock(ctx, ctx.alice)).write.unwrap([5n]);
    // the listing is not cleared by the burn: nothing tells the market the token is gone
    assert.equal(lower((await ctx.market.read.listings([5n]))[0]), lower(ctx.alice.account.address));
    // while the token does not exist it cannot be bought at all
    await assert.rejects((await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") }));

    await warp(ctx, 30 * DAY);
    await rewrap(ctx, 5n, ctx.alice);

    // owner, approval, mass, price and expiry are every one of them what they were at list time
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.alice.account.address));
    assert.equal(await ctx.rock.read.isApprovedForAll([ctx.alice.account.address, ctx.market.address]), true);
    assert.equal(await ctx.rock.read.mass([5n]), 21000n);
    // and the burn counter is the one thing that moved, so the sale is refused
    assert.equal((await ctx.rock.read.traits([5n]))[2], 1);
    await assert.rejects(
      (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") }),
      /BurnedSince/,
    );

    // the zombie is sweepable by anyone, so the book sheds it without alice having to remember
    await ctx.market.write.pruneListing([5n]);
    assert.equal(lower((await ctx.market.read.listings([5n]))[0]), zeroAddress);

    // and alice can of course list it again, at whatever it is worth now
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("50"), await soon(ctx, 30 * DAY)]);
    assert.equal((await ctx.market.read.listings([5n]))[5], 1); // burnSnap caught up
    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("50") });
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.bob.account.address));
  });

  it("two round trips do not restore the guard (a parity bit would)", async () => {
    const ctx = await setup();
    await ownRock(ctx, 9n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([9n, parseEther("0.5"), await soon(ctx, 365 * DAY)]);

    // The snapshot is a count, not a flag, and that is the whole point: a bit that flipped on each
    // burn would be back to its listed value here, and the listing would sell at the old price.
    for (let i = 0; i < 2; i++) {
      await (await asRock(ctx, ctx.alice)).write.unwrap([9n]);
      await rewrap(ctx, 9n, ctx.alice);
    }
    assert.equal((await ctx.rock.read.traits([9n]))[2], 2);
    await assert.rejects(
      (await asMarket(ctx, ctx.bob)).write.buy([9n], { value: parseEther("0.5") }),
      /BurnedSince/,
    );
  });

  it("survives a merge into the listed rock as a mass drift, not a burn", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await ownRock(ctx, 500n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("0.5"), await soon(ctx, 30 * DAY)]);

    // #500 burns INTO #5, so #5 itself is never burned: mass is what catches this one
    await (await asRock(ctx, ctx.alice)).write.merge([5n, 500n, 0]);
    assert.equal((await ctx.rock.read.traits([5n]))[2], 0); // #5's own burn count is untouched
    assert.equal(await ctx.rock.read.mass([5n]), 42000n);
    await assert.rejects(
      (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") }),
      /MassDrifted/,
    );
  });

  it("cannot be revived by whoever ends up with the raw rock, only by the seller", async () => {
    const ctx = await setup();
    await ownRock(ctx, 7n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([7n, parseEther("0.5"), await soon(ctx, 365 * DAY)]);

    // alice unwraps and hands the raw 2017 rock to bob, who wraps it himself
    await (await asRock(ctx, ctx.alice)).write.unwrap([7n]);
    await (await asMock(ctx, ctx.alice)).write.giftRock([7n, ctx.bob.account.address]);
    await ownRockFromHand(ctx, 7n, ctx.bob);
    assert.equal(lower(await ctx.rock.read.ownerOf([7n])), lower(ctx.bob.account.address));

    // the stale listing names alice as seller, so it can never sell bob's rock
    await assert.rejects((await asMarket(ctx, ctx.alice)).write.buy([7n], { value: parseEther("0.5") }));
    // and it is prunable by anyone, which is how the book sheds it
    await ctx.market.write.pruneListing([7n]);
    assert.equal(lower((await ctx.market.read.listings([7n]))[0]), zeroAddress);
  });
});

// bob already holds the raw rock in hand, so he only needs a warden and a wrap
async function ownRockFromHand(ctx: Ctx, id: bigint, w: Wallet) {
  const r = await asRock(ctx, w);
  await r.write.createWarden();
  const warden = await ctx.rock.read.wardens([w.account.address]);
  await (await asMock(ctx, w)).write.giftRock([id, warden]);
  await r.write.wrap([id]);
}
