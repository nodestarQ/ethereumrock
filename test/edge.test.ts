// Edge-case and revert-path coverage for the guard rails the happy-path suite doesn't exercise:
// every require/custom-error branch that protects a user, plus renderer trait correctness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, maxUint256, toFunctionSelector, padHex, toHex } from "viem";

const lower = (a: string) => a.toLowerCase();

describe("edge cases and revert paths", () => {
  async function deploy() {
    const conn = await network.create();
    const { viem } = conn;
    const [a, b, c] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();
    const mock = await viem.deployContract("MockEtherRock");
    const renderer = await viem.deployContract("EthereumRockRenderer");
    const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
    const market = await viem.deployContract("EthereumRockMarket", [rock.address]);
    return { conn, viem, a, b, c, pub, mock, renderer, rock, market };
  }

  // Wrap `id` to `acct` via the hardened flow (lock at max, gift into warden, wrap).
  async function wrapFor(ctx: any, acct: any, id: bigint) {
    const { mock, rock } = ctx;
    await mock.write.mint([id], { account: acct.account });
    let warden: string = await rock.read.wardens([acct.account.address]);
    if (warden === zeroAddress) {
      await rock.write.createWarden({ account: acct.account });
      warden = await rock.read.wardens([acct.account.address]);
    }
    await mock.write.sellRock([id, maxUint256], { account: acct.account });
    await mock.write.giftRock([id, warden], { account: acct.account });
    await rock.write.wrap([id], { account: acct.account });
  }

  const future = async (pub: any) => BigInt(Number((await pub.getBlock()).timestamp) + 30 * 86400);
  const ETH = 10n ** 18n;

  it("EthereumRock: wrap / merge / absorb guard rails revert", async () => {
    const ctx = await deploy();
    const { a, b, rock } = ctx;

    await rock.write.createWarden({ account: a.account });
    await assert.rejects(rock.write.createWarden({ account: a.account })); // warden exists

    await assert.rejects(rock.write.wrap([10000n], { account: a.account })); // id >= MAX_ID
    await assert.rejects(rock.write.wrap([5n], { account: b.account })); // no warden

    await wrapFor(ctx, a, 150n);
    await wrapFor(ctx, a, 151n);
    await wrapFor(ctx, a, 40n);
    await wrapFor(ctx, a, 41n);

    await assert.rejects(rock.write.merge([150n, 150n, 0], { account: a.account })); // same id
    await assert.rejects(rock.write.merge([150n, 151n, 0], { account: b.account })); // not owner
    await assert.rejects(rock.write.merge([40n, 41n, 0], { account: a.account })); // high 41 < 100, cannot burn

    // a 0-99 rock MAY survive absorbing a 100+ rock: merge(40, 150) keeps 40, burns 150
    await rock.write.merge([40n, 150n, 0], { account: a.account });
    assert.equal(Number(await rock.read.mass([40n])), 42000); // 21000 + 21000 conserved
    await assert.rejects(rock.read.ownerOf([150n])); // 150 burned

    await assert.rejects(rock.write.absorb([9999n, 151n], { account: a.account })); // not dust (< MAX_ID)
    await assert.rejects(rock.write.absorb([10000n, 999n], { account: a.account })); // intoId not owned
    await assert.rejects(rock.write.rescue([7n], { account: b.account })); // no warden

    // onERC721Received is only callable by the two known wrappers (both zero here), never directly
    await assert.rejects(
      rock.write.onERC721Received([a.account.address, a.account.address, 1n, "0x"], { account: a.account }),
    );
  });

  // one bit per id, so a frontend can enumerate the whole live collection in a single call
  const bitsOf = (words: readonly bigint[]) => {
    const out: number[] = [];
    words.forEach((w, i) => {
      let v = w, b = 0;
      while (v > 0n) { if (v & 1n) out.push(i * 256 + b); v >>= 1n; b++; }
    });
    return out;
  };

  it("EthereumRock: wrappedBitmap tracks exactly the live token set", async () => {
    const ctx = await deploy();
    const { a, b, rock } = ctx;
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), []);

    await wrapFor(ctx, a, 42n);
    await wrapFor(ctx, a, 500n);
    await wrapFor(ctx, a, 501n);
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), [42, 500, 501]);

    // a plain transfer must not touch the bitmap
    await rock.write.transferFrom([a.account.address, b.account.address, 42n], { account: a.account });
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), [42, 500, 501]);

    // unwrap burns the token, clearing its bit
    await rock.write.unwrap([500n], { account: a.account });
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), [42, 501]);

    // merge burns the higher id only
    await wrapFor(ctx, a, 502n);
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), [42, 501, 502]);
    await rock.write.merge([501n, 502n, 0], { account: a.account });
    assert.deepEqual(bitsOf(await rock.read.wrappedBitmap()), [42, 501]);
  });

  it("EthereumRockMarket: listing / bid / withdraw guard rails revert", async () => {
    const ctx = await deploy();
    const { a, b, c, pub, rock, market } = ctx;
    await wrapFor(ctx, a, 300n);
    const exp = await future(pub);
    const MKT = market.address;

    await assert.rejects(market.write.list([300n, ETH, exp], { account: a.account })); // NotApproved
    await rock.write.setApprovalForAll([MKT, true], { account: a.account });

    await assert.rejects(market.write.list([300n, 0n, exp], { account: a.account })); // ZeroPrice
    await assert.rejects(market.write.list([10000n, ETH, exp], { account: a.account })); // BadId
    await assert.rejects(market.write.list([300n, ETH, 1n], { account: a.account })); // BadExpiry (past)
    await assert.rejects(market.write.list([300n, ETH, exp], { account: b.account })); // NotOwner
    await assert.rejects(market.write.listTo([300n, ETH, exp, zeroAddress], { account: a.account })); // ZeroBuyer

    await market.write.list([300n, ETH, exp], { account: a.account });
    await assert.rejects(market.write.buy([300n], { account: b.account, value: 1n })); // WrongPrice
    await assert.rejects(market.write.buy([301n], { account: b.account, value: 0n })); // NotListed
    await assert.rejects(market.write.cancelListing([300n], { account: b.account })); // NotSeller
    await assert.rejects(market.write.pruneListing([300n], { account: b.account })); // StillValid

    await assert.rejects(market.write.makeOffer([300n], { account: b.account, value: 0n })); // ZeroBid
    await market.write.makeOffer([300n], { account: b.account, value: ETH / 10n });
    // BidTooLow applies to a THIRD party only: the same bidder sending more is a top-up, not a
    // competing bid, so it has nothing to beat
    await assert.rejects(market.write.makeOffer([300n], { account: c.account, value: ETH / 10n })); // BidTooLow (not >)
    await assert.rejects(market.write.makeOffer([300n], { account: b.account, value: 0n })); // still ZeroBid
    await assert.rejects(market.write.withdrawOffer([300n], { account: a.account })); // NotBidder
    await assert.rejects(market.write.acceptOffer([300n, ETH], { account: a.account })); // BelowMin
    await assert.rejects(market.write.withdraw({ account: b.account })); // Nothing owed
  });

  // The market packs every amount into a uint96: Listing.price, Bid.amount, SaleInfo.price. That
  // holds 79,228,162,514.264337593543950335 ETH, roughly 657x the entire ETH supply, so on a real
  // chain no payment can get anywhere near the ceiling and `BidTooLarge` is unreachable.
  // A simulated chain can mint past it, which is the only way to exercise the boundary at all: the
  // one uint256 -> uint96 downcast in the contract (makeOffer), and the ABI decoder that has to
  // refuse an oversize listing price rather than silently truncate it.
  const MAX96 = 2n ** 96n - 1n;

  it("EthereumRockMarket: a price at the uint96 ceiling round-trips, and past it reverts", async () => {
    const ctx = await deploy();
    const { conn, a, b, pub, rock, market } = ctx;
    await wrapFor(ctx, a, 300n);
    await rock.write.setApprovalForAll([market.address, true], { account: a.account });
    const exp = await future(pub);

    // Fund the buyer past the ceiling. No real chain has this much ETH, which is the point.
    await conn.provider.request({
      method: "hardhat_setBalance",
      params: [b.account.address, "0x" + (2n ** 100n).toString(16)],
    });

    // A listing at exactly the ceiling sells, and every packed field survives the trip.
    await market.write.list([300n, MAX96, exp], { account: a.account });
    assert.equal((await market.read.listings([300n]))[1], MAX96);
    await market.write.buy([300n], { account: b.account, value: MAX96 });
    assert.equal(lower(await rock.read.ownerOf([300n])), lower(b.account.address));
    assert.equal(await market.read.pendingWithdrawals([a.account.address]), MAX96);
    assert.equal(await market.read.totalVolume(), MAX96);
    assert.equal((await market.read.lastSale([300n]))[0], MAX96); // SaleInfo.price, not truncated

    // Bids: the ceiling applies to the resulting TOTAL, so both ways of reaching it must revert.
    // 301 is unwrapped, which makeOffer allows (it only bounds the id), so the escrow here stays
    // independent of the sale above. Matched by error name rather than "it threw at all", because
    // the bidder is funded far past these amounts and a bare rejection could be hiding an
    // out-of-funds failure that proves nothing about the guard.
    await assert.rejects(
      market.write.makeOffer([301n], { account: b.account, value: MAX96 + 1n }),
      /BidTooLarge/,
    );
    await market.write.makeOffer([301n], { account: b.account, value: MAX96 }); // exactly the ceiling is fine
    assert.equal((await market.read.bids([301n]))[1], MAX96);
    // A 1-wei top-up on a maxed bid overflows the TOTAL, so it reverts despite the tiny msg.value.
    await assert.rejects(market.write.makeOffer([301n], { account: b.account, value: 1n }), /BidTooLarge/);

    // Nothing is stranded at the ceiling: the maxed escrow comes back out, and so do the proceeds.
    await market.write.withdrawOffer([301n], { account: b.account });
    assert.equal((await market.read.bids([301n]))[1], 0n);
    await market.write.withdraw({ account: a.account });
    assert.equal(await pub.getBalance({ address: market.address }), 0n);
  });

  it("EthereumRockMarket: an oversize listing price is refused by the decoder, not truncated", async () => {
    const ctx = await deploy();
    const { a, pub, rock, market } = ctx;
    await wrapFor(ctx, a, 300n);
    await rock.write.setApprovalForAll([market.address, true], { account: a.account });
    const exp = await future(pub);

    // Hand-built calldata, because an encoder that knows the ABI would reject an out-of-range uint96
    // before it ever hit the chain. The frontend's own encoder pads every argument to a full 32-byte
    // word without masking to the declared width, so what protects a seller from a truncated price
    // is Solidity's decoder rejecting the dirty upper bits. Test that, don't assume it.
    const sel = toFunctionSelector("list(uint256,uint96,uint40)");
    const word = (v: bigint) => padHex(toHex(v), { size: 32 }).slice(2);
    const raw = (price: bigint) => (sel + word(300n) + word(price) + word(exp)) as `0x${string}`;

    // 2^96 + 1 ETH truncates to exactly 1 ETH, so a decoder that let this through would quietly
    // list a rock for 1 ETH that its owner priced above the entire ETH supply. It must revert.
    await assert.rejects(a.sendTransaction({ to: market.address, data: raw(2n ** 96n + ETH) }));
    assert.equal(lower((await market.read.listings([300n]))[0]), zeroAddress); // no listing was created

    // Control: identical calldata with a price that fits does list. Without this the test above
    // could be passing on a malformed selector or argument order rather than on the price.
    await a.sendTransaction({ to: market.address, data: raw(ETH) });
    assert.equal((await market.read.listings([300n]))[1], ETH);
  });

  it("EthereumRockRenderer: traits reflect id, status, and size band", async () => {
    const ctx = await deploy();
    const { a, rock } = ctx;

    // collection identity as marketplaces read it
    assert.equal(await rock.read.name(), "EthereumRock");
    assert.equal(await rock.read.symbol(), "EROCK");

    await wrapFor(ctx, a, 42n); // DEFINED (0-99)
    await wrapFor(ctx, a, 500n); // UNDEFINED (100+)

    const decode = (uri: string) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    const trait = (m: any, t: string) => m.attributes.find((x: any) => x.trait_type === t)?.value;

    const m42 = decode(await rock.read.tokenURI([42n]));
    assert.equal(m42.name, "EthereumRock #42");
    assert.ok(m42.image.startsWith("data:image/svg+xml;base64,"));
    assert.equal(trait(m42, "Status"), "DEFINED");
    assert.equal(trait(m42, "Size"), 100);
    assert.equal(trait(m42, "Mass"), 21000);
    assert.equal(trait(m42, "Id"), 42);

    const m500 = decode(await rock.read.tokenURI([500n]));
    assert.equal(trait(m500, "Status"), "UNDEFINED");
    const size = trait(m500, "Size");
    assert.ok(size >= 67 && size <= 90, "size in [67,90], got " + size);
    assert.match(trait(m500, "Color"), /^#[0-9a-f]{6}$/); // Color is a #rrggbb hex string

    await assert.rejects(rock.read.tokenURI([9999n])); // nonexistent id
  });
});
