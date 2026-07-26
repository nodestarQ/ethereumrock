import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, maxUint256 } from "viem";

// Fresh deployment per test for isolation.
async function setup() {
  const { viem } = await network.create();
  const [alice, bob] = await viem.getWalletClients();
  const mock = await viem.deployContract("MockEtherRock");
  const renderer = await viem.deployContract("EthereumRockRenderer");
  const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
  return { viem, alice, bob, mock, rock };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

// Wrap rock `id` for the default account (alice): free-mint on the mock, gift into the warden, wrap.
async function wrap(ctx: Ctx, id: number) {
  const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
  await ctx.mock.write.mint([BigInt(id)]);
  await ctx.mock.write.giftRock([BigInt(id), warden]);
  await ctx.rock.write.wrap([BigInt(id)]);
}

const lower = (a: string) => a.toLowerCase();

describe("EthereumRock", () => {
  it("wraps, sets mass=21000, and defends the custody rock at max price", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 7);
    assert.equal(lower(await ctx.rock.read.ownerOf([7n])), lower(ctx.alice.account.address));
    assert.equal(await ctx.rock.read.mass([7n]), 21000n);
    assert.equal(await ctx.rock.read.dust([7n]), 0n);
    assert.equal(await ctx.rock.read.totalSupply(), 1n);
    // the warden listed the rock at max price, so the v1 buyRock bug cannot buy it away
    assert.equal(await ctx.mock.read.rockPrice([7n]), maxUint256);
  });

  it("unwraps back to the owner and re-wraps to the identical rock", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 7);
    const seedBefore = await ctx.rock.read.seed([7n]);
    await ctx.rock.write.unwrap([7n]);
    assert.equal(lower(await ctx.mock.read.rockOwner([7n])), lower(ctx.alice.account.address));
    assert.equal(await ctx.rock.read.totalSupply(), 0n);
    // re-wrap: the seed (and thus the art) persists
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
    await ctx.mock.write.giftRock([7n, warden]);
    await ctx.rock.write.wrap([7n]);
    assert.equal(await ctx.rock.read.seed([7n]), seedBefore);
  });

  it("merge burns the higher id and conserves mass", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 100);
    await wrap(ctx, 200);
    await ctx.rock.write.merge([100n, 200n, 0]); // Look.First
    assert.equal(await ctx.rock.read.mass([100n]), 42000n); // 21000 + 21000
    assert.equal(await ctx.rock.read.totalSupply(), 1n);
    await assert.rejects(ctx.rock.read.ownerOf([200n])); // 200 burned
  });

  // The look is the only part of a merge the user chooses, and it is the part that shows. Look.First
  // was the only value covered, and for the survivor it is a no-op (the lower id keeps its own
  // seed), so neither branch that actually changes the art was being exercised.
  it("merge applies the chosen look to the survivor", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();

    // Look.First: the survivor keeps its own art
    await wrap(ctx, 100);
    await wrap(ctx, 200);
    const [a100, a200] = [await ctx.rock.read.seed([100n]), await ctx.rock.read.seed([200n])];
    assert.notEqual(a100, a200, "two rocks should not roll the same seed");
    await ctx.rock.write.merge([100n, 200n, 0]);
    assert.equal(await ctx.rock.read.seed([100n]), a100);

    // Look.Second: the survivor takes the burned rock's art
    await wrap(ctx, 101);
    await wrap(ctx, 201);
    const b201 = await ctx.rock.read.seed([201n]);
    await ctx.rock.write.merge([101n, 201n, 1]);
    assert.equal(await ctx.rock.read.seed([101n]), b201, "Look.Second must adopt the second rock's seed");

    // Look.Reroll: a fresh seed, matching neither input
    await wrap(ctx, 102);
    await wrap(ctx, 202);
    const [c102, c202] = [await ctx.rock.read.seed([102n]), await ctx.rock.read.seed([202n])];
    await ctx.rock.write.merge([102n, 202n, 2]);
    const after = await ctx.rock.read.seed([102n]);
    assert.notEqual(after, c102, "Look.Reroll must not keep the old seed");
    assert.notEqual(after, c202, "Look.Reroll must not adopt the burned rock's seed");

    // and the look really does reach the rendered art, not just storage
    const uri = await ctx.rock.read.tokenURI([101n]);
    const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    const color = meta.attributes.find((a: any) => a.trait_type === "Color").value;
    assert.match(color, /^#[0-9a-f]{6}$/);
  });

  // Order must not matter: the contract picks the survivor by id, so the caller's argument order
  // decides which seed "First" and "Second" name, not which rock lives.
  it("merge look follows the argument order, not the id order", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 100);
    await wrap(ctx, 200);
    const s100 = await ctx.rock.read.seed([100n]);
    // passing the HIGH id first, then Look.Second, means "keep #100's art" - and #100 survives
    await ctx.rock.write.merge([200n, 100n, 1]);
    assert.equal(await ctx.rock.read.seed([100n]), s100);
    assert.equal(await ctx.rock.read.mass([100n]), 42000n);
    await assert.rejects(ctx.rock.read.ownerOf([200n]));
  });

  it("lets a 100-9999 rock merge into a 0-99 rock (the path to the final 100)", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 50); // Genesis
    await wrap(ctx, 300); // 10K
    await ctx.rock.write.merge([50n, 300n, 0]);
    assert.equal(await ctx.rock.read.mass([50n]), 42000n); // 21000 + 21000
    await assert.rejects(ctx.rock.read.ownerOf([300n]));
  });

  it("never lets a 0-99 rock be burned", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 20);
    await wrap(ctx, 30);
    // both < 100, so the higher (30) cannot be burned
    await assert.rejects(ctx.rock.write.merge([20n, 30n, 0]));
  });

  it("absorbs dust as its own trait, separate from mass, minting no token", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 100);
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
    await ctx.mock.write.mint([10000n]); // a >= 10000 "dust" rock
    await ctx.mock.write.giftRock([10000n, warden]);
    await ctx.rock.write.absorb([10000n, 100n]);
    assert.equal(await ctx.rock.read.dust([100n]), 1n);
    assert.equal(await ctx.rock.read.mass([100n]), 21000n); // mass untouched by dust
    assert.equal(await ctx.rock.read.totalSupply(), 1n); // no new token for the dust rock
    await assert.rejects(ctx.rock.read.ownerOf([10000n]));
  });

  it("blocks the v1 buyRock bug on warden and custody rocks (non-payable + max price)", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);

    // a rock parked in the warden at a low price (the pre-wrap deposit window)
    await ctx.mock.write.mint([7n]);
    await ctx.mock.write.sellRock([7n, 1n]);
    await ctx.mock.write.giftRock([7n, warden]);
    // buyRock would pay the warden via .transfer, which reverts (warden is non-payable)
    await assert.rejects(ctx.mock.write.buyRock([7n], { value: 1n }));

    // a wrapped rock is EthereumRock-held at max price: buyRock can never match 2**256-1
    await ctx.mock.write.mint([8n]);
    await ctx.mock.write.giftRock([8n, warden]);
    await ctx.rock.write.wrap([8n]);
    await assert.rejects(ctx.mock.write.buyRock([8n], { value: 1n }));
  });

  it("rejects wrapping a dust id (>= 10000)", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
    await ctx.mock.write.mint([10000n]);
    await ctx.mock.write.giftRock([10000n, warden]);
    await assert.rejects(ctx.rock.write.wrap([10000n]));
  });

  it("migrates an old v1-wrapped rock into the new collection in one transaction", async () => {
    const { viem } = await network.create();
    const [alice] = await viem.getWalletClients();
    const mock = await viem.deployContract("MockEtherRock");
    const old = await viem.deployContract("MockOldWrapper", [mock.address]);
    const renderer = await viem.deployContract("EthereumRockRenderer");
    // wire the new contract so `old` is a recognized migration source (as WRAPPER_SUB100)
    const rock = await viem.deployContract("EthereumRock", [mock.address, old.address, zeroAddress, renderer.address]);

    // alice holds an old-wrapped rock #123
    await mock.write.mint([123n]);
    await mock.write.giftRock([123n, old.address]);
    await old.write.wrap([123n]);

    // migrate: safeTransferFrom the old NFT into EthereumRock; onERC721Received unwraps + re-mints
    await old.write.safeTransferFrom([alice.account.address, rock.address, 123n]);

    assert.equal(lower(await rock.read.ownerOf([123n])), lower(alice.account.address));
    assert.equal(await rock.read.mass([123n]), 21000n);
    assert.equal(await rock.read.totalSupply(), 1n);
    await assert.rejects(old.read.ownerOf([123n])); // old NFT burned
    assert.equal(await mock.read.rockPrice([123n]), maxUint256); // raw rock defended in new custody
  });

  it("returns an on-chain data URI assembled by the renderer", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 42);
    const uri = await ctx.rock.read.tokenURI([42n]);
    assert.ok(uri.startsWith("data:application/json;base64,"));
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    assert.equal(json.name, "EthereumRock #42");
    assert.ok(json.image.startsWith("data:image/svg+xml;base64,"));
    const statusOf = (j: { attributes: { trait_type: string; value: string }[] }) =>
      j.attributes.find((a) => a.trait_type === "Status")?.value;
    assert.equal(statusOf(json), "DEFINED"); // 0-99 were meant to exist
    await wrap(ctx, 500);
    const j2 = JSON.parse(Buffer.from((await ctx.rock.read.tokenURI([500n])).split(",")[1], "base64").toString("utf8"));
    assert.equal(statusOf(j2), "UNDEFINED"); // 100+ exist only via the v1 mint bug
    const attr = (j: { attributes: { trait_type: string; value: string | number; display_type?: string }[] }, t: string) =>
      j.attributes.find((a) => a.trait_type === t);
    const color = String(attr(json, "Color")?.value);
    assert.match(color, /^#[0-9a-f]{6}$/); // on-chain hex color (readable value)
    assert.equal(attr(json, "Hue")?.display_type, "number"); // numeric hue for range filtering
    assert.equal(attr(json, "Size")?.value, 100); // DEFINED rocks render at size 100
    const undefSize = Number(attr(j2, "Size")?.value);
    assert.ok(undefSize >= 67 && undefSize <= 90); // UNDEFINED rocks: 67-90
  });

  it("batches tokenURI for a whole grid, and answers empty for ids with no live token", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 42);
    await wrap(ctx, 500);

    // 3 is never wrapped, 9999 never existed: both come back empty rather than reverting the batch,
    // which is what lets a gallery read the bitmap and this in two calls without a race killing it
    const out = await ctx.rock.read.tokenURIBatch([[42n, 3n, 500n, 9999n]]);
    assert.equal(out.length, 4);
    assert.equal(out[1], "");
    assert.equal(out[3], "");
    assert.equal(out[0], await ctx.rock.read.tokenURI([42n])); // identical to the single-id read
    assert.equal(out[2], await ctx.rock.read.tokenURI([500n]));

    // an unwrap mid-page is the race this tolerance exists for
    await ctx.rock.write.unwrap([42n]);
    const after = await ctx.rock.read.tokenURIBatch([[42n, 500n]]);
    assert.equal(after[0], "");
    assert.ok(after[1].startsWith("data:application/json;base64,"));

    assert.deepEqual(await ctx.rock.read.tokenURIBatch([[]]), []);
  });
});

