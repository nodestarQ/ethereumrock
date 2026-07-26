// Typed reads and writes for EthereumRock and EthereumRockMarket, over abi.js and rpc.js. Components
// call these, nothing here touches the DOM. test/frontend.e2e.ts drives this same calldata against
// real deployed bytecode.
import { ABI } from "./abi.js";
import { config } from "../config.js";
import { ethCall, send, raw, chainNow } from "./rpc.js";
import { sendCalls } from "./batch.js";
import { wallet } from "./wallet.svelte.js";
import { isZero } from "./format.js";
import { approveCall, listCall, listToCall, acceptOfferCall, withApproval } from "./marketCalls.js";

const R = () => config.rock;
const M = () => config.market;
const cd = (sel, ...w) => ABI.encodeCall(sel, w);
const _send = (c) => send(c.to, c.data, c.value || 0n); // send a { to, data, value? } call tuple
const MAX_UINT = (1n << 256n) - 1n; // type(uint256).max, the "unbuyable" v1 price
const U = (v) => ABI.uintWord(v);
const AD = (a) => ABI.addrWord(a);
const word0 = async (to, data) => ABI.words(await ethCall(to, data))[0];
const readUint = async (to, data) => ABI.wBig(await word0(to, data));

// ---------- EthereumRock reads ----------
export async function ownerOf(id) {
  try { return ABI.wAddr(await word0(R(), cd(ABI.SEL.ownerOf, U(id)))); }
  catch { return null; } // reverts for a burned / never-minted id
}
export const massOf = (id) => readUint(R(), cd(ABI.SEL.mass, U(id)));
export const dustOf = (id) => readUint(R(), cd(ABI.SEL.dust, U(id)));
export const rolledOf = async (id) => ABI.wBool(await word0(R(), cd(ABI.SEL.rolled, U(id))));
export const seedOf = async (id) => "0x" + (await word0(R(), cd(ABI.SEL.seed, U(id))));
export const tokenURIof = async (id) => ABI.decodeString(await ethCall(R(), cd(ABI.SEL.tokenURI, U(id))));
// The decoded metadata JSON (name, description, image, attributes). Reading traits from here rather
// than recomputing them means the page shows exactly what a marketplace shows, and a renderer that
// grows a new trait shows up without a frontend change. Reverts for an id that is not wrapped.
export const metadataOf = async (id) => {
  const uri = await tokenURIof(id);
  return JSON.parse(atob(uri.slice(uri.indexOf(",") + 1)));
};
// Art for a set of ids, as { id: imageDataUri }. One eth_call per CHUNK instead of one per tile.
//
// CHUNK is a gas budget, not taste: each entry renders a full SVG on chain at ~172k gas, so 12 is
// ~2.1M per call, comfortable anywhere. All 48 ids of a page in one call would be ~8.3M, over some
// providers' eth_call ceiling.
//
// Ids with no live token come back empty rather than reverting, so a rock unwrapped between the
// bitmap read and this one leaves a gap instead of killing the page.
const CHUNK = 12;
export async function artOf(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK).map(BigInt);
    const uris = ABI.decodeStringArray(
      await ethCall(R(), ABI.encodeUintArrayCall(ABI.SEL.tokenURIBatch, slice)),
    );
    uris.forEach((uri, j) => {
      if (!uri) return;
      try {
        out[Number(slice[j])] = JSON.parse(atob(uri.slice(uri.indexOf(",") + 1))).image;
      } catch {
        // a single unparseable entry must not cost the rest of the page its art
      }
    });
  }
  return out;
}

export const totalSupply = () => readUint(R(), cd(ABI.SEL.totalSupply));
// Every currently-wrapped id, in one call: 40 bitmap words decoded client-side. No indexer, no scan.
export const wrappedIds = async () =>
  ABI.bitsOf(ABI.decodeFixedUintArray(await ethCall(R(), ABI.SEL.wrappedBitmap), 40));
export const wardenOf = async (a) => ABI.wAddr(await word0(R(), cd(ABI.SEL.wardens, AD(a))));
export const isApprovedForAll = async (owner) =>
  ABI.wBool(await word0(R(), cd(ABI.SEL.isApprovedForAll, AD(owner), AD(M()))));

