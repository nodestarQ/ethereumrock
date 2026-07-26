// Verifies the dependency-free browser codec (frontend/abi.js) byte-for-byte against viem.
// The exact file the browser loads is eval'd here, so this tests the shipped bytes, not a copy.
//
// Run: node --test test/abi.codec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  parseAbiParameters,
  toFunctionSelector,
  toEventSelector,
  parseEther as vParseEther,
  formatEther as vFormatEther,
} from "viem";
import { ABI } from "../frontend/src/lib/abi.js";

const call = (sel, types, values) => sel + encodeAbiParameters(parseAbiParameters(types), values).slice(2);

test("selectors match viem", () => {
  const sigs = {
    createWarden: "createWarden()", wrap: "wrap(uint256)", unwrap: "unwrap(uint256)", rescue: "rescue(uint256)",
    merge: "merge(uint256,uint256,uint8)", absorb: "absorb(uint256,uint256)",
    setApprovalForAll: "setApprovalForAll(address,bool)", approve: "approve(address,uint256)",
    safeTransferFrom: "safeTransferFrom(address,address,uint256)", wardens: "wardens(address)",
    mass: "mass(uint256)", dust: "dust(uint256)", seed: "seed(uint256)", rolled: "rolled(uint256)",
    ownerOf: "ownerOf(uint256)", tokenURI: "tokenURI(uint256)", tokenURIBatch: "tokenURIBatch(uint256[])",
    totalSupply: "totalSupply()",
    wrappedBitmap: "wrappedBitmap()",
    tokensOfOwner: "tokensOfOwner(address)", tokensOfOwnerIn: "tokensOfOwnerIn(address,uint256,uint256)",
    isApprovedForAll: "isApprovedForAll(address,address)", getApproved: "getApproved(uint256)", MAX_ID: "MAX_ID()",
    list: "list(uint256,uint96,uint40)", listTo: "listTo(uint256,uint96,uint40,address)",
    cancelListing: "cancelListing(uint256)", buy: "buy(uint256)", makeOffer: "makeOffer(uint256)",
    withdrawOffer: "withdrawOffer(uint256)", acceptOffer: "acceptOffer(uint256,uint96)",
    withdraw: "withdraw()", pruneListing: "pruneListing(uint256)", listings: "listings(uint256)",
    bids: "bids(uint256)", lastSale: "lastSale(uint256)", pendingWithdrawals: "pendingWithdrawals(address)",
    totalVolume: "totalVolume()",
    listedBitmap: "listedBitmap()", bidBitmap: "bidBitmap()", getListings: "getListings(uint256[])",
    getBids: "getBids(uint256[])", getLastSales: "getLastSales(uint256[])",
    giftRock: "giftRock(uint256,address)", sellRock: "sellRock(uint256,uint256)", rocks: "rocks(uint256)",
    reverseResolve: "reverseResolve(address)",
    computeId: "computeId(string)", resolveById: "resolve(uint256)", resolveByName: "resolve(string)",
  };
  for (const [name, sig] of Object.entries(sigs)) {
    assert.equal(ABI.SEL[name], toFunctionSelector(sig), `selector ${name}`);
  }
});

test("event topics match viem", () => {
  const sigs = {
    Listed: "Listed(uint256,address,uint256,address,uint40)", Unlisted: "Unlisted(uint256,address)",
    Bought: "Bought(uint256,address,address,uint256,uint32)", Offered: "Offered(uint256,address,uint256)",
    OfferWithdrawn: "OfferWithdrawn(uint256,address,uint256)",
    OfferAccepted: "OfferAccepted(uint256,address,address,uint256,uint32)", Withdrawn: "Withdrawn(address,uint256)",
    Transfer: "Transfer(address,address,uint256)",
  };
  for (const [name, sig] of Object.entries(sigs)) {
    assert.equal(ABI.TOPIC[name], toEventSelector(sig), `topic ${name}`);
  }
});