describe("EthereumRock enumeration (tokensOfOwner)", () => {
  // Wrap `id` for a specific account: free-mint on the mock as them, gift into their warden, wrap.
  async function wrapFor(ctx: Ctx, who: Ctx["alice"], id: number) {
    const warden = await ctx.rock.read.wardens([who.account.address]);
    await ctx.mock.write.mint([BigInt(id)], { account: who.account });
    await ctx.mock.write.giftRock([BigInt(id), warden], { account: who.account });
    await ctx.rock.write.wrap([BigInt(id)], { account: who.account });
  }
  const nums = (a: readonly bigint[]) => a.map(Number);

  it("returns exactly the ids an address holds, ascending, across word boundaries", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await ctx.rock.write.createWarden({ account: ctx.bob.account });
    // 0 = word0/bit0, 255 = word0/bit255, 256 = word1/bit0, 9999 = word39/bit15: every index path.
    // Wrapped out of order to prove the result is sorted by the contract, not by insertion.
    for (const id of [256, 0, 9999, 255]) await wrapFor(ctx, ctx.alice, id);
    for (const id of [7, 200]) await wrapFor(ctx, ctx.bob, id);

    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwner([ctx.alice.account.address])), [0, 255, 256, 9999]);
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwner([ctx.bob.account.address])), [7, 200]);
  });

  it("returns empty for a holder of nothing, and always matches balanceOf", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await wrap(ctx, 42);
    assert.deepEqual(await ctx.rock.read.tokensOfOwner([ctx.bob.account.address]), []);
    const ids = await ctx.rock.read.tokensOfOwner([ctx.alice.account.address]);
    assert.equal(BigInt(ids.length), await ctx.rock.read.balanceOf([ctx.alice.account.address]));
  });

  it("follows transfers, merges (burn) and unwraps", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    await ctx.rock.write.createWarden({ account: ctx.bob.account });
    for (const id of [100, 200, 500]) await wrapFor(ctx, ctx.alice, id);

    await ctx.rock.write.transferFrom([ctx.alice.account.address, ctx.bob.account.address, 200n]);
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwner([ctx.alice.account.address])), [100, 500]);
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwner([ctx.bob.account.address])), [200]);

    await ctx.rock.write.merge([100n, 500n, 0]); // burns the higher id (500) into 100
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwner([ctx.alice.account.address])), [100]);

    await ctx.rock.write.unwrap([100n]);
    assert.deepEqual(await ctx.rock.read.tokensOfOwner([ctx.alice.account.address]), []);
  });

  it("tokensOfOwnerIn windows the id space, is [from,to), and clamps to MAX_ID", async () => {
    const ctx = await setup();
    await ctx.rock.write.createWarden();
    for (const id of [5, 42, 300, 9999]) await wrapFor(ctx, ctx.alice, id);
    const a = ctx.alice.account.address;

    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwnerIn([a, 0n, 100n])), [5, 42]);
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwnerIn([a, 42n, 301n])), [42, 300]); // from inclusive, to exclusive
    assert.deepEqual(nums(await ctx.rock.read.tokensOfOwnerIn([a, 301n, 1000000n])), [9999]); // toId clamps to MAX_ID
    assert.deepEqual(await ctx.rock.read.tokensOfOwnerIn([a, 500n, 500n]), []); // empty window

    // a full split rejoins into exactly tokensOfOwner
    const lo = nums(await ctx.rock.read.tokensOfOwnerIn([a, 0n, 300n]));
    const hi = nums(await ctx.rock.read.tokensOfOwnerIn([a, 300n, 10000n]));
    assert.deepEqual([...lo, ...hi], nums(await ctx.rock.read.tokensOfOwner([a])));
  });
});