// ---------- Market reads ----------
export const listingOf = async (id) => ABI.decodeStruct(await ethCall(M(), cd(ABI.SEL.listings, U(id))), ABI.LISTING);
export const bidOf = async (id) => ABI.decodeStruct(await ethCall(M(), cd(ABI.SEL.bids, U(id))), ABI.BID);
export const saleOf = async (id) => ABI.decodeStruct(await ethCall(M(), cd(ABI.SEL.lastSale, U(id))), ABI.SALEINFO);
export const pendingOf = async (a) => readUint(M(), cd(ABI.SEL.pendingWithdrawals, AD(a)));
export const totalVolume = () => readUint(M(), cd(ABI.SEL.totalVolume));

// ---------- names (Gwei Name Service, optional) ----------
// reverseResolve(address) -> string, so a name costs one eth_call and a precomputed selector: no
// namehash, no keccak, no dependency. Cached per session, skipped when config.gns is unset, and any
// failure falls back to the raw address. Nothing depends on a name resolving.
const nameCache = new Map();
export async function resolveName(addr) {
  if (!addr || isZero(addr) || isZero(config.gns)) return null;
  const key = addr.toLowerCase();
  if (nameCache.has(key)) return nameCache.get(key);
  let name = null;
  try {
    const s = ABI.decodeString(await ethCall(config.gns, cd(ABI.SEL.reverseResolve, AD(addr))));
    name = s && s.length ? s : null;
  } catch {
    name = null; // no GNS on this chain, or no name set
  }
  nameCache.set(key, name);
  return name;
}

// Forward resolution: a Gwei name -> its address, or null. Best-effort and cosmetic. The resolved
// address is shown for confirmation and is what a private listing stores, so a wrong or missing name
// costs a refused list, never a mis-sent one.
//
// Tries both GNS interfaces so one build works against either: the real one resolves in two steps
// (computeId(name) -> id, resolve(id) -> address), MockGNS has a one-step resolve(string). Each is
// wrapped because the interface that is not deployed reverts on its unknown selector.
//
// Verified against mainnet GNS (0x9D51D507): the .gwei suffix is optional and case is handled on
// chain, so "VITALIK.gwei", "vitalik.gwei" and "vitalik" all give the same id. Whitespace is not
// trimmed on chain, hence the trim below.
export async function resolveAddress(name) {
  const s = String(name ?? "").trim();
  if (!s || isZero(config.gns)) return null;
  try {
    const id = ABI.wBig(await word0(config.gns, ABI.encodeStringCall(ABI.SEL.computeId, s)));
    if (id !== 0n) {
      const a = ABI.wAddr(await word0(config.gns, cd(ABI.SEL.resolveById, U(id))));
      if (!isZero(a)) return a;
    }
  } catch { /* not the two-step interface, or the name is unregistered */ }
  try {
    const a = ABI.wAddr(await word0(config.gns, ABI.encodeStringCall(ABI.SEL.resolveByName, s)));
    if (!isZero(a)) return a;
  } catch { /* no resolve(string) here */ }
  return null;
}
export const listedIds = async () => ABI.bitsOf(ABI.decodeFixedUintArray(await ethCall(M(), ABI.SEL.listedBitmap), 40));
export const bidIds = async () => ABI.bitsOf(ABI.decodeFixedUintArray(await ethCall(M(), ABI.SEL.bidBitmap), 40));

// Batch reads are chunked because the market page asks for EVERY listed id at once: the floor and
// the price sort are facts about the whole book, not about the page on screen. A Listing is two
// slots, ~6.1k gas an entry measured, so a fully listed 10,000 would be ~61M gas in one eth_call,
// past what any provider allows.
//
// 500 a call is ~3M gas and ~16KB calldata. Bids and sales are one slot each, so the same size
// covers them. Sequential, not parallel: twenty polite calls beat twenty simultaneous ones on a
// rate-limited endpoint.
const READ_CHUNK = 500;
async function batchRead(ids, selector, spec) {
  const out = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const slice = ids.slice(i, i + READ_CHUNK).map(BigInt);
    const data = await ethCall(M(), ABI.encodeUintArrayCall(selector, slice));
    out.push(...ABI.decodeStructArray(data, spec));
  }
  return out;
}

