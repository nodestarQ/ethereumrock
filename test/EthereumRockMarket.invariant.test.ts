// Stateful invariant campaign against EthereumRockMarket.
//
// The property that matters most here is unrecoverable if it ever breaks: the market has no owner
// and no upgrade path, so ETH that the ledger does not account for is stuck in the contract forever
// with nobody able to sweep it. The example tests assert the balance returns to zero in two
// single-sale scenarios; this drives long random sequences instead and re-checks the identity
//
//     address(market).balance == sum(pendingWithdrawals) + sum(live bid escrow)
//
// after EVERY call, successful or reverted, then drains the whole book at the end of each sequence
// and asserts the balance reaches exactly zero. That last step is the real statement: not just that
// the books balance, but that every wei in the contract is reachable by the address it belongs to.
//
// It also fuzzes the rock underneath the market, because EthereumRock is not a static ERC-721 and
// the seam between them is where this project's audits found every real bug. Transfers, merges and
// unwraps strand listings mid-sequence, which is what pushes buy/acceptOffer down their revert
// paths while funds are in flight.
//
// Deterministic: every run is driven by a seeded PRNG, so a failure reprints the exact seed and the
// full action log needed to replay it. Size is env-tunable for a longer campaign:
//
//     FUZZ_SEED=7 FUZZ_SEQUENCES=40 FUZZ_ACTIONS=200 npx hardhat test test/EthereumRockMarket.invariant.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { zeroAddress, parseEther, formatEther } from "viem";

const SEED = Number(process.env.FUZZ_SEED ?? 1);
const SEQUENCES = Number(process.env.FUZZ_SEQUENCES ?? 6);
const ACTIONS = Number(process.env.FUZZ_ACTIONS ?? 120);

// Three ids below 100 (never burnable, so they always survive as merge targets) and seven above.
// Merges permanently consume rocks, so the set is sized to keep a live book for a long sequence.
const ALL_IDS = [1, 7, 42, 101, 202, 303, 404, 555, 606, 707];
const BASE_MASS = 21000n;
const HOUR = 3600;

const lower = (a: string) => a.toLowerCase();

/** mulberry32: small, fast, and reproducible across machines. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same client-side decode a static frontend does: 40 words -> the ids whose bit is set. */
function bitsSet(words: readonly bigint[]): number[] {
  const out: number[] = [];
  words.forEach((w, wi) => {
    for (let b = 0; b < 256; b++) if ((w >> BigInt(b)) & 1n) out.push(wi * 256 + b);
  });
  return out;
}

async function world() {
  const conn = await network.create();
  const { viem } = conn;
  const wallets = (await viem.getWalletClients()).slice(0, 4);
  const publicClient = await viem.getPublicClient();
  const mock = await viem.deployContract("MockEtherRock");
  const renderer = await viem.deployContract("EthereumRockRenderer");
  const rock = await viem.deployContract("EthereumRock", [mock.address, zeroAddress, zeroAddress, renderer.address]);
  const market = await viem.deployContract("EthereumRockMarket", [rock.address]);

  const asRock = (w: any) => viem.getContractAt("EthereumRock", rock.address, { client: { wallet: w } });
  const asMock = (w: any) => viem.getContractAt("MockEtherRock", mock.address, { client: { wallet: w } });
  const asMarket = (w: any) => viem.getContractAt("EthereumRockMarket", market.address, { client: { wallet: w } });

  // every actor gets a warden and approves the market once; the fuzzer revokes and re-grants later
  for (const w of wallets) {
    await (await asRock(w)).write.createWarden();
    await (await asRock(w)).write.setApprovalForAll([market.address, true]);
  }

  // spread the starting rocks across the actors so merges and transfers have somewhere to go
  for (const [i, id] of ALL_IDS.entries()) {
    const w = wallets[i % wallets.length];
    const warden = await rock.read.wardens([w.account.address]);
    await (await asMock(w)).write.mint([BigInt(id)]);
    await (await asMock(w)).write.giftRock([BigInt(id), warden]);
    await (await asRock(w)).write.wrap([BigInt(id)]);
  }

  return { conn, viem, publicClient, wallets, mock, rock, market, asRock, asMock, asMarket };
}
type World = Awaited<ReturnType<typeof world>>;

