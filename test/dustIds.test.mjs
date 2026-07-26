// Unit tests for the dust-list parser (frontend/src/lib/format.js).
//
// Absorbing is a "how many" action rather than a "which one" action: dust is unlimited tail supply
// and every rock is worth exactly +1. The ids still have to be typed, because EtherRock v1 has no
// enumeration, so this parser is the whole boundary between what a user types and calldata that
// burns their rocks. Everything it rejects would otherwise reach a wallet signature.
//
// Run: node --test test/dustIds.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dustIds, DUST_BATCH_MAX } from "../frontend/src/lib/format.js";

const ok = (v) => {
  const r = dustIds(v);
  assert.equal(r.issue, null, `expected "${v}" to parse, got: ${r.issue}`);
  return r.ids;
};
const rejects = (v, why) => {
  const r = dustIds(v);
  assert.ok(r.issue, `expected "${v}" to be rejected (${why})`);
  assert.deepEqual(r.ids, [], "a rejected list must yield no ids");
  return r.issue;
};

test("an empty field is not a complaint and not a rock", () => {
  // The same trap as merge: BigInt("") is 0n, so an ungated empty field means "rock #0".
  for (const v of ["", "   ", null, undefined]) {
    const r = dustIds(v);
    assert.equal(r.issue, null, "nothing typed yet should not nag");
    assert.deepEqual(r.ids, [], "and must never resolve to an id");
  }
});

test("parses single ids, lists, and ranges", () => {
  assert.deepEqual(ok("10001"), [10001n]);
  assert.deepEqual(ok("10001, 10004"), [10001n, 10004n]);
  assert.deepEqual(ok("10001 10004"), [10001n, 10004n], "whitespace separates too");
  assert.deepEqual(ok("10001,10004 , 10009"), [10001n, 10004n, 10009n], "ragged spacing is fine");
  assert.deepEqual(ok("10001-10004"), [10001n, 10002n, 10003n, 10004n]);
  assert.deepEqual(ok("10001-10002, 10009"), [10001n, 10002n, 10009n], "ranges mix with singles");
  assert.deepEqual(ok("10005-10005"), [10005n], "a range of one is still a range");
});

test("returns BigInts, so a huge id keeps every digit", () => {
  // Dust has no upper bound. Number would silently round anything past 2^53.
  const big = "9007199254740993"; // 2^53 + 1
  assert.deepEqual(ok(big), [BigInt(big)]);
  assert.equal(ok(big)[0].toString(), big, "no precision loss on the way to calldata");
});

test("rejects anything below the dust floor", () => {
  assert.match(rejects("9999", "not dust"), /not dust/);
  assert.match(rejects("0", "not dust"), /not dust/);
  rejects("10001, 42", "one bad entry poisons the list");
  rejects("9998-10002", "a range that starts below the floor");
});

test("rejects malformed entries", () => {
  rejects("abc", "not a number");
  rejects("10001, abc", "one bad entry in a list");
  rejects("-10001", "negative");
  rejects("10001.5", "not a whole number");
  rejects("10001--10004", "malformed range");
  rejects("0x2711", "hex is not accepted");
});

test("rejects a backwards range", () => {
  assert.match(rejects("10005-10001", "backwards"), /backwards/);
});

test("rejects duplicates, because a rock can only be burned once", () => {
  // The second absorb of the same id reverts on-chain, after the user has already signed for it.
  assert.match(rejects("10001, 10001", "repeated"), /twice/);
  assert.match(rejects("10001-10003, 10002", "range overlapping a single"), /twice/);
});

test("holds the batch ceiling, counting a range by its size", () => {
  const max = DUST_BATCH_MAX;
  assert.equal(ok(`10000-${10000 + max - 1}`).length, max, "exactly the limit is allowed");
  rejects(`10000-${10000 + max}`, "one over the limit as a range");
  rejects(Array.from({ length: max + 1 }, (_, i) => 10000 + i).join(","), "one over the limit as a list");
});

test("the ceiling is what bounds the confirmation count on a wallet that cannot batch", () => {
  // Each dust rock is a gift plus a burn, so the worst case a user can trigger is 2x the ceiling.
  assert.equal(ok(`10000-${10000 + DUST_BATCH_MAX - 1}`).length * 2, DUST_BATCH_MAX * 2);
});