export async function getListings(ids) {
  if (!ids.length) return [];
  return batchRead(ids, ABI.SEL.getListings, ABI.LISTING);
}
export async function getBids(ids) {
  if (!ids.length) return [];
  return batchRead(ids, ABI.SEL.getBids, ABI.BID);
}
export async function getLastSales(ids) {
  if (!ids.length) return [];
  return batchRead(ids, ABI.SEL.getLastSales, ABI.SALEINFO);
}

// The whole live book, keyed by id, in the six calls the design targets.
export async function loadBook() {
  const [lids, bidsIds] = await Promise.all([listedIds(), bidIds()]);
  const ids = Array.from(new Set([...lids, ...bidsIds])).sort((a, b) => a - b);
  const [listings, bidArr, sales] = await Promise.all([getListings(lids), getBids(bidsIds), getLastSales(ids)]);
  const byId = {};
  for (const id of ids) byId[id] = { id };
  lids.forEach((id, i) => (byId[id].listing = listings[i]));
  bidsIds.forEach((id, i) => (byId[id].bid = bidArr[i]));
  ids.forEach((id, i) => (byId[id].sale = sales[i]));
  return ids.map((id) => byId[id]);
}

// Order state for one explicit page of ids (three batch calls), so the market can browse the whole
// collection without ever reading more than the rocks currently on screen.
export async function loadPage(ids) {
  if (!ids.length) return [];
  const [listings, bidArr, sales] = await Promise.all([getListings(ids), getBids(ids), getLastSales(ids)]);
  return ids.map((id, i) => ({ id, listing: listings[i], bid: bidArr[i], sale: sales[i] }));
}

// Price history for one rock: walk the log linked list, one single-block query per hop. No scanning.
export async function history(id) {
  const s = await saleOf(id);
  if (!s.count || s.count === 0n) return [];
  const rows = [];
  const idTopic = "0x" + ABI.uintWord(id);
  let head = Number(s.blockNum);
  let hops = 0;
  while (head > 0 && hops < 4096) {
    hops++;
    const logs = await raw("eth_getLogs", [{
      address: M(),
      fromBlock: ABI.hexQuantity(head),
      toBlock: ABI.hexQuantity(head),
      topics: [[ABI.TOPIC.Bought, ABI.TOPIC.OfferAccepted], idTopic],
    }]);
    if (!logs.length) break;
    let next = 0;
    for (const lg of logs) {
      const isBuy = lg.topics[0].toLowerCase() === ABI.TOPIC.Bought;
      const seller = ABI.wAddr(ABI.strip(isBuy ? lg.topics[3] : lg.topics[2]));
      const buyer = ABI.wAddr(ABI.strip(isBuy ? lg.topics[2] : lg.topics[3]));
      const dw = ABI.words(lg.data);
      rows.push({ block: Number(BigInt(lg.blockNumber)), price: ABI.wBig(dw[0]), seller, buyer, kind: isBuy ? "buy" : "accept" });
      const prev = ABI.wNum(dw[1]);
      if (next === 0 || prev < next) next = prev; // MIN terminates same-block chains
    }
    head = next;
  }
  rows.sort((a, b) => b.block - a.block);
  return rows;
}

// Public RPCs cap eth_getLogs, by block range (e.g. "range 11336041 exceeds limit of 10000") or by
// how many logs match. Both are fixed by asking for fewer blocks at a time, so this scans in windows
// and, when one is still refused, halves it and retries just that window. A single block always works
// (history() walks the sale list one block at a time through the same providers), so 1 is the floor.
// A local node has no cap and a tiny chain, so there this is one small query.
const LOG_WINDOW = 9000; // under the common 10k cap; shrinks on refusal, recovers on success
const isRangeError = (e) =>
  /range|limit|exceed|too many|too large|too wide|more than|response size|block range/i.test(
    String(e?.message ?? e?.data?.message ?? e),
  );