test("encodes static-arg calls identically to viem", () => {
  const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.equal(ABI.encodeCall(ABI.SEL.wrap, [ABI.uintWord(42)]), call(ABI.SEL.wrap, "uint256", [42n]));
  assert.equal(
    ABI.encodeCall(ABI.SEL.merge, [ABI.uintWord(5), ABI.uintWord(200), ABI.uintWord(2)]),
    call(ABI.SEL.merge, "uint256,uint256,uint8", [5n, 200n, 2]),
  );
  assert.equal(
    ABI.encodeCall(ABI.SEL.list, [ABI.uintWord(5), ABI.uintWord(ABI.parseEther("1.5")), ABI.uintWord(1893456000)]),
    call(ABI.SEL.list, "uint256,uint96,uint40", [5n, vParseEther("1.5"), 1893456000n]),
  );
  assert.equal(
    ABI.encodeCall(ABI.SEL.listTo, [ABI.uintWord(5), ABI.uintWord(ABI.parseEther("2")), ABI.uintWord(1893456000), ABI.addrWord(A)]),
    call(ABI.SEL.listTo, "uint256,uint96,uint40,address", [5n, vParseEther("2"), 1893456000n, A]),
  );
  assert.equal(
    ABI.encodeCall(ABI.SEL.setApprovalForAll, [ABI.addrWord(A), ABI.boolWord(true)]),
    call(ABI.SEL.setApprovalForAll, "address,bool", [A, true]),
  );
  assert.equal(
    ABI.encodeCall(ABI.SEL.acceptOffer, [ABI.uintWord(9), ABI.uintWord(ABI.parseEther("0.6"))]),
    call(ABI.SEL.acceptOffer, "uint256,uint96", [9n, vParseEther("0.6")]),
  );
  assert.equal(
    ABI.encodeCall(ABI.SEL.giftRock, [ABI.uintWord(7), ABI.addrWord(A)]),
    call(ABI.SEL.giftRock, "uint256,address", [7n, A]),
  );
});

test("encodes the dynamic uint256[] calls identically to viem", () => {
  for (const sel of [ABI.SEL.getListings, ABI.SEL.getBids, ABI.SEL.getLastSales]) {
    const ids = [0n, 5n, 300n, 9999n];
    assert.equal(ABI.encodeUintArrayCall(sel, ids), call(sel, "uint256[]", [ids]));
  }
  // empty array too
  assert.equal(ABI.encodeUintArrayCall(ABI.SEL.getBids, []), call(ABI.SEL.getBids, "uint256[]", [[]]));
});

test("encodes a dynamic string call identically to viem", () => {
  // covers empty, sub-word, and a string spanning more than one 32-byte word
  for (const s of ["", "a", "rockhound.gwei", "counterparty.gwei", "wxyz".repeat(9)]) {
    assert.equal(ABI.encodeStringCall(ABI.SEL.computeId, s), call(ABI.SEL.computeId, "string", [s]));
  }
});

test("decodes a fixed uint256[40] bitmap", () => {
  const arr = Array.from({ length: 40 }, (_, i) => (i === 0 ? (1n << 5n) : i === 1 ? (1n << 44n) : BigInt(i)));
  const data = encodeAbiParameters(parseAbiParameters("uint256[40]"), [arr]);
  assert.deepEqual(ABI.decodeFixedUintArray(data, 40), arr);
});

test("decodes a dynamic uint256[] (tokensOfOwner shape)", () => {
  for (const ids of [[], [0n], [5n, 42n, 300n, 9999n]]) {
    const data = encodeAbiParameters(parseAbiParameters("uint256[]"), [ids]);
    assert.deepEqual(ABI.decodeUintArray(data), ids);
  }
});

test("decodes an inline struct (public getter shape)", () => {
  const A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const B = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const data = encodeAbiParameters(parseAbiParameters("address,uint96,address,uint40,uint32,uint24"),
    [A, vParseEther("1.25"), B, 1893456000n, 42000n, 3n]);
  const l = ABI.decodeStruct(data, ABI.LISTING);
  assert.equal(l.seller.toLowerCase(), A);
  assert.equal(l.price, vParseEther("1.25"));
  assert.equal(l.onlyTo.toLowerCase(), B);
  assert.equal(l.expiry, 1893456000n);
  assert.equal(l.massSnap, 42000n);
  assert.equal(l.burnSnap, 3n);
});