type Snap = {
  live: number[];
  owned: number[]; // ground truth: the ids ownerOf actually answers for, read independently of the bitmap
  listedBits: number[];
  bidBits: number[];
  owner: Map<number, string>;
  listing: Map<number, any>;
  bid: Map<number, any>;
  pending: bigint[];
  balance: bigint;
  supply: bigint;
  massTotal: bigint;
  now: number;
};

/**
 * One read of everything the chooser and the invariant checker need, ALL PINNED TO ONE BLOCK.
 *
 * The conservation check compares the market's ETH balance against the sum of its own ledger
 * entries. Those numbers only mean anything if they come from the same instant. Reading at "latest"
 * across several awaits let balance and pendingWithdrawals resolve against different points of block
 * production, so a payout in flight could make the balance look short of a ledger that had already
 * been updated (or vice versa), which reads as a phantom insolvency. Everything here is read at an
 * explicit `blockNumber`, so the whole snapshot is one consistent view of the chain.
 */
async function snap(w: World): Promise<Snap> {
  const ids = ALL_IDS.map(BigInt);
  const blockNumber = await w.publicClient.getBlockNumber();
  const at = { blockNumber } as const; // every read below is pinned to this block
  const [liveWords, listedWords, bidWords, balance, supply, block, listingsAll, bidsAll, masses] = await Promise.all([
    w.rock.read.wrappedBitmap(at),
    w.market.read.listedBitmap(at),
    w.market.read.bidBitmap(at),
    w.publicClient.getBalance({ address: w.market.address, blockNumber }),
    w.rock.read.totalSupply(at),
    w.publicClient.getBlock({ blockNumber }),
    w.market.read.getListings([ids], at),
    w.market.read.getBids([ids], at),
    Promise.all(ids.map((id) => w.rock.read.mass([id], at))),
  ]);
  const live = bitsSet(liveWords);
  const [owners, pending] = await Promise.all([
    Promise.all(live.map((id) => w.rock.read.ownerOf([BigInt(id)], at))),
    Promise.all(w.wallets.map((a) => w.market.read.pendingWithdrawals([a.account.address], at))),
  ]);

  // Ground truth for "which ids exist", asked of ownerOf rather than of the bitmap, so the two can
  // be compared against each other. `totalSupply` and `tokensOfOwner` are both derived from the
  // bitmap now, which makes this the check that keeps them honest: nothing else would notice a
  // bitmap that drifted from the token set.
  const probes = await Promise.all(
    ids.map((id) =>
      w.rock.read
        .ownerOf([id], at)
        .then(() => true)
        .catch(() => false),
    ),
  );
  const owned = ALL_IDS.filter((_, i) => probes[i]);

  const owner = new Map<number, string>();
  live.forEach((id, i) => owner.set(id, lower(owners[i] as string)));
  const listing = new Map<number, any>();
  const bid = new Map<number, any>();
  ALL_IDS.forEach((id, i) => {
    listing.set(id, listingsAll[i]);
    bid.set(id, bidsAll[i]);
  });

  return {
    live,
    owned,
    listedBits: bitsSet(listedWords),
    bidBits: bitsSet(bidWords),
    owner,
    listing,
    bid,
    pending: pending as bigint[],
    balance: balance as bigint,
    supply: supply as bigint,
    massTotal: (masses as bigint[]).reduce((a, b) => a + b, 0n),
    now: Number(block.timestamp),
  };
}

/**
 * Every invariant, re-checked after each call. Throws with enough context to replay.
 * The market ones are the point; the rock ones ride along because the same sequence mutates it.
 */