async function getLogsChunked(filter, fromBlock, toBlock) {
  const out = [];
  let start = fromBlock;
  let window = LOG_WINDOW;
  while (start <= toBlock) {
    const end = Math.min(start + window - 1, toBlock);
    try {
      const part = await raw("eth_getLogs", [
        { ...filter, fromBlock: ABI.hexQuantity(start), toBlock: ABI.hexQuantity(end) },
      ]);
      out.push(...part);
      start = end + 1;
      if (window < LOG_WINDOW) window = Math.min(LOG_WINDOW, window * 2); // recover after a shrink
    } catch (e) {
      if (window <= 1 || !isRangeError(e)) throw e; // a real error, or already at the 1-block floor
      window = Math.max(1, Math.floor(window / 2));
    }
  }
  return out;
}

// Rocks currently held by `addr`. Primary path is the contract's own tokensOfOwner view: ONE
// eth_call, the enumeration done on-chain from the wrapped bitmap, no logs, no deploy block, immune
// to RPC block-range caps. Mirrors how wrappedIds()/listedIds()/bidIds() already work.
// Falls back to the historical Transfer-log scan (rocksOwnedByScan) if that call fails: an older
// deployment predating the view, or an RPC that caps eth_call gas below a fully saturated collection.
export async function rocksOwnedBy(addr) {
  try {
    const ids = ABI.decodeUintArray(await ethCall(R(), cd(ABI.SEL.tokensOfOwner, AD(addr))));
    return ids.map(Number).sort((a, b) => a - b);
  } catch {
    /* too big for this endpoint's eth_call, or a deployment without the view: try the paged one */
  }
  try {
    return await rocksOwnedByWindows(addr);
  } catch {
    return rocksOwnedByScan(addr);
  }
}

// Same enumeration, one window at a time. The path a saturated collection needs: tokensOfOwner
// walks every live id calling _ownerOf until it has the owner's whole balance, so at 10,000 wrapped
// it is ~27M gas in one call and fails (measured). A 1,000-id window is 2.7M, so ten calls cover the
// id space. 2,500 would be 6.8M, too close to the 10M cap some endpoints use. Sequential for the
// same reason as above.
const OWN_WINDOW = 1000;
async function rocksOwnedByWindows(addr) {
  const max = Number(config.maxId) || 10000;
  const out = [];
  for (let from = 0; from < max; from += OWN_WINDOW) {
    const to = Math.min(from + OWN_WINDOW, max);
    const data = cd(ABI.SEL.tokensOfOwnerIn, AD(addr), U(from), U(to));
    out.push(...ABI.decodeUintArray(await ethCall(R(), data)).map(Number));
  }
  return out.sort((a, b) => a - b);
}

// Fallback enumeration via ERC-721 Transfer logs (received ids, then confirm ownerOf). Kept because
// it depends on nothing but standard logs, so it works against any ERC-721 at `config.rock`. The scan
// starts at config.deployBlock rather than genesis: on a public chain, scanning from 0 both wastes
// millions of empty pre-deploy blocks and blows the RPC's range cap outright.
async function rocksOwnedByScan(addr) {
  const toTopic = "0x" + ABI.addrWord(addr);
  const head = (await chainNow()).number;
  const from = Number(config.deployBlock) || 0;
  const logs = await getLogsChunked(
    { address: R(), topics: [ABI.TOPIC.Transfer, null, toTopic] }, // Transfer(_, to=addr, tokenId)
    from,
    head,
  );
  const candidates = Array.from(new Set(logs.map((l) => ABI.wNum(ABI.strip(l.topics[3]))))).sort((a, b) => a - b);
  const owned = [];
  for (const id of candidates) {
    const o = await ownerOf(BigInt(id));
    if (o && o.toLowerCase() === addr.toLowerCase()) owned.push(id);
  }
  return owned;
}