test("decodes a dynamic array of static structs", () => {
  const A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const components = [
    { name: "seller", type: "address" }, { name: "price", type: "uint96" }, { name: "onlyTo", type: "address" },
    { name: "expiry", type: "uint40" }, { name: "massSnap", type: "uint32" }, { name: "burnSnap", type: "uint24" },
  ];
  const rows = [
    [A, vParseEther("1"), "0x0000000000000000000000000000000000000000", 111n, 21000n, 0n],
    [A, vParseEther("3.5"), A, 222n, 84000n, 7n],
  ];
  const data = encodeAbiParameters([{ type: "tuple[]", components }], [rows]);
  const out = ABI.decodeStructArray(data, ABI.LISTING);
  assert.equal(out.length, 2);
  assert.equal(out[0].price, vParseEther("1"));
  assert.equal(out[0].burnSnap, 0n);
  assert.equal(out[1].massSnap, 84000n);
  assert.equal(out[1].burnSnap, 7n);
  assert.equal(out[1].onlyTo.toLowerCase(), A);
  // empty array
  assert.deepEqual(ABI.decodeStructArray(encodeAbiParameters([{ type: "tuple[]", components }], [[]]), ABI.LISTING), []);

  // A deployment one field behind the spec (no burnSnap) has to decode into the new shape rather
  // than shear by a word per entry. This is the frontend running against the older market.
  const old = components.slice(0, 5);
  const oldRows = [
    [A, vParseEther("1"), "0x0000000000000000000000000000000000000000", 111n, 21000n],
    [A, vParseEther("3.5"), A, 222n, 84000n],
  ];
  const back = ABI.decodeStructArray(encodeAbiParameters([{ type: "tuple[]", components: old }], [oldRows]), ABI.LISTING);
  assert.equal(back.length, 2);
  assert.equal(back[1].price, vParseEther("3.5")); // the field that shears first if the stride is wrong
  assert.equal(back[1].massSnap, 84000n);
  assert.equal(back[1].burnSnap, 0n); // absent on the wire, zero in the result
});

test("decodes a string return (tokenURI shape)", () => {
  const s = 'data:application/json;base64,eyJuYW1lIjoiUm9jayAjNSJ9';
  const data = encodeAbiParameters(parseAbiParameters("string"), [s]);
  assert.equal(ABI.decodeString(data), s);
});

test("decodes a string[] return (tokenURIBatch shape)", () => {
  // uneven lengths on purpose: entry offsets are relative to the start of the array body, and a
  // decoder that assumes fixed-width entries or absolute offsets passes on equal-length data.
  const uris = [
    "data:application/json;base64,eyJuYW1lIjoiUm9jayAjMSJ9",
    "", // the contract's answer for an id with no live token
    "data:application/json;base64," + "A".repeat(97), // spills past a 32-byte word boundary
  ];
  const data = encodeAbiParameters(parseAbiParameters("string[]"), [uris]);
  assert.deepEqual(ABI.decodeStringArray(data), uris);
  assert.deepEqual(ABI.decodeStringArray(encodeAbiParameters(parseAbiParameters("string[]"), [[]])), []);
});

test("parseEther / formatEther match viem", () => {
  for (const v of ["0", "1", "0.5", "1.234567890123456789", "1000000", "0.000000000000000001"]) {
    assert.equal(ABI.parseEther(v), vParseEther(v), `parseEther ${v}`);
  }
  for (const w of [0n, 1n, 10n ** 18n, vParseEther("1.23"), 123456789n]) {
    assert.equal(ABI.formatEther(w), vFormatEther(w), `formatEther ${w}`);
  }
});

test("bitsOf decodes bitmap words to ascending ids", () => {
  const w = new Array(40).fill(0n);
  w[0] = (1n << 5n) | (1n << 7n);
  w[1] = 1n << 44n; // id 300
  w[39] = 1n << 255n; // id 9984+255 = 10239 (out of range, but decode is mechanical)
  assert.deepEqual(ABI.bitsOf(w), [5, 7, 300, 39 * 256 + 255]);
});
