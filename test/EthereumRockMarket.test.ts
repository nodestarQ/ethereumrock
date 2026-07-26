import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, parseEther } from "viem";

const lower = (a: string) => a.toLowerCase();
const HOUR = 3600;

async function setup() {
  const conn = await network.create();
  const { viem } = conn;
  const [alice, bob, carol] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const mock = await viem.deployContract("MockEtherRock");
  const renderer = await viem.deployContract("EthereumRockRenderer");
  const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
  const market = await viem.deployContract("EthereumRockMarket", [rock.address]);
  return { conn, viem, publicClient, alice, bob, carol, mock, rock, market };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Wallet = Ctx["alice"];

const asRock = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("EthereumRock", ctx.rock.address, { client: { wallet: w } });
const asMock = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("MockEtherRock", ctx.mock.address, { client: { wallet: w } });
const asMarket = (ctx: Ctx, w: Wallet) => ctx.viem.getContractAt("EthereumRockMarket", ctx.market.address, { client: { wallet: w } });

// wrap rock `id` so wallet `w` owns the NFT
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

async function warp(ctx: Ctx, seconds: number) {
  await ctx.conn.provider.request({ method: "evm_increaseTime", params: [seconds] });
  await ctx.conn.provider.request({ method: "evm_mine", params: [] });
}

async function soon(ctx: Ctx, seconds = HOUR) {
  const b = await ctx.publicClient.getBlock();
  return Number(b.timestamp) + seconds;
}

// the exact client-side decode a static frontend does: 40 words -> the ids with an open order
function bitsSet(words: readonly bigint[]): number[] {
  const out: number[] = [];
  words.forEach((w, wi) => {
    for (let b = 0; b < 256; b++) if ((w >> BigInt(b)) & 1n) out.push(wi * 256 + b);
  });
  return out;
}

describe("EthereumRockMarket", () => {
  it("lists and sells at 100% to the seller, no fee", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);

    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("1") });
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.bob.account.address));
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.alice.account.address]), parseEther("1"));

    const before = await ctx.publicClient.getBalance({ address: ctx.alice.account.address });
    await (await asMarket(ctx, ctx.alice)).write.withdraw();
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.alice.account.address]), 0n);
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), 0n); // no fee retained
    assert.ok((await ctx.publicClient.getBalance({ address: ctx.alice.account.address })) > before); // seller got paid
  });

  it("supports private sales (listTo)", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.listTo([5n, parseEther("1"), await soon(ctx), ctx.bob.account.address]);
    await assert.rejects((await asMarket(ctx, ctx.carol)).write.buy([5n], { value: parseEther("1") })); // not the buyer
    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("1") });
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.bob.account.address));
  });

  it("bids: make, outbid-refund, and accept", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asMarket(ctx, ctx.bob)).write.makeOffer([5n], { value: parseEther("0.5") });
    await (await asMarket(ctx, ctx.carol)).write.makeOffer([5n], { value: parseEther("0.6") }); // outbids bob
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.bob.account.address]), parseEther("0.5")); // bob refunded
    assert.equal(lower((await ctx.market.read.bids([5n]))[0]), lower(ctx.carol.account.address));

    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.acceptOffer([5n, parseEther("0.6")]);
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.carol.account.address));
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.alice.account.address]), parseEther("0.6"));
  });

  // Raising your OWN bid is a top-up: the escrow you already have counts, so you send only the
  // difference. The alternative forces a bidder to hold twice their bid in free ETH just to raise.
  it("raising your own bid tops it up, so you only send the difference", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    const bob = await asMarket(ctx, ctx.bob);

    await bob.write.makeOffer([5n], { value: parseEther("10") });
    assert.equal((await ctx.market.read.bids([5n]))[1], parseEther("10"));

    // 10 more takes the bid to 20. Only 20 ever leaves bob's wallet, not 30.
    await bob.write.makeOffer([5n], { value: parseEther("10") });
    assert.equal((await ctx.market.read.bids([5n]))[1], parseEther("20"));
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), parseEther("20"));
    // nothing was returned, so nothing is owed: the escrow never left
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.bob.account.address]), 0n);

    // any positive top-up raises, however small, since it can only ever increase the total
    await bob.write.makeOffer([5n], { value: 1n });
    assert.equal((await ctx.market.read.bids([5n]))[1], parseEther("20") + 1n);
    await assert.rejects(bob.write.makeOffer([5n], { value: 0n })); // but zero is still no bid

    // a THIRD party still has to beat the whole standing total, and gets nothing for free
    await assert.rejects((await asMarket(ctx, ctx.carol)).write.makeOffer([5n], { value: parseEther("15") }));
    await (await asMarket(ctx, ctx.carol)).write.makeOffer([5n], { value: parseEther("25") });
    assert.equal(lower((await ctx.market.read.bids([5n]))[0]), lower(ctx.carol.account.address));
    // and bob's whole escrow comes back to him, top-ups included
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.bob.account.address]), parseEther("20") + 1n);
  });

  it("Offered reports the resulting total, not the value sent", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    const bob = await asMarket(ctx, ctx.bob);
    await bob.write.makeOffer([5n], { value: parseEther("10") });
    await bob.write.makeOffer([5n], { value: parseEther("10") }); // tops up to 20

    const offered = await ctx.publicClient.getContractEvents({
      address: ctx.market.address, abi: ctx.market.abi, eventName: "Offered", fromBlock: 0n,
    });
    assert.equal(offered.length, 2);
    assert.equal(offered[1].args.amount, parseEther("20")); // the total, so indexers need no running sum

    // a top-up returns nothing, so it must NOT claim an escrow return
    const withdrawn = await ctx.publicClient.getContractEvents({
      address: ctx.market.address, abi: ctx.market.abi, eventName: "OfferWithdrawn", fromBlock: 0n,
    });
    assert.equal(withdrawn.length, 0);
  });

  // Taking your own bid back pays out on the spot. It is the one payout that skips the pull ledger,
  // because the recipient is the caller: a refusal fails only their own call and griefs nobody.
  it("withdrawing a bid pays the bidder directly, in one transaction", async () => {
    const ctx = await setup();
    const bob = await asMarket(ctx, ctx.bob);
    await bob.write.makeOffer([5n], { value: parseEther("0.5") });
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), parseEther("0.5"));

    const before = await ctx.publicClient.getBalance({ address: ctx.bob.account.address });
    await bob.write.withdrawOffer([5n]);

    assert.equal((await ctx.market.read.bids([5n]))[1], 0n); // bid released
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), 0n); // ETH really left
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.bob.account.address]), 0n); // nothing parked
    // the ETH is in bob's wallet now, not owed to him. gas keeps it under a clean 0.5.
    const after = await ctx.publicClient.getBalance({ address: ctx.bob.account.address });
    assert.ok(after > before + parseEther("0.49"), `expected ~0.5 back, got ${after - before}`);
    // and a second withdraw finds nothing, rather than paying twice
    await assert.rejects(bob.write.withdrawOffer([5n]));
    await assert.rejects(bob.write.withdraw()); // Nothing owed: it was never routed through the ledger
  });

  // The bid slot is freed before the ETH moves, so a re-entering bidder finds it already gone.
  it("a re-entrant bidder cannot drain by withdrawing its own bid twice", async () => {
    const ctx = await setup();
    const trap = await ctx.viem.deployContract("ReentrantWithdrawer", [ctx.market.address]);
    await trap.write.bid([5n], { value: parseEther("1") });
    await (await asMarket(ctx, ctx.carol)).write.makeOffer([9n], { value: parseEther("3") }); // other funds present
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), parseEther("4"));

    await trap.write.pull([5n]); // its receive() re-enters withdrawOffer, which must find no bid
    assert.equal(await ctx.publicClient.getBalance({ address: trap.address }), parseEther("1")); // exactly its own
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), parseEther("3")); // carol's untouched
    assert.equal(await trap.read.reentered(), true); // the callback really did fire
  });

  it("a bidder that cannot receive ETH fails only its own withdrawal", async () => {
    const ctx = await setup();
    const picky = await ctx.viem.deployContract("PickyReceiver", [ctx.market.address]);
    await picky.write.bid([5n], { value: parseEther("1") });

    await assert.rejects(picky.write.pull([5n])); // its receive() reverts, so the whole call undoes
    assert.equal((await ctx.market.read.bids([5n]))[1], parseEther("1")); // bid intact, not half-released
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), parseEther("1"));

    // nobody else is blocked: the bid can still be outbid, and that refund DOES use the ledger
    await (await asMarket(ctx, ctx.carol)).write.makeOffer([5n], { value: parseEther("2") });
    assert.equal(await ctx.market.read.pendingWithdrawals([picky.address]), parseEther("1"));

    await picky.write.setRejecting([false]); // and once it can accept, it collects
    await picky.write.claim();
    assert.equal(await ctx.publicClient.getBalance({ address: picky.address }), parseEther("1"));
  });

  it("a stale listing (rock moved) fails safe and can be pruned", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);
    // alice moves the rock out from under her own listing
    await (await asRock(ctx, ctx.alice)).write.transferFrom([ctx.alice.account.address, ctx.carol.account.address, 5n]);
    await assert.rejects((await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("1") })); // stale, reverts
    await ctx.market.write.pruneListing([5n]); // anyone can clean it up
    assert.equal(lower((await ctx.market.read.listings([5n]))[0]), zeroAddress);
  });

  it("is safe against a reentrant buyer", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);
    const attacker = await ctx.viem.deployContract("ReentrantBuyer", [ctx.market.address]);
    await assert.rejects(attacker.write.attack([5n], { value: parseEther("1") })); // reverts atomically
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.alice.account.address)); // still alice's
    assert.equal(await ctx.publicClient.getBalance({ address: ctx.market.address }), 0n); // nothing stuck
  });

  // --- audit regressions -------------------------------------------------

  it("merging into a listed rock voids the listing instead of selling the grown rock cheap", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await ownRock(ctx, 200n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("0.5"), await soon(ctx)]);
    assert.equal(await ctx.rock.read.mass([5n]), 21000n);

    // alice's own merge grows #5 under her live listing; nothing about custody or approval changes
    await (await asRock(ctx, ctx.alice)).write.merge([5n, 200n, 0]);
    assert.equal(await ctx.rock.read.mass([5n]), 42000n);
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.alice.account.address));
    assert.equal(await ctx.rock.read.isApprovedForAll([ctx.alice.account.address, ctx.market.address]), true);

    // the 2x rock is NOT for sale at the 1x price any more
    await assert.rejects((await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") }));
    await ctx.market.write.pruneListing([5n]); // and the drifted listing is prunable
    assert.equal(lower((await ctx.market.read.listings([5n]))[0]), zeroAddress);
  });

  // The deliberate gap in the mass snapshot, pinned so it stays deliberate: absorb moves `dust`
  // and not `mass`, so it slips past the check. That is the accepted trade. Dust is unlimited tail
  // supply worth ~nothing each, and catching it would cost a second staticcall on every buy.
  it("absorbing dust into a listed rock does NOT void it (dust moves no mass, and is worth ~nothing)", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("0.5"), await soon(ctx)]);
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
    await (await asMock(ctx, ctx.alice)).write.mint([10000n]);
    await (await asMock(ctx, ctx.alice)).write.giftRock([10000n, warden]);
    await (await asRock(ctx, ctx.alice)).write.absorb([10000n, 5n]);
    assert.equal(await ctx.rock.read.dust([5n]), 1n);
    // dust does not move mass, so this listing survives by design: dust is worth ~nothing
    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") });
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.bob.account.address));
  });

  it("an expired listing cannot be bought, and a rewrapped rock cannot revive one", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("0.5"), await soon(ctx, HOUR)]);

    // unwrap burns the token: operator approval survives the burn, so only expiry saves her
    await (await asRock(ctx, ctx.alice)).write.unwrap([5n]);
    await warp(ctx, 2 * HOUR);
    const warden = await ctx.rock.read.wardens([ctx.alice.account.address]);
    await (await asMock(ctx, ctx.alice)).write.giftRock([5n, warden]);
    await (await asRock(ctx, ctx.alice)).write.wrap([5n]); // identical rock is back, alice owns it again
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(ctx.alice.account.address));
    assert.equal(await ctx.rock.read.isApprovedForAll([ctx.alice.account.address, ctx.market.address]), true);

    // the dormant listing is dead rather than re-armed at the stale price
    await assert.rejects((await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("0.5") }));
    await ctx.market.write.pruneListing([5n]);
  });

  it("rejects a listing that expires in the past", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await assert.rejects((await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx, -HOUR)]));
  });

  it("a bidder that cannot receive ERC-721 gets no veto over the seller", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    const trap = await ctx.viem.deployContract("NonReceiverBidder", [ctx.market.address]);
    await trap.write.bid([5n], { value: parseEther("1") });
    assert.equal(lower((await ctx.market.read.bids([5n]))[0]), lower(trap.address));

    // under safeTransferFrom this accept would revert forever and freeze the single bid slot
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.acceptOffer([5n, parseEther("1")]);
    assert.equal(lower(await ctx.rock.read.ownerOf([5n])), lower(trap.address));
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.alice.account.address]), parseEther("1"));
  });

  it("emits Unlisted when acceptOffer kills a third party's listing", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("2"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.bob)).write.makeOffer([5n], { value: parseEther("1") });
    await (await asMarket(ctx, ctx.alice)).write.acceptOffer([5n, parseEther("1")]);

    const unlisted = await ctx.publicClient.getContractEvents({
      address: ctx.market.address,
      abi: ctx.market.abi,
      eventName: "Unlisted",
      fromBlock: 0n,
    });
    assert.equal(unlisted.length, 1); // the listing's death is in the log, not just in storage
    assert.equal(lower(unlisted[0].args.seller as string), lower(ctx.alice.account.address));
  });

  it("emits OfferWithdrawn when a buyer's own bid is refunded by buy", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.bob)).write.makeOffer([5n], { value: parseEther("0.4") });
    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("1") }); // bob buys outright

    const withdrawn = await ctx.publicClient.getContractEvents({
      address: ctx.market.address,
      abi: ctx.market.abi,
      eventName: "OfferWithdrawn",
      fromBlock: 0n,
    });
    assert.equal(withdrawn.length, 1);
    assert.equal(withdrawn[0].args.amount, parseEther("0.4"));
    assert.equal(await ctx.market.read.pendingWithdrawals([ctx.bob.account.address]), parseEther("0.4")); // refunded
  });

  // --- serverless reads --------------------------------------------------

  it("bitmaps expose the whole live book in one call per side", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);
    await ownRock(ctx, 300n, ctx.alice); // lands in word 1, bit 44
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.alice)).write.list([300n, parseEther("2"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.bob)).write.makeOffer([300n], { value: parseEther("0.5") });

    assert.deepEqual(bitsSet(await ctx.market.read.listedBitmap()), [5, 300]);
    assert.deepEqual(bitsSet(await ctx.market.read.bidBitmap()), [300]);

    // and the ids the bitmap names batch-read in one more call
    const ls = await ctx.market.read.getListings([[5n, 300n]]);
    assert.equal(ls[0].price, parseEther("1"));
    assert.equal(ls[1].price, parseEther("2"));

    await (await asMarket(ctx, ctx.alice)).write.cancelListing([5n]);
    assert.deepEqual(bitsSet(await ctx.market.read.listedBitmap()), [300]); // cleared on cancel
    await (await asMarket(ctx, ctx.bob)).write.withdrawOffer([300n]);
    assert.deepEqual(bitsSet(await ctx.market.read.bidBitmap()), []); // cleared on withdraw
  });

  it("records last sale, and the sale log walks back as a linked list", async () => {
    const ctx = await setup();
    await ownRock(ctx, 5n, ctx.alice);

    // sale 1: alice -> bob at 1 ETH (a listing)
    await (await asRock(ctx, ctx.alice)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.alice)).write.list([5n, parseEther("1"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.bob)).write.buy([5n], { value: parseEther("1") });

    // sale 2: bob -> carol at 2 ETH (an accepted bid, so the chain spans both sale paths)
    await (await asRock(ctx, ctx.bob)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.carol)).write.makeOffer([5n], { value: parseEther("2") });
    await (await asMarket(ctx, ctx.bob)).write.acceptOffer([5n, parseEther("2")]);

    // sale 3: carol -> alice at 3 ETH
    await (await asRock(ctx, ctx.carol)).write.setApprovalForAll([ctx.market.address, true]);
    await (await asMarket(ctx, ctx.carol)).write.list([5n, parseEther("3"), await soon(ctx)]);
    await (await asMarket(ctx, ctx.alice)).write.buy([5n], { value: parseEther("3") });

    // one batch call gives a gallery its "last sold for X"
    const [s] = await ctx.market.read.getLastSales([[5n]]);
    assert.equal(s.price, parseEther("3"));
    assert.equal(s.count, 3);
    assert.ok(s.blockNum > 0);

    // walk the log back from the head, one single-block query per hop, exactly as a static page would
    const prices: bigint[] = [];
    let head = s.blockNum;
    while (head > 0) {
      const logs = await ctx.publicClient.getContractEvents({
        address: ctx.market.address,
        abi: ctx.market.abi,
        fromBlock: BigInt(head),
        toBlock: BigInt(head),
      });
      const sales = logs.filter(
        (l) => (l.eventName === "Bought" || l.eventName === "OfferAccepted") && (l.args as any).tokenId === 5n,
      );
      assert.ok(sales.length > 0, `no sale found at block ${head}`);
      for (const sale of sales) prices.push(((sale.args as any).price ?? (sale.args as any).amount) as bigint);
      // take the SMALLEST prevBlock, which is what makes same-block sales terminate
      head = Math.min(...sales.map((sale) => Number((sale.args as any).prevBlock)));
    }
    assert.deepEqual(prices, [parseEther("3"), parseEther("2"), parseEther("1")]); // newest to oldest, no scanning
  });
});