// ---------- writes ----------
export const createWarden = () => send(R(), cd(ABI.SEL.createWarden));
export async function giftRockToWarden(id) {
  const w = await wardenOf(wallet.account);
  if (isZero(w)) throw new Error("create your warden first");
  return send(config.v1, cd(ABI.SEL.giftRock, U(id), AD(w)));
}
export const wrap = (id) => send(R(), cd(ABI.SEL.wrap, U(id)));
export const unwrap = (id) => send(R(), cd(ABI.SEL.unwrap, U(id)));
export const rescue = (id) => send(R(), cd(ABI.SEL.rescue, U(id)));
// Give a rock away. If you have a live listing on it, that listing is cancelled in the same action,
// so a gift never leaves a stale listing behind: both calls go in ONE confirmation on a wallet that
// can batch (EIP-5792/7702), otherwise cancel-then-transfer in sequence (send() awaits each, so a
// failed cancel stops the transfer). safeTransferFrom (not transferFrom) so a send to a contract that
// cannot receive an NFT reverts instead of stranding the rock. Only YOUR own listing is cancelled; a
// stale listing left by a previous owner is not yours to cancel, so it is left alone and the transfer
// still goes through.
export async function transferBatched(id, to) {
  const from = wallet.account;
  const xfer = { to: R(), data: cd(ABI.SEL.safeTransferFrom, AD(from), AD(to), U(id)) };
  const l = await listingOf(id);
  const mine = !isZero(l.seller) && l.seller.toLowerCase() === String(from).toLowerCase();
  const calls = mine ? [{ to: M(), data: cd(ABI.SEL.cancelListing, U(id)) }, xfer] : [xfer];
  return sendCalls(calls, "transfer #" + id);
}
// Which old wrapper holds `id` for `addr`, or null if neither does. Both are ERC-721s whose
// ownerOf reverts on an id that was never wrapped there, so two eth_calls settle it. This is what
// lets the Wrap page work the source out from the number you type instead of asking you to pick a
// contract: the ids each wrapper covers is a fact on chain, not something a user should have to know.
// Who holds the RAW v1 rock, straight from EtherRock's `rocks` mapping (owner is its first field).
// Wrapping is a three-step batch whose very first call is sellRock, so anyone who does not hold the
// raw rock gets a bare "not owner" revert from a 2017 contract with no idea which step failed or
// why. Reading the owner first is what lets the page say something useful instead.
export const rawRockOwner = async (id) => ABI.wAddr(await word0(config.v1, cd(ABI.SEL.rocks, U(id))));

export async function migrationSource(id, addr) {
  const heldThere = async (wrapper) => {
    if (isZero(wrapper) || !addr) return false;
    try {
      const o = ABI.wAddr(await word0(wrapper, cd(ABI.SEL.ownerOf, U(id))));
      return !!o && o.toLowerCase() === addr.toLowerCase();
    } catch {
      return false; // never wrapped there
    }
  };
  const [sub100, tenk] = await Promise.all([heldThere(config.wrapperSub100), heldThere(config.wrapper10k)]);
  if (sub100) return "sub100";
  if (tenk) return "tenk";
  return null;
}

export function migrate(source, id) {
  const from = source === "tenk" ? config.wrapper10k : config.wrapperSub100;
  // safeTransferFrom(you, EthereumRock, id) -> EthereumRock.onERC721Received migrates it in one tx
  return send(from, cd(ABI.SEL.safeTransferFrom, AD(wallet.account), AD(R()), U(id)));
}
export const merge = (firstId, secondId, look) => send(R(), cd(ABI.SEL.merge, U(firstId), U(secondId), U(look)));
export const absorb = (highId, intoId) => send(R(), cd(ABI.SEL.absorb, U(highId), U(intoId)));
export const approveMarket = () => _send(approveCall(R(), M()));

