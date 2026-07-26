// Unit tests for the bid gate (frontend/src/lib/format.js).
//
// EthereumRockMarket.makeOffer has two different rules depending on who is bidding: your own bid is
// a top-up, so any total above what you already have in works and only the difference is sent;
// anyone else's has to STRICTLY beat the standing bid and pays the whole amount. The old UI only
// gated the first case, so outbidding someone at or below their price reached the wallet and cost
// gas on a BidTooLow revert. This function is that gate, and it runs twice per bid: live under the
// field, then again against a fresh read just before signing.
//
// Run: node --test test/bidPlan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidPlan, MAX_BID } from "../frontend/src/lib/format.js";

const eth = (n) => BigInt(n) * 10n ** 18n;

test("the first bid on a rock just needs to be above zero", () => {
  const p = bidPlan(eth(1), 0n, false);
  assert.equal(p.kind, "first");
  assert.equal(p.send, eth(1));
  assert.equal(p.issue, undefined);
});

test("outbidding a stranger has to beat the standing bid, not match it", () => {
  // the exact case from the manual pass: 2 ETH stands, someone tries 1
  assert.match(bidPlan(eth(1), eth(2), false).issue, /standing bid is 2 ETH/);
  assert.match(bidPlan(eth(2), eth(2), false).issue, /beat it, not match it/);
  const ok = bidPlan(eth(2) + 1n, eth(2), false);
  assert.equal(ok.kind, "outbid");
  assert.equal(ok.send, eth(2) + 1n, "an outbid pays the whole amount, not the difference");
});

test("raising your own bid is a top-up and only sends the difference", () => {
  const p = bidPlan(eth(20), eth(10), true);
  assert.equal(p.kind, "raise");
  assert.equal(p.send, eth(10), "10 already escrowed, so 20 total costs 10 more");
  assert.equal(p.total, eth(20));
});

test("your own bid still has to go up", () => {
  assert.match(bidPlan(eth(10), eth(10), true).issue, /above the 10 ETH you already have in/);
  assert.match(bidPlan(eth(5), eth(10), true).issue, /above the 10 ETH/);
  // one wei over is a legal raise: makeOffer accepts any msg.value > 0 from the standing bidder
  assert.equal(bidPlan(eth(10) + 1n, eth(10), true).send, 1n);
});

test("zero, negative and unparseable amounts are refused", () => {
  assert.match(bidPlan(0n, 0n, false).issue, /above zero/);
  assert.match(bidPlan(-1n, 0n, false).issue, /above zero/);
  assert.match(bidPlan(null, 0n, false).issue, /Enter an amount in ETH/);
  assert.match(bidPlan(undefined, eth(2), false).issue, /Enter an amount in ETH/);
});

test("a bid larger than the uint96 the market stores is refused", () => {
  assert.equal(bidPlan(MAX_BID, 0n, false).kind, "first");
  assert.match(bidPlan(MAX_BID + 1n, 0n, false).issue, /larger than a single bid can hold/);
  // on a raise the cap is the resulting TOTAL, which is what this function is given
  assert.match(bidPlan(MAX_BID + 1n, eth(1), true).issue, /larger than a single bid can hold/);
});

test("a missing standing bid is treated as none", () => {
  assert.equal(bidPlan(eth(1), null, false).kind, "first");
  assert.equal(bidPlan(eth(1), undefined, false).kind, "first");
});
