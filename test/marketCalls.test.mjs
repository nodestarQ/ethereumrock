// Unit tests for the pure market-call builders (frontend/src/lib/marketCalls.js): correct target
// contract, selector, argument order, and the approval-prefix logic behind the one-click list /
// accept-offer flows. No Svelte-rune imports, so it runs under `node --test`.
//
// Run: node --test test/marketCalls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABI } from "../frontend/src/lib/abi.js";
import { approveCall, listCall, listToCall, acceptOfferCall, withApproval } from "../frontend/src/lib/marketCalls.js";

const ROCK = "0x1111111111111111111111111111111111111111";
const MKT = "0x2222222222222222222222222222222222222222";
const BUYER = "0x3333333333333333333333333333333333333333";
const argWords = (data) => ABI.words("0x" + data.slice(10)); // drop the 4-byte selector, keep the args

test("approveCall targets the rock with setApprovalForAll(market, true)", () => {
  const c = approveCall(ROCK, MKT);
  assert.equal(c.to, ROCK);
  assert.ok(c.data.startsWith(ABI.SEL.setApprovalForAll));
  const w = argWords(c.data);
  assert.equal(ABI.wAddr(w[0]).toLowerCase(), MKT.toLowerCase());
  assert.equal(ABI.wBool(w[1]), true);
});

test("listCall targets the market with list(id, price, expiry) in order", () => {
  const c = listCall(MKT, 5n, 10n ** 18n, 1234n);
  assert.equal(c.to, MKT);
  assert.ok(c.data.startsWith(ABI.SEL.list));
  const w = argWords(c.data);
  assert.equal(ABI.wBig(w[0]), 5n);
  assert.equal(ABI.wBig(w[1]), 10n ** 18n);
  assert.equal(ABI.wBig(w[2]), 1234n);
});

test("listToCall targets the market with listTo(id, price, expiry, buyer) in order", () => {
  const c = listToCall(MKT, 5n, 10n ** 18n, 1234n, BUYER);
  assert.equal(c.to, MKT);
  assert.ok(c.data.startsWith(ABI.SEL.listTo));
  const w = argWords(c.data);
  assert.equal(ABI.wBig(w[0]), 5n);
  assert.equal(ABI.wBig(w[1]), 10n ** 18n);
  assert.equal(ABI.wBig(w[2]), 1234n);
  assert.equal(ABI.wAddr(w[3]).toLowerCase(), BUYER.toLowerCase());
  // listTo must NOT collide with list: distinct selectors, so a private sale can't be read as public
  assert.notEqual(ABI.SEL.listTo, ABI.SEL.list);
});

test("withApproval composes with a private listing the same way", () => {
  const approve = approveCall(ROCK, MKT);
  const priv = listToCall(MKT, 1n, 1n, 1n, BUYER);
  assert.deepEqual(withApproval(true, approve, priv), [priv]);
  assert.deepEqual(withApproval(false, approve, priv), [approve, priv]);
});

test("acceptOfferCall targets the market with acceptOffer(id, min)", () => {
  const c = acceptOfferCall(MKT, 7n, 3n * 10n ** 17n);
  assert.equal(c.to, MKT);
  assert.ok(c.data.startsWith(ABI.SEL.acceptOffer));
  const w = argWords(c.data);
  assert.equal(ABI.wBig(w[0]), 7n);
  assert.equal(ABI.wBig(w[1]), 3n * 10n ** 17n);
});

test("withApproval prepends the approval only when not yet approved", () => {
  const approve = approveCall(ROCK, MKT);
  const action = listCall(MKT, 1n, 1n, 1n);
  assert.deepEqual(withApproval(true, approve, action), [action]); // already approved: just the action
  const calls = withApproval(false, approve, action);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], approve); // approve first...
  assert.equal(calls[1], action); // ...then the market action
});