// Composite warden flows, batched into one confirmation on EIP-5792/7702 wallets, otherwise sent
// in sequence (the plain flow). These are the two multi-step actions; everything else is one call.
export async function wrapBatched(id) {
  const w = await wardenOf(wallet.account);
  if (isZero(w)) throw new Error("create your warden first");
  return sendCalls(
    [
      // Lock the raw rock at max price on v1 BEFORE it enters the warden. This closes the pre-wrap
      // deposit window (see EthereumRock.sol header): even v1's latestNewRockForSale id, whose buyRock skips
      // the owner payout, needs 2**256-1 wei to buy once it is listed at max. The warden re-locks on
      // claim; this just covers the gap before wrap() runs.
      { to: config.v1, data: cd(ABI.SEL.sellRock, U(id), U(MAX_UINT)) },
      { to: config.v1, data: cd(ABI.SEL.giftRock, U(id), AD(w)) }, // gift raw rock into your warden
      { to: R(), data: cd(ABI.SEL.wrap, U(id)) }, // wrap it (warden locks it at max price, then mints)
    ],
    "wrap #" + id,
  );
}
// Absorb one or more dust rocks into `intoId`. Each one is a gift into your warden followed by the
// burn, so N rocks is 2N calls: a single confirmation on a wallet that can batch, 2N sequential
// transactions otherwise. The contract keeps its one-rock-per-call `absorb`; feeding it a list is
// purely a front-end convenience, so nothing here needs the collection to change.
/// `needGift` names the ids that still have to be gifted into the warden. Pass null to gift them
/// all (the normal case). A rock already sitting in the warden must be left out: gifting it again
/// reverts, since the warden owns it and you do not.
export async function absorbBatched(highIds, intoId, needGift = null) {
  const w = await wardenOf(wallet.account);
  if (isZero(w)) throw new Error("create your warden first");
  const ids = Array.isArray(highIds) ? highIds : [highIds];
  if (!ids.length) throw new Error("no dust rocks given");
  const gift = needGift === null ? null : new Set(needGift.map(String));
  const calls = ids.flatMap((h) => [
    ...(gift === null || gift.has(String(h)) ? [{ to: config.v1, data: cd(ABI.SEL.giftRock, U(h), AD(w)) }] : []),
    { to: R(), data: cd(ABI.SEL.absorb, U(h), U(intoId)) }, // burn it for +1 dust on intoId
  ]);
  const what = ids.length === 1 ? "#" + ids[0] : ids.length + " dust rocks";
  return sendCalls(calls, `absorb ${what} into #${intoId}`);
}

export const list = (id, priceWei, expiry) => _send(listCall(M(), id, priceWei, expiry));
// Both routed through the marketCalls builders so the single-tx and batched paths can't drift.
export const listTo = (id, priceWei, expiry, buyer) => _send(listToCall(M(), id, priceWei, expiry, buyer));
export const cancelListing = (id) => send(M(), cd(ABI.SEL.cancelListing, U(id)));
export async function buy(id) {
  const l = await listingOf(id);
  if (isZero(l.seller)) throw new Error("not listed");
  return send(M(), cd(ABI.SEL.buy, U(id)), l.price); // send exactly the on-chain price
}
export const makeOffer = (id, valueWei) => send(M(), cd(ABI.SEL.makeOffer, U(id)), valueWei);
export const withdrawOffer = (id) => send(M(), cd(ABI.SEL.withdrawOffer, U(id)));
export const acceptOffer = (id, minWei) => _send(acceptOfferCall(M(), id, minWei));
export const withdraw = () => send(M(), cd(ABI.SEL.withdraw));
export const pruneListing = (id) => send(M(), cd(ABI.SEL.pruneListing, U(id)));

// One-click selling. On a wallet that can batch (EIP-5792/7702) the market approval and the market
// action go in a single confirmation; otherwise sendCalls falls back to sending them in sequence,
// where `send` waits for the approval to be mined before the market call (which the contract
// requires: both list and acceptOffer revert on an unapproved rock). A seller already approved for
// all skips the approval entirely and this is one plain call.
// `buyer` non-null makes it a private sale (listTo); otherwise a public listing (list). Same slot
// either way, so this also switches a live listing between public and private.
export async function listBatched(id, priceWei, expiry, buyer = null) {
  const approved = await isApprovedForAll(wallet.account);
  const action = buyer ? listToCall(M(), id, priceWei, expiry, buyer) : listCall(M(), id, priceWei, expiry);
  const label = (buyer ? "private list #" : "list #") + id;
  return sendCalls(withApproval(approved, approveCall(R(), M()), action), label);
}
export async function acceptOfferBatched(id, minWei) {
  const approved = await isApprovedForAll(wallet.account);
  return sendCalls(withApproval(approved, approveCall(R(), M()), acceptOfferCall(M(), id, minWei)), "accept offer on #" + id);
}
