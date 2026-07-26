// End-to-end proof that the frontend's hand-built calldata (frontend/abi.js) drives the REAL
// deployed contracts through a full trade lifecycle, and that its decoders parse real return data
// and real logs. This mirrors exactly how frontend/app.js constructs each call, so a wrong
// selector, arg order, value, or decoder fails here rather than in a user's wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress } from "viem";
import { ABI } from "../frontend/src/lib/abi.js";
import { approveCall, listCall, listToCall, acceptOfferCall } from "../frontend/src/lib/marketCalls.js";

// mirror app.js's calldata helpers 1:1
const cd = (sel: string, ...w: string[]) => ABI.encodeCall(sel, w);
const U = (v: any) => ABI.uintWord(v);
const AD = (a: string) => ABI.addrWord(a);

describe("frontend calldata drives the real contracts", () => {
  it("wrap → list → buy → offer → accept, with serverless reads and a log history walk", async () => {
    const { viem } = await network.create();
    const [alice, bob, carol] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();
    const mock = await viem.deployContract("MockEtherRock");
    const renderer = await viem.deployContract("EthereumRockRenderer");
    const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
    const market = await viem.deployContract("EthereumRockMarket", [rock.address]);
    const ROCK = rock.address, MKT = market.address;

    // raw read/write mirroring app.js's raw()/ethCall()/send()
    const call = (to: string, data: string) => pub.request({ method: "eth_call", params: [{ to, data }, "latest"] } as any) as Promise<string>;
    const txAlice = (to: string, data: string, value?: bigint) => alice.sendTransaction({ to: to as `0x${string}`, data: data as `0x${string}`, value });
    const txBob = (to: string, data: string, value?: bigint) => bob.sendTransaction({ to: to as `0x${string}`, data: data as `0x${string}`, value });
    const txCarol = (to: string, data: string, value?: bigint) => carol.sendTransaction({ to: to as `0x${string}`, data: data as `0x${string}`, value });
    const mine = async (h: any) => pub.waitForTransactionReceipt({ hash: h });

    const lower = (a: string) => a.toLowerCase();
    const ownerOf = async (id: bigint) => ABI.wAddr(ABI.words(await call(ROCK, cd(ABI.SEL.ownerOf, U(id))))[0]);
    const chainTime = async () => Number(BigInt((await pub.getBlock()).timestamp));

    // --- wrap rock #5 as alice, all via frontend calldata ---
    await mine(await txAlice(ROCK, cd(ABI.SEL.createWarden)));
    const warden = ABI.wAddr(ABI.words(await call(ROCK, cd(ABI.SEL.wardens, AD(alice.account.address))))[0]);
    assert.notEqual(lower(warden), zeroAddress);
    await mock.write.mint([5n]); // pre-existing raw rock (out of frontend scope)
    await mine(await txAlice(mock.address, cd(ABI.SEL.giftRock, U(5), AD(warden)))); // frontend giftRock → warden
    await mine(await txAlice(ROCK, cd(ABI.SEL.wrap, U(5))));
    assert.equal(lower(await ownerOf(5n)), lower(alice.account.address));
    assert.equal(ABI.wBig(ABI.words(await call(ROCK, cd(ABI.SEL.mass, U(5))))[0]), 21000n);

    // --- list #5 at 1 ETH via the frontend's marketCalls builders (the one-click list path) ---
    const approveA = approveCall(ROCK, MKT);
    await mine(await txAlice(approveA.to, approveA.data));
    const expiry = (await chainTime()) + 30 * 86400;
    const listC = listCall(MKT, 5, ABI.parseEther("1"), expiry);
    await mine(await txAlice(listC.to, listC.data));

    // --- serverless book read: bitmap → decode bits → getListings → decode structs ---
    const lids = ABI.bitsOf(ABI.decodeFixedUintArray(await call(MKT, ABI.SEL.listedBitmap), 40));
    assert.deepEqual(lids, [5]);
    const listings = ABI.decodeStructArray(await call(MKT, ABI.encodeUintArrayCall(ABI.SEL.getListings, lids.map(BigInt))), ABI.LISTING);
    assert.equal(listings[0].price, ABI.parseEther("1"));
    assert.equal(lower(listings[0].seller), lower(alice.account.address));
    assert.equal(listings[0].massSnap, 21000n);
    assert.equal(listings[0].burnSnap, 0n); // never burned, so the listing is live

    // --- the gallery's art read: one call for the page, decoded by the frontend's string[] path ---
    const uris = ABI.decodeStringArray(
      await call(ROCK, ABI.encodeUintArrayCall(ABI.SEL.tokenURIBatch, [5n, 6n])),
    );
    assert.equal(uris.length, 2);
    assert.ok(uris[0].startsWith("data:application/json;base64,"));
    assert.equal(JSON.parse(atob(uris[0].slice(uris[0].indexOf(",") + 1))).name, "EthereumRock #5");
    assert.equal(uris[1], ""); // #6 is not wrapped: an empty entry, not a reverted page

    // --- bob buys at the on-chain price (frontend reads listing.price, sends it as value) ---
    const l = ABI.decodeStruct(await call(MKT, cd(ABI.SEL.listings, U(5))), ABI.LISTING);
    await mine(await txBob(MKT, cd(ABI.SEL.buy, U(5)), l.price));
    assert.equal(lower(await ownerOf(5n)), lower(bob.account.address));

    // --- carol bids 2 ETH, bob accepts (frontend acceptOffer with minAmount) ---
    await mine(await txCarol(MKT, cd(ABI.SEL.makeOffer, U(5)), ABI.parseEther("2")));
    const bids = ABI.bitsOf(ABI.decodeFixedUintArray(await call(MKT, ABI.SEL.bidBitmap), 40));
    assert.deepEqual(bids, [5]);
    const approveB = approveCall(ROCK, MKT);
    await mine(await txBob(approveB.to, approveB.data));
    const acceptC = acceptOfferCall(MKT, 5, ABI.parseEther("2"));
    await mine(await txBob(acceptC.to, acceptC.data));
    assert.equal(lower(await ownerOf(5n)), lower(carol.account.address));

    // --- tokenURI decodes to an on-chain data URI ---
    const uri = ABI.decodeString(await call(ROCK, cd(ABI.SEL.tokenURI, U(5))));
    assert.ok(uri.startsWith("data:application/json;base64,"));

    // --- lastSale + the log linked-list walk, exactly as app.js history() does ---
    const sale = ABI.decodeStruct(await call(MKT, cd(ABI.SEL.lastSale, U(5))), ABI.SALEINFO);
    assert.equal(sale.count, 2n);
    assert.equal(sale.price, ABI.parseEther("2"));

    // cumulative market volume = 1 ETH (buy) + 2 ETH (accepted offer)
    assert.equal(ABI.wBig(ABI.words(await call(MKT, cd(ABI.SEL.totalVolume)))[0]), ABI.parseEther("3"));

    const prices: bigint[] = [];
    let head = Number(sale.blockNum);
    const idTopic = "0x" + ABI.uintWord(5);
    let hops = 0;
    while (head > 0 && hops < 100) {
      hops++;
      const logs: any[] = await pub.request({
        method: "eth_getLogs",
        params: [{ address: MKT, fromBlock: ABI.hexQuantity(head), toBlock: ABI.hexQuantity(head), topics: [[ABI.TOPIC.Bought, ABI.TOPIC.OfferAccepted], idTopic] }],
      } as any);
      if (!logs.length) break;
      let next = 0;
      for (const lg of logs) {
        const dw = ABI.words(lg.data);
        prices.push(ABI.wBig(dw[0]));
        const prev = ABI.wNum(dw[1]);
        if (next === 0 || prev < next) next = prev;
      }
      head = next;
    }
    assert.deepEqual(prices, [ABI.parseEther("2"), ABI.parseEther("1")]); // newest → oldest, no scanning

    // --- private sale: carol (now the owner) lists #5 only to alice, via the listToCall builder ---
    const approveC = approveCall(ROCK, MKT);
    await mine(await txCarol(approveC.to, approveC.data));
    const privExpiry = (await chainTime()) + 30 * 86400;
    const listToC = listToCall(MKT, 5, ABI.parseEther("4"), privExpiry, alice.account.address);
    await mine(await txCarol(listToC.to, listToC.data));

    // the listing records the private recipient, so a frontend can show "private to 0x…"
    const priv = ABI.decodeStruct(await call(MKT, cd(ABI.SEL.listings, U(5))), ABI.LISTING);
    assert.equal(lower(priv.onlyTo), lower(alice.account.address));

    // bob is not the named buyer, so his buy reverts even at the exact price. The revert surfaces
    // during gas estimation inside sendTransaction, so the whole send has to sit in the thunk.
    await assert.rejects(async () => mine(await txBob(MKT, cd(ABI.SEL.buy, U(5)), priv.price)));
    assert.equal(lower(await ownerOf(5n)), lower(carol.account.address)); // still carol's

    // alice, the named buyer, can take it
    await mine(await txAlice(MKT, cd(ABI.SEL.buy, U(5)), priv.price));
    assert.equal(lower(await ownerOf(5n)), lower(alice.account.address));
    assert.equal(ABI.wBig(ABI.words(await call(MKT, cd(ABI.SEL.totalVolume)))[0]), ABI.parseEther("7")); // 3 + 4
  });

  it("tokensOfOwner is the account 'your rocks' read: real calldata in, decodeUintArray out", async () => {
    const { viem } = await network.create();
    const [alice, bob] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();
    const mock = await viem.deployContract("MockEtherRock");
    const renderer = await viem.deployContract("EthereumRockRenderer");
    const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
    const ROCK = rock.address;
    const call = (to: string, data: string) => pub.request({ method: "eth_call", params: [{ to, data }, "latest"] } as any) as Promise<string>;
    const mine = (h: any) => pub.waitForTransactionReceipt({ hash: h });
    const wardenOf = async (a: string) => ABI.wAddr(ABI.words(await call(ROCK, cd(ABI.SEL.wardens, AD(a))))[0]);

    const wrapFor = async (who: typeof alice, id: number) => {
      const warden = await wardenOf(who.account.address);
      await mock.write.mint([BigInt(id)], { account: who.account });
      await mock.write.giftRock([BigInt(id), warden], { account: who.account });
      await mine(await who.sendTransaction({ to: ROCK as `0x${string}`, data: cd(ABI.SEL.wrap, U(id)) as `0x${string}` }));
    };
    await mine(await alice.sendTransaction({ to: ROCK as `0x${string}`, data: cd(ABI.SEL.createWarden) as `0x${string}` }));
    await mine(await bob.sendTransaction({ to: ROCK as `0x${string}`, data: cd(ABI.SEL.createWarden) as `0x${string}` }));
    for (const id of [256, 0, 9999]) await wrapFor(alice, id); // spread across bitmap words
    await wrapFor(bob, 42);

    // the EXACT read rocksOwnedBy() now makes: eth_call tokensOfOwner(addr) -> decodeUintArray
    const owned = ABI.decodeUintArray(await call(ROCK, cd(ABI.SEL.tokensOfOwner, AD(alice.account.address)))).map(Number);
    assert.deepEqual(owned, [0, 256, 9999]);
    // the paginated backstop, same decoder
    const bobOwned = ABI.decodeUintArray(await call(ROCK, cd(ABI.SEL.tokensOfOwnerIn, AD(bob.account.address), U(0), U(10000)))).map(Number);
    assert.deepEqual(bobOwned, [42]);
    // a nonzero address holding nothing decodes to [] (not a throw), so the account page shows empty
    const none = ABI.decodeUintArray(await call(ROCK, cd(ABI.SEL.tokensOfOwner, AD("0x000000000000000000000000000000000000dEaD"))));
    assert.deepEqual(none, []);
  });
});