function check(s: Snap, expectedVolume: bigint, volume: bigint, where: string) {
  const fail = (msg: string) => {
    throw new Error(`INVARIANT BROKEN after ${where}\n  ${msg}`);
  };

  // --- the one that cannot be recovered from: every wei is accounted for -----------------------
  const escrowed = ALL_IDS.reduce((sum, id) => sum + BigInt(s.bid.get(id).amount), 0n);
  const credited = s.pending.reduce((a, b) => a + b, 0n);
  if (s.balance !== credited + escrowed) {
    fail(
      `balance ${formatEther(s.balance)} != pending ${formatEther(credited)} + escrow ${formatEther(escrowed)}` +
        ` (drift ${formatEther(s.balance - credited - escrowed)} ETH would be stuck forever)`,
    );
  }

  // --- the book a static frontend reads must match the storage it claims to describe -----------
  const bidIdsFromMap = ALL_IDS.filter((id) => BigInt(s.bid.get(id).amount) > 0n);
  if (JSON.stringify(s.bidBits) !== JSON.stringify(bidIdsFromMap)) {
    fail(`bidBitmap ${JSON.stringify(s.bidBits)} != bids mapping ${JSON.stringify(bidIdsFromMap)}`);
  }
  const listedIdsFromMap = ALL_IDS.filter((id) => lower(s.listing.get(id).seller) !== zeroAddress);
  if (JSON.stringify(s.listedBits) !== JSON.stringify(listedIdsFromMap)) {
    fail(`listedBitmap ${JSON.stringify(s.listedBits)} != listings mapping ${JSON.stringify(listedIdsFromMap)}`);
  }

  // an escrowed bid always names a bidder, and a live listing always names a seller
  for (const id of ALL_IDS) {
    const b = s.bid.get(id);
    if ((BigInt(b.amount) > 0n) !== (lower(b.bidder) !== zeroAddress)) fail(`bid #${id} amount/bidder disagree`);
    const l = s.listing.get(id);
    if (lower(l.seller) !== zeroAddress && BigInt(l.price) === 0n) fail(`listing #${id} priced at zero`);
  }

  // --- the rock underneath -----------------------------------------------------------------
  // The bitmap is the token set, checked against ownerOf rather than against anything derived from
  // the bitmap itself. tokensOfOwner and totalSupply both read from it, so a drift here would be a
  // silent wrong answer everywhere rather than a revert.
  if (s.live.join(",") !== s.owned.join(",")) {
    fail(`wrappedBitmap [${s.live}] != the ids ownerOf answers for [${s.owned}]`);
  }
  if (s.supply !== BigInt(s.owned.length)) {
    fail(`totalSupply ${s.supply} != ${s.owned.length} live tokens`);
  }
  // merge moves mass between ids and unwrap leaves it in place, so the total never moves
  if (s.massTotal !== BASE_MASS * BigInt(ALL_IDS.length)) {
    fail(`total mass ${s.massTotal} != ${BASE_MASS * BigInt(ALL_IDS.length)} (mass is created or destroyed)`);
  }

  // --- the display stat -----------------------------------------------------------------------
  if (volume !== expectedVolume) fail(`totalVolume ${formatEther(volume)} != observed sales ${formatEther(expectedVolume)}`);
}

