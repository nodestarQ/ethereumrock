// Unit tests for the failed-read message (frontend/src/lib/format.js).
//
// Market and the rock page are meant to be browsable with no wallet, so they attempt the read
// first and only report afterwards. When that read fails the browser says "Failed to fetch", which
// tells a visitor nothing and hides the usual cause: nothing is connected and this app ships no
// endpoint of its own.
//
// Run: node --test test/readIssue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readIssue } from "../frontend/src/lib/format.js";

const boom = new Error("Failed to fetch");

test("with a wallet connected, the real error is shown", () => {
  // something else is wrong and hiding it would only make it harder to report
  const m = readIssue(boom, { connected: true, endpoint: "" });
  assert.match(m, /Failed to fetch/);
});

test("with no wallet and no endpoint, it asks for a wallet", () => {
  // THE MAINNET PATH. Shipping config leaves rpcUrl empty on purpose, so this is what a visitor to
  // the permanent deployment sees, and it must not mention an endpoint that does not exist.
  const m = readIssue(boom, { connected: false, endpoint: "" });
  assert.equal(m, "Connect a wallet to read the chain.");
  assert.doesNotMatch(m, /Failed to fetch/);
  assert.doesNotMatch(m, /http|endpoint|node/i);
});

test("a configured endpoint is a footnote, never the headline", () => {
  // only ever true on a local or self-hosted build, so it must not read as though the page were
  // built around somebody's node
  const m = readIssue(boom, { connected: false, endpoint: "http://127.0.0.1:8545" });
  assert.ok(m.startsWith("Connect a wallet to read the chain."), "the wallet comes first: " + m);
  assert.match(m, /127\.0\.0\.1:8545/);
  assert.doesNotMatch(m, /Failed to fetch/);
});

test("it never leaks the raw browser error to a disconnected visitor", () => {
  for (const endpoint of ["", "http://localhost:8545"]) {
    assert.doesNotMatch(readIssue(boom, { connected: false, endpoint }), /Failed to fetch/);
  }
});

test("it survives being called with nothing useful", () => {
  assert.equal(typeof readIssue(boom), "string");
  assert.equal(typeof readIssue(undefined, { connected: true }), "string");
});
