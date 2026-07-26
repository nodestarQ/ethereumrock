// Small display helpers. Only the ETH formatter is borrowed, and abi.js imports nothing, so this
// stays acyclic.
import { ABI } from "./abi.js";

export const ZERO = "0x0000000000000000000000000000000000000000";

export const isZero = (a) => !a || a.toLowerCase() === ZERO;

export const short = (a) => (a && !isZero(a) ? a.slice(0, 6) + "…" + a.slice(-4) : "–");

// A private listing names one address, and the market reverts a buy from anybody else. The listing
// the page has already loaded says who, so the button can refuse up front with a reason instead of
// letting a stranger discover it by having a transaction fail. Same idea as the wrap and merge
// pre-checks: never send a doomed transaction to a wallet.
export function buyIssue(listing, account) {
  if (!listing || isZero(listing.onlyTo)) return null;
  if (account && listing.onlyTo.toLowerCase() === String(account).toLowerCase()) return null;
  return "Private sale: only " + short(listing.onlyTo) + " can buy this rock.";
}

// What to say when a chain read fails.
//
// This app has no server and no endpoint of its own: reads go through whatever wallet you connect.
// A build MAY carry a fallback endpoint in config, but the shipped one deliberately leaves it
// empty, so on the deployment that is meant to outlive all of us there is exactly one answer here,
// and it is "connect a wallet". `endpoint` only ever has a value on a local or self-hosted build,
// which is why it is a footnote rather than the headline: it must never read as though this page
// were built around somebody's node.
export function readIssue(err, { connected, endpoint } = {}) {
  if (connected) return "Couldn't load: " + errText(err);
  const ask = "Connect a wallet to read the chain.";
  if (!endpoint) return ask;
  return ask + " This build also has a fallback endpoint set (" + endpoint + ") and it is not answering.";
}

// A bid is stored in a uint96, and on a raise that cap applies to the resulting TOTAL, not to the
// amount sent.
export const MAX_BID = 2n ** 96n - 1n;

// What a bid of `total` wei would do against the bid already standing, and whether it can happen at
// all. Called twice for every bid: live under the field, then again against a fresh read just
// before signing, because a page can sit open while the book moves under it. One function, so the
// instant answer and the final answer can never disagree.
//
// Mirrors makeOffer: your own bid is a top-up, so any total above what you already have in works
// and only the difference leaves your wallet. Anyone else's has to strictly beat the standing bid,
// and pays the whole amount. Nothing may be zero.
export function bidPlan(total, standing, mine) {
  const now = standing ?? 0n;
  if (total == null) return { issue: "Enter an amount in ETH, like 0.5." };
  if (total <= 0n) return { issue: "Enter an amount above zero." };
  if (total > MAX_BID) return { issue: "That is larger than a single bid can hold." };
  if (mine) {
    if (total <= now) {
      return { issue: "Enter the total you want your bid to be, above the " + ABI.formatEther(now) + " ETH you already have in." };
    }
    return { kind: "raise", total, now, send: total - now };
  }
  if (now > 0n && total <= now) {
    return { issue: "The standing bid is " + ABI.formatEther(now) + " ETH. Yours has to beat it, not match it." };
  }
  return { kind: now > 0n ? "outbid" : "first", total, now, send: total };
}

// Readable text for a thrown wallet/RPC error. There are no toasts, so every caller shows this in
// place, next to the control that failed.
export const errText = (e) => (e && e.message ? e.message : String(e));

export const filled = (v) => String(v ?? "").trim() !== "";

// A 20-byte hex address, case-insensitive. Used to gate the private-sale field before the value
// reaches the ABI encoder (which also validates, but throws rather than showing an inline reason).
// No checksum check: EtherRock and the market both treat addresses case-insensitively.
export const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v ?? "").trim());

// Validate a rock id as typed. Empty returns null so nothing nags before you type; gate the
// button on `filled` as well.
//
// Every id field has to pass through here before it reaches BigInt(), because BigInt("") is 0n, not
// an error. An ungated empty field therefore means "rock #0" rather than "nothing entered", and for
// merge that silently burns the rock you are looking at into #0.
export function idIssue(v, min = 0, max = 9999) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return "Enter a whole rock id.";
  const n = Number(s);
  if (n < min) return `Enter an id of ${min} or above.`;
  if (n > max) return `Enter an id of ${max} or below.`;
  return null;
}

// How many dust rocks one absorb action will take. Each one costs a gift plus a burn, so a wallet
// that cannot batch pays 2x this in confirmations; that is what the ceiling is protecting against.
export const DUST_BATCH_MAX = 25;

// Parse a dust-rock list as typed: "10001, 10004", a range "10001-10005", or a mix of both.
//
// Dust is unlimited tail supply and every one is worth exactly +1, so absorbing really is a question
// of how many you feed in rather than which. The ids still have to be named, because EtherRock
// v1 has no enumeration and no balanceOf: ownership is a bare mapping, so neither the contract nor
// this page can discover which dust rocks are yours. Only you know what you claimed.
//
// Returns { ids, issue }. `ids` is empty whenever `issue` is set, so a caller can gate on either.
export function dustIds(v, max = DUST_BATCH_MAX) {
  const s = String(v ?? "").trim();
  if (!s) return { ids: [], issue: null }; // nothing typed yet, so nothing to complain about
  const bad = (issue) => ({ ids: [], issue });
  const ids = [];

  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [from, to] = [BigInt(range[1]), BigInt(range[2])];
      if (to < from) return bad(`The range ${part} runs backwards.`);
      if (to - from >= BigInt(max)) return bad(`${part} is more than ${max} rocks. Absorb them in batches.`);
      for (let n = from; n <= to; n++) ids.push(n);
      continue;
    }
    if (!/^\d+$/.test(part)) return bad(`"${part}" is not a rock id. Use ids, commas, or a range like 10001-10005.`);
    ids.push(BigInt(part));
  }

  const under = ids.find((n) => n < 10000n);
  if (under !== undefined) return bad(`#${under} is not dust. Only rocks above id 9999 can be absorbed.`);
  const uniq = [...new Set(ids)]; // BigInts are primitives, so Set dedupes them by value
  if (uniq.length !== ids.length) return bad("That list names the same rock twice.");
  if (uniq.length > max) return bad(`That is ${uniq.length} rocks. Absorb up to ${max} at a time.`);
  return { ids: uniq, issue: null };
}

export const fmtDate = (sec) => (sec && Number(sec) > 0 ? new Date(Number(sec) * 1000).toLocaleString() : "–");

// date only, for tight spaces like gallery cards
export const fmtDay = (sec) => (sec && Number(sec) > 0 ? new Date(Number(sec) * 1000).toLocaleDateString() : "–");

// The Status trait, from an id alone (mirrors EthereumRockRenderer).
export function statusOf(id, maxId) {
  const n = BigInt(id);
  if (n < 100n) return "DEFINED";
  if (n < BigInt(maxId)) return "UNDEFINED";
  return "DUST";
}