describe("EthereumRockMarket invariants", () => {
  it(`holds ETH conservation across ${SEQUENCES} random sequences of ${ACTIONS} actions`, async () => {
    const tally: Record<string, number> = {};
    const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const seed = SEED * 1000 + seq;
      const rnd = prng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const w = await world();
      const log: string[] = [];
      let sales = 0n; // every sale price we watched land, to check against totalVolume

      const replay = (extra: string) =>
        `${extra}\n\nseed ${seed} (FUZZ_SEED=${SEED} FUZZ_SEQUENCES=${SEQUENCES} FUZZ_ACTIONS=${ACTIONS})\n` +
        log.map((l, i) => `  ${String(i).padStart(3)} ${l}`).join("\n");

      // an actor index -> wallet, plus the raw v1 rocks an actor is holding after an unwrap
      const wallets = w.wallets;
      const rawHeld = new Map<number, Set<number>>(wallets.map((_, i) => [i, new Set<number>()]));
      const idxOf = (addr: string) => wallets.findIndex((x) => lower(x.account.address) === lower(addr));

      for (let step = 0; step < ACTIONS; step++) {
        const s = await snap(w);
        // check before acting so a broken state is attributed to the call that caused it
        try {
          check(s, sales, (await w.market.read.totalVolume()) as bigint, log.at(-1) ?? "setup");
        } catch (e: any) {
          assert.fail(replay(e.message));
        }

        const listed = s.listedBits.filter((id) => Number(s.listing.get(id).expiry) > s.now);
        const bidded = s.bidBits;
        const creditors = wallets.map((_, i) => i).filter((i) => s.pending[i] > 0n);

        // Weighted so the fund-moving paths land often. A sequence of reverts proves nothing, so
        // most actions are clamped to arguments that should succeed; the rest probe the guards.
        const choices: [string, number][] = [
          ["list", 14],
          ["buy", 12],
          ["makeOffer", 14],
          ["acceptOffer", 10],
          ["withdrawOffer", 8],
          ["withdraw", 10],
          ["cancelListing", 5],
          ["pruneListing", 5],
          ["transfer", 6],
          ["merge", 4],
          ["unwrap", 3],
          ["rewrap", 3],
          ["approval", 3],
          ["warp", 3],
        ];
        const total = choices.reduce((a, [, n]) => a + n, 0);
        let roll = rnd() * total;
        let action = "list";
        for (const [name, n] of choices) {
          if ((roll -= n) < 0) {
            action = name;
            break;
          }
        }

        // A skip is not a test. Counted separately below so the summary can never pass off an
        // idle campaign as a thorough one.
        const SKIP = `${action}: skipped (no valid target)`;
        let did = SKIP;
        try {
          switch (action) {
            case "list": {
              if (!s.live.length) break;
              const id = pick(s.live);
              const seller = wallets[idxOf(s.owner.get(id)!)];
              const price = parseEther((0.01 + rnd() * 2).toFixed(4));
              // mostly a valid future expiry; sometimes already past, which must be rejected
              const expiry = rnd() < 0.9 ? s.now + Math.floor(1 + rnd() * 3 * HOUR) : s.now - HOUR;
              const priv = rnd() < 0.15 ? pick(wallets).account.address : null;
              const m = await w.asMarket(seller);
              if (priv) await m.write.listTo([BigInt(id), price, expiry, priv]);
              else await m.write.list([BigInt(id), price, expiry]);
              did = `list #${id} @${formatEther(price)} by a${idxOf(s.owner.get(id)!)}${priv ? " private" : ""}`;
              bump("list");
              break;
            }
            case "buy": {
              if (!listed.length) break;
              const id = pick(listed);
              const l = s.listing.get(id);
              const candidates = wallets.filter((x) => lower(x.account.address) !== lower(l.seller));
              const buyer =
                lower(l.onlyTo) !== zeroAddress
                  ? wallets.find((x) => lower(x.account.address) === lower(l.onlyTo))
                  : pick(candidates);
              if (!buyer) break;
              // usually the exact price (the only value that can succeed), sometimes wrong on purpose
              const value = rnd() < 0.9 ? BigInt(l.price) : BigInt(l.price) + 1n;
              await (await w.asMarket(buyer)).write.buy([BigInt(id)], { value });
              sales += BigInt(l.price);
              did = `buy #${id} @${formatEther(BigInt(l.price))} by a${idxOf(buyer.account.address)}`;
              bump("buy");
              break;
            }
            case "makeOffer": {
              const id = pick(ALL_IDS);
              const b = s.bid.get(id);
              const standing = BigInt(b.amount);
              const bidder = pick(wallets);
              const mine = standing > 0n && lower(b.bidder) === lower(bidder.account.address);
              // Topping up your OWN bid needs only a positive amount, because the escrow already
              // there counts toward the total and never leaves the contract. Outbidding someone
              // else still has to beat the whole standing total.
              const value = mine
                ? parseEther((0.01 + rnd() * 0.3).toFixed(4))
                : rnd() < 0.9
                  ? standing + parseEther((0.01 + rnd() * 0.5).toFixed(4))
                  : standing > 0n
                    ? standing / 2n
                    : 0n;
              await (await w.asMarket(bidder)).write.makeOffer([BigInt(id)], { value });
              did = `${mine ? "topUp" : "makeOffer"} #${id} +${formatEther(value)} by a${idxOf(bidder.account.address)}`;
              bump(mine ? "topUp" : "makeOffer");
              break;
            }
            case "acceptOffer": {
              const withBid = bidded.filter((id) => s.owner.has(id));
              if (!withBid.length) break;
              const id = pick(withBid);
              const seller = wallets[idxOf(s.owner.get(id)!)];
              const amount = BigInt(s.bid.get(id).amount);
              const min = rnd() < 0.8 ? 0n : amount;
              await (await w.asMarket(seller)).write.acceptOffer([BigInt(id), min]);
              sales += amount;
              did = `acceptOffer #${id} @${formatEther(amount)} by a${idxOf(seller.account.address)}`;
              bump("acceptOffer");
              break;
            }
            case "withdrawOffer": {
              if (!bidded.length) break;
              const id = pick(bidded);
              const b = s.bid.get(id);
              // usually the real bidder (the only one who can), sometimes anyone
              const caller = rnd() < 0.85 ? wallets[idxOf(b.bidder)] : pick(wallets);
              if (!caller) break;
              await (await w.asMarket(caller)).write.withdrawOffer([BigInt(id)]);
              did = `withdrawOffer #${id} by a${idxOf(caller.account.address)}`;
              bump("withdrawOffer");
              break;
            }
            case "withdraw": {
              if (!creditors.length) break;
              const i = pick(creditors);
              await (await w.asMarket(wallets[i])).write.withdraw();
              did = `withdraw ${formatEther(s.pending[i])} by a${i}`;
              bump("withdraw");
              break;
            }
            case "cancelListing": {
              if (!s.listedBits.length) break;
              const id = pick(s.listedBits);
              const l = s.listing.get(id);
              const caller = rnd() < 0.85 ? wallets[idxOf(l.seller)] : pick(wallets);
              if (!caller) break;
              await (await w.asMarket(caller)).write.cancelListing([BigInt(id)]);
              did = `cancelListing #${id} by a${idxOf(caller.account.address)}`;
              bump("cancelListing");
              break;
            }
            case "pruneListing": {
              if (!s.listedBits.length) break;
              const id = pick(s.listedBits);
              await (await w.asMarket(pick(wallets))).write.pruneListing([BigInt(id)]);
              did = `pruneListing #${id}`;
              bump("pruneListing");
              break;
            }
            case "transfer": {
              if (!s.live.length) break;
              const id = pick(s.live);
              const from = wallets[idxOf(s.owner.get(id)!)];
              const to = pick(wallets.filter((x) => lower(x.account.address) !== lower(from.account.address)));
              await (await w.asRock(from)).write.transferFrom([from.account.address, to.account.address, BigInt(id)]);
              did = `transfer #${id} a${idxOf(from.account.address)}->a${idxOf(to.account.address)}`;
              bump("transfer");
              break;
            }
            case "merge": {
              // needs one actor owning two rocks where the higher id is burnable (>= 100)
              const byOwner = new Map<string, number[]>();
              for (const id of s.live) {
                const o = s.owner.get(id)!;
                byOwner.set(o, [...(byOwner.get(o) ?? []), id]);
              }
              const usable = [...byOwner.entries()]
                .map(([o, ids]) => [o, ids.sort((a, b) => a - b)] as const)
                .filter(([, ids]) => ids.length >= 2 && ids[ids.length - 1] >= 100);
              if (!usable.length) break;
              const [o, ids] = pick([...usable]);
              const high = pick(ids.filter((id) => id >= 100));
              const low = pick(ids.filter((id) => id !== high));
              await (await w.asRock(wallets[idxOf(o)])).write.merge([
                BigInt(low),
                BigInt(high),
                Math.floor(rnd() * 3),
              ]);
              did = `merge #${Math.min(low, high)} <- #${Math.max(low, high)} by a${idxOf(o)}`;
              bump("merge");
              break;
            }
            case "unwrap": {
              if (!s.live.length) break;
              const id = pick(s.live);
              const i = idxOf(s.owner.get(id)!);
              await (await w.asRock(wallets[i])).write.unwrap([BigInt(id)]);
              rawHeld.get(i)!.add(id); // the raw v1 rock is in their hands now
              did = `unwrap #${id} by a${i}`;
              bump("unwrap");
              break;
            }
            case "rewrap": {
              const holders = [...rawHeld.entries()].filter(([, ids]) => ids.size);
              if (!holders.length) break;
              const [i, ids] = pick(holders);
              const id = pick([...ids]);
              const warden = await w.rock.read.wardens([wallets[i].account.address]);
              await (await w.asMock(wallets[i])).write.giftRock([BigInt(id), warden]);
              ids.delete(id); // it left their hands here, whether or not the wrap below lands
              await (await w.asRock(wallets[i])).write.wrap([BigInt(id)]);
              did = `rewrap #${id} by a${i}`;
              bump("rewrap");
              break;
            }
            case "approval": {
              const i = Math.floor(rnd() * wallets.length);
              const on = rnd() < 0.5;
              await (await w.asRock(wallets[i])).write.setApprovalForAll([w.market.address, on]);
              did = `approval a${i} -> ${on}`;
              bump("approval");
              break;
            }
            case "warp": {
              const by = Math.floor(rnd() * 2 * HOUR);
              await w.conn.provider.request({ method: "evm_increaseTime", params: [by] });
              await w.conn.provider.request({ method: "evm_mine", params: [] });
              did = `warp +${by}s`;
              bump("warp");
              break;
            }
          }
        } catch (e: any) {
          // a revert is a legitimate outcome and cannot move funds: it rolls back atomically.
          // The next loop's check still runs, which is what proves that.
          did = `${action}: reverted (${String(e.shortMessage ?? e.message).split("\n")[0].slice(0, 90)})`;
          bump(`${action}:revert`);
        }
        if (did === SKIP) bump(`${action}:skip`);
        log.push(did);
      }

      // ---- drain the book: everything credited or escrowed must be reachable ------------------
      const end = await snap(w);
      try {
        check(end, sales, (await w.market.read.totalVolume()) as bigint, log.at(-1) ?? "setup");
      } catch (e: any) {
        assert.fail(replay(e.message)); // the loop checks before acting, so the last action needs this
      }
      // ---- the "no indexer" claim: every sale must still be reachable by walking the logs -----
      // lastSale holds the head block; each sale event carries the block of that rock's previous
      // sale. A static page follows that chain back. If a hop ever points at a block with no sale
      // in it, or the chain ends early, a rock's price history is silently truncated.
      for (const id of ALL_IDS) {
        const [info] = await w.market.read.getLastSales([[BigInt(id)]]);
        let head = Number(info.blockNum);
        let hops = 0;
        const seen = new Set<number>();
        while (head > 0) {
          assert.ok(!seen.has(head), replay(`price history for #${id} loops at block ${head}`));
          seen.add(head);
          const logs = await w.publicClient.getContractEvents({
            address: w.market.address,
            abi: w.market.abi,
            fromBlock: BigInt(head),
            toBlock: BigInt(head),
          });
          const here = logs.filter(
            (l) =>
              (l.eventName === "Bought" || l.eventName === "OfferAccepted") &&
              (l.args as any).tokenId === BigInt(id),
          );
          assert.ok(here.length > 0, replay(`price history for #${id} hops to block ${head}, which holds no sale`));
          hops += here.length;
          // the smallest prevBlock is what makes same-block sales terminate
          head = Math.min(...here.map((x) => Number((x.args as any).prevBlock)));
        }
        assert.equal(
          hops,
          Number(info.count),
          replay(`price history for #${id} walks ${hops} sales but lastSale.count says ${info.count}`),
        );
      }

      for (const id of end.bidBits) {
        const b = end.bid.get(id);
        await (await w.asMarket(wallets[idxOf(b.bidder)])).write.withdrawOffer([BigInt(id)]);
      }
      for (const a of wallets) {
        const owed = await w.market.read.pendingWithdrawals([a.account.address]);
        if ((owed as bigint) > 0n) await (await w.asMarket(a)).write.withdraw();
      }

      const drained = await w.publicClient.getBalance({ address: w.market.address });
      assert.equal(
        drained,
        0n,
        replay(
          `after draining every bid and every credited balance, ${formatEther(drained)} ETH is still in the market ` +
            `with no owner, no sweep, and no upgrade path to recover it`,
        ),
      );

      await w.conn.close?.();
    }

    // A campaign where nothing succeeded would pass silently and prove nothing, so require that
    // every path that moves ETH actually executed, and report the split rather than a bare total.
    const sum = (p: (k: string) => boolean) =>
      Object.entries(tally).reduce((a, [k, n]) => a + (p(k) ? n : 0), 0);
    const ran = sum((k) => !k.includes(":"));
    const reverted = sum((k) => k.endsWith(":revert"));
    const skipped = sum((k) => k.endsWith(":skip"));
    const report = Object.entries(tally)
      .sort()
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    for (const must of ["buy", "makeOffer", "acceptOffer", "withdrawOffer", "withdraw"]) {
      assert.ok((tally[must] ?? 0) > 0, `no ${must} ever succeeded, so the campaign proved nothing: ${report}`);
    }
    console.log(
      `      seed ${SEED}: ${SEQUENCES}x${ACTIONS} = ${SEQUENCES * ACTIONS} draws -> ` +
        `${ran} executed, ${reverted} reverted, ${skipped} skipped\n      ${report}`,
    );
  });

  // The random actors above are all EOAs, which always accept ETH, so they can never exercise the
  // one branch where a payout fails. `withdraw` zeroes a balance before it sends and depends on its
  // own revert to put it back; with no owner and no sweep, a credit destroyed by a bounced transfer
  // would be unrecoverable. Pinned here so the revert cannot be optimised away later.
  //
  // The credit is created by being OUTBID, which is the path that genuinely still needs the ledger:
  // the refund there goes to a THIRD PARTY, so it can never be a direct send.
  it("a payout target that refuses ETH keeps its credit instead of losing it", async () => {
    const w = await world();
    const picky = await w.viem.deployContract("PickyReceiver", [w.market.address]);

    await picky.write.bid([1n], { value: parseEther("1") });
    // someone outbids it, so the market owes it 1 ETH through the pull ledger
    await (await w.asMarket(w.wallets[1])).write.makeOffer([1n], { value: parseEther("2") });
    assert.equal(await w.market.read.pendingWithdrawals([picky.address]), parseEther("1"));

    await assert.rejects(picky.write.claim()); // its receive() reverts, so the whole withdraw undoes
    assert.equal(await w.market.read.pendingWithdrawals([picky.address]), parseEther("1")); // credit intact

    await picky.write.setRejecting([false]);
    await picky.write.claim(); // and it can still be collected afterwards, forever
    assert.equal(await w.market.read.pendingWithdrawals([picky.address]), 0n);
    assert.equal(await w.publicClient.getBalance({ address: picky.address }), parseEther("1"));
  });
});
