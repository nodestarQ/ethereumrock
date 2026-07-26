// Unit tests for the pure EIP-5792 request/response shaping (frontend/src/lib/batch5792.js).
// The stateful orchestration in batch.js (which imports Svelte-rune modules) is not exercised here;
// this covers the spec-shaped logic most likely to drift with wallet versions.
//
// Run: node --test test/batch5792.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABI } from "../frontend/src/lib/abi.js";
import { buildSendCallsParams, parseAtomicStatus, classifyStatus, batchReceipt } from "../frontend/src/lib/batch5792.js";

const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CHAIN_HEX = "0x7a69"; // 31337

test("buildSendCallsParams shapes a 5792 v2 batch", () => {
  const [p] = buildSendCallsParams(FROM, CHAIN_HEX, [
    { to: "0xaaaa", data: "0x11" },
    { to: "0xbbbb", data: "0x22" },
  ]);
  assert.equal(p.version, "2.0.0");
  assert.equal(p.from, FROM);
  assert.equal(p.chainId, CHAIN_HEX);
  assert.equal(p.atomicRequired, true);
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.calls[0], { to: "0xaaaa", data: "0x11" });
  assert.equal("value" in p.calls[0], false); // no value key when none / zero
});

test("buildSendCallsParams includes value only when positive, hex-quantity encoded", () => {
  const oneEth = 1000000000000000000n;
  const [p] = buildSendCallsParams(FROM, CHAIN_HEX, [
    { to: "0xaaaa", data: "0x", value: 0n },
    { to: "0xbbbb", data: "0x", value: oneEth },
  ]);
  assert.equal("value" in p.calls[0], false);
  assert.equal(p.calls[1].value, ABI.hexQuantity(oneEth));
  assert.equal(p.calls[1].value, "0xde0b6b3a7640000");
});

test("parseAtomicStatus matches the chain by hex or decimal key, any case", () => {
  const yes = { atomic: { status: "supported" } };
  assert.equal(parseAtomicStatus({ "0x7a69": yes }, CHAIN_HEX, 31337), true);
  assert.equal(parseAtomicStatus({ "0x7A69": yes }, CHAIN_HEX, 31337), true); // upper hex from wallet
  assert.equal(parseAtomicStatus({ "31337": yes }, CHAIN_HEX, 31337), true); // decimal string
  assert.equal(parseAtomicStatus({ "0x7a69": { atomic: { status: "ready" } } }, CHAIN_HEX, 31337), true);
});

test("parseAtomicStatus is false when unsupported, missing, or malformed", () => {
  assert.equal(parseAtomicStatus({ "0x7a69": { atomic: { status: "unsupported" } } }, CHAIN_HEX, 31337), false);
  assert.equal(parseAtomicStatus({ "0x1": { atomic: { status: "supported" } } }, CHAIN_HEX, 31337), false); // other chain
  assert.equal(parseAtomicStatus({}, CHAIN_HEX, 31337), false);
  assert.equal(parseAtomicStatus(null, CHAIN_HEX, 31337), false);
  assert.equal(parseAtomicStatus({ "0x7a69": {} }, CHAIN_HEX, 31337), false);
});

test("classifyStatus handles 2.0.0 numeric codes", () => {
  assert.equal(classifyStatus({ status: 100 }), "pending");
  assert.equal(classifyStatus({ status: 200 }), "confirmed");
  assert.equal(classifyStatus({ status: 400 }), "failed");
  assert.equal(classifyStatus({ status: 500 }), "failed");
});

test("classifyStatus handles string and 0/1/2 draft forms", () => {
  assert.equal(classifyStatus({ status: "CONFIRMED" }), "confirmed");
  assert.equal(classifyStatus({ status: "PENDING" }), "pending");
  assert.equal(classifyStatus({ status: "failed" }), "failed");
  assert.equal(classifyStatus({ status: 0 }), "pending");
  assert.equal(classifyStatus({ status: 1 }), "confirmed");
  assert.equal(classifyStatus({ status: 2 }), "failed");
});

test("classifyStatus falls back to receipts / pending", () => {
  assert.equal(classifyStatus({ receipts: [{ status: "0x1" }] }), "confirmed");
  assert.equal(classifyStatus({}), "pending");
  assert.equal(classifyStatus(null), "pending");
});

test("batchReceipt returns the last receipt or null", () => {
  assert.equal(batchReceipt({}), null);
  assert.equal(batchReceipt({ receipts: [] }), null);
  const r = { status: "0x1", transactionHash: "0xdead" };
  assert.deepEqual(batchReceipt({ receipts: [{ status: "0x0" }, r] }), r);
});
