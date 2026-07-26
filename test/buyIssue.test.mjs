// Unit tests for the private-sale buy gate (frontend/src/lib/format.js).
//
// `listTo` names one address and EthereumRockMarket reverts a buy from anybody else. Without this
// gate the only way a stranger learns that is a failed transaction, which is exactly the shape of
// footgun the wrap and merge pre-checks were added to remove. Everything it refuses would otherwise
// reach a wallet signature.
//
// Run: node --test test/buyIssue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buyIssue, ZERO } from "../frontend/src/lib/format.js";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const pub = { onlyTo: ZERO, price: 1n };
const priv = { onlyTo: ALICE, price: 1n };

test("a public listing never blocks anyone", () => {
  assert.equal(buyIssue(pub, BOB), null);
  assert.equal(buyIssue(pub, ALICE), null);
  assert.equal(buyIssue(pub, null), null);
});

test("a private listing blocks everyone but the named address", () => {
  assert.match(buyIssue(priv, BOB), /Private sale/);
  assert.equal(buyIssue(priv, ALICE), null);
});

test("the named address is matched case-insensitively", () => {
  // the market compares raw addresses, and wallets hand back mixed checksum casing
  assert.equal(buyIssue(priv, ALICE.toLowerCase()), null);
  assert.equal(buyIssue(priv, ALICE.toUpperCase().replace("0X", "0x")), null);
  assert.equal(buyIssue({ onlyTo: ALICE.toLowerCase() }, ALICE), null);
});

test("with no wallet connected a private listing still explains itself", () => {
  const why = buyIssue(priv, null);
  assert.match(why, /Private sale/);
  // and it names who can, in short form, so the tile's title attribute stays readable
  assert.match(why, /0xf39F…2266/);
});

test("a missing listing is not a block", () => {
  // an unlisted rock has no buy button at all; this must not invent a reason for one
  assert.equal(buyIssue(null, BOB), null);
  assert.equal(buyIssue(undefined, BOB), null);
});
