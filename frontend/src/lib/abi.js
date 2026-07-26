// Minimal ABI codec for EthereumRockMarket + EthereumRock. No dependencies. Imported by the Svelte app AND by the
// tests that check it byte-for-byte against viem (test/abi.codec.test.mjs) and drive it against real
// deployed bytecode (test/frontend.e2e.ts), so the shipped module is the tested module.
//
// The contracts use a deliberately small type surface, and this only implements that surface:
//   encode: static words (uint*, address, bool) and one dynamic uint256[] argument
//   decode: fixed uint256[N], a static struct, a dynamic array of static structs, and string
// There are no nested dynamic types to encode, which is what keeps this short and verifiable.
//
// Selectors and event topics are precomputed (node scripts/gen-selectors.mjs) and each is
// re-asserted against viem in the test, so a wrong constant fails CI rather than mispricing a call.

// ---- low-level ----
function strip(h) {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

function padWord(hexNoPrefix) {
  if (hexNoPrefix.length > 64) throw new Error("word overflow: " + hexNoPrefix);
  return "0".repeat(64 - hexNoPrefix.length) + hexNoPrefix;
}

// BigInt | number | numeric string -> 32-byte word (no 0x)
function uintWord(v) {
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) throw new Error("negative uint");
  if (n >= 1n << 256n) throw new Error("uint exceeds 256 bits");
  return padWord(n.toString(16));
}

// "0x..." (any case, 20 bytes) -> 32-byte word (no 0x)
function addrWord(a) {
  const s = strip(a).toLowerCase();
  if (s.length !== 40 || /[^0-9a-f]/.test(s)) throw new Error("bad address: " + a);
  return padWord(s);
}

function boolWord(b) {
  return padWord(b ? "1" : "0");
}

// ---- word readers ----
function words(dataHex) {
  const s = strip(dataHex);
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push(s.slice(i, i + 64));
  return out;
}

function wBig(w) {
  return w ? BigInt("0x" + w) : 0n;
}

function wNum(w) {
  return Number(wBig(w));
}

function wAddr(w) {
  return "0x" + w.slice(24); // last 20 bytes
}

function wBool(w) {
  return wBig(w) !== 0n;
}

// ---- calldata ----
// selector is "0xXXXXXXXX"; argWords is an array of 64-char hex strings (no 0x).
function encodeCall(selector, argWords) {
  return selector + (argWords || []).join("");
}

// one dynamic uint256[] argument: head is a single offset word (0x20), then length, then items.
function encodeUintArrayCall(selector, ids) {
  const items = ids.map(uintWord);
  return selector + uintWord(32) + uintWord(items.length) + items.join("");
}

// one dynamic `string` argument: offset word (0x20), byte length, then the UTF-8 bytes right-padded
// to a 32-byte boundary. The only string the app encodes on the write side (a Gwei name to resolve).
function encodeStringCall(selector, str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const pad = (64 - (hex.length % 64)) % 64; // out to the next 32-byte word
  return selector + uintWord(32) + uintWord(bytes.length) + hex + "0".repeat(pad);
}

// ---- return decoders ----
// A function returning uint256[N] (fixed) encodes it inline: N words from offset 0, no length.
function decodeFixedUintArray(dataHex, n) {
  const w = words(dataHex);
  const out = [];
  for (let i = 0; i < n; i++) out.push(wBig(w[i] || padWord("0")));
  return out;
}

// A function returning a dynamic uint256[]: a single offset word -> length -> that many items.
function decodeUintArray(dataHex) {
  const w = words(dataHex);
  if (w.length === 0) return [];
  const start = wNum(w[0]) / 32; // byte offset -> word index (normally 1)
  const len = wNum(w[start]);
  const out = [];
  for (let i = 0; i < len; i++) out.push(wBig(w[start + 1 + i] || padWord("0")));
  return out;
}

// Decode one static struct from inline words per `spec` (array of [name, type]).
// type is "address" | "uint" | "bool". Used for the flattened public-getter returns.
// `width` is how many words the encoded struct actually occupies, which is not always spec.length:
// a contract deployed before a field was added returns the shorter shape. Fields past the width read
// as zero rather than as whatever word happens to sit there (the next entry's first field, in an
// array), so an old deployment decodes into the new shape instead of into garbage.
function decodeStructWords(w, base, spec, width = spec.length) {
  const o = {};
  for (let i = 0; i < spec.length; i++) {
    const word = (i < width && w[base + i]) || padWord("0");
    const t = spec[i][1];
    o[spec[i][0]] = t === "address" ? wAddr(word) : t === "bool" ? wBool(word) : wBig(word);
  }
  return o;
}

function decodeStruct(dataHex, spec) {
  return decodeStructWords(words(dataHex), 0, spec);
}

// A function returning a dynamic array of static structs: offset -> length -> inlined elements.
function decodeStructArray(dataHex, spec) {
  const w = words(dataHex);
  if (w.length === 0) return [];
  const start = wNum(w[0]) / 32; // byte offset -> word index (normally 1)
  const len = wNum(w[start]);
  const base = start + 1;
  // Take the stride from the data, not from the spec. A static struct array is exactly len * width
  // words, so the encoding states its own width, and a contract one field behind this spec is read
  // correctly instead of being sheared by one word per entry.
  const per = len > 0 ? Math.floor((w.length - base) / len) : spec.length;
  const out = [];
  for (let i = 0; i < len; i++) out.push(decodeStructWords(w, base + i * per, spec, per));
  return out;
}

// A function returning `string`: offset -> byte length -> data.
function decodeString(dataHex) {
  const w = words(dataHex);
  const start = wNum(w[0]) / 32;
  const len = wNum(w[start]);
  const dataHexBytes = w.slice(start + 1).join("").slice(0, len * 2);
  return hexToUtf8(dataHexBytes);
}

// A function returning `string[]`: outer offset -> length -> one relative offset per entry, each
// pointing at its own length-then-data. Entry offsets are relative to the start of the array body,
// which is the part that catches people out.
function decodeStringArray(dataHex) {
  const w = words(dataHex);
  if (w.length === 0) return [];
  const start = wNum(w[0]) / 32; // outer offset -> word index (normally 1)
  const len = wNum(w[start]);
  const base = start + 1; // first entry offset sits here, and entry offsets count from here
  const out = [];
  for (let i = 0; i < len; i++) {
    const at = base + wNum(w[base + i]) / 32;
    const bytes = wNum(w[at]);
    out.push(hexToUtf8(w.slice(at + 1).join("").slice(0, bytes * 2)));
  }
  return out;
}

function hexToBytes(h) {
  const s = strip(h);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function hexToUtf8(h) {
  return new TextDecoder().decode(hexToBytes(h));
}

// ---- ether formatting (BigInt, no float) ----
function parseEther(s) {
  const str = String(s).trim();
  if (!/^\d*\.?\d*$/.test(str) || str === "" || str === ".") throw new Error("bad amount: " + s);
  const [whole, frac = ""] = str.split(".");
  const f = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * 10n ** 18n + BigInt(f || "0");
}

function formatEther(wei) {
  const n = typeof wei === "bigint" ? wei : BigInt(wei);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const whole = a / 10n ** 18n;
  const frac = (a % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

// number/bigint -> "0x..." for RPC quantities (block numbers, values)
function hexQuantity(v) {
  const n = typeof v === "bigint" ? v : BigInt(v);
  return "0x" + n.toString(16);
}

// The set bit indices of a 40-word bitmap, ascending. id = wordIndex*256 + bitIndex,
// matching the contract's `bm[id>>8] |= 1<<(id&0xff)`.
function bitsOf(wordsArr) {
  const out = [];
  for (let wi = 0; wi < wordsArr.length; wi++) {
    let v = typeof wordsArr[wi] === "bigint" ? wordsArr[wi] : BigInt(wordsArr[wi]);
    let b = 0;
    while (v > 0n) {
      if (v & 1n) out.push(wi * 256 + b);
      v >>= 1n;
      b++;
    }
  }
  return out;
}

// Precomputed via viem toFunctionSelector / toEventSelector (re-asserted in the codec test).
// Regenerate: node scripts/gen-selectors.mjs
const SEL = {
  createWarden: "0xa77041dd",
  wrap: "0xea598cb0",
  unwrap: "0xde0e9a3e",
  rescue: "0x6ac053ad",
  merge: "0x8ced7b17",
  absorb: "0x396b30e7",
  setApprovalForAll: "0xa22cb465",
  approve: "0x095ea7b3",
  safeTransferFrom: "0x42842e0e",
  wardens: "0xabd5aa7d",
  mass: "0x501473bd",
  dust: "0xfd7fa2df",
  seed: "0x95564837",
  rolled: "0x2baf3df3",
  ownerOf: "0x6352211e",
  tokenURI: "0xc87b56dd",
  tokenURIBatch: "0x8d38e365",
  totalSupply: "0x18160ddd",
  wrappedBitmap: "0xd5499b96",
  tokensOfOwner: "0x8462151c",
  tokensOfOwnerIn: "0x99a2557a",
  isApprovedForAll: "0xe985e9c5",
  getApproved: "0x081812fc",
  MAX_ID: "0x17bac052",
  list: "0xf2d00a83",
  listTo: "0xc44c462d",
  cancelListing: "0x305a67a8",
  buy: "0xd96a094a",
  makeOffer: "0x9a2f6474",
  withdrawOffer: "0x8610f045",
  acceptOffer: "0xb01b193e",
  withdraw: "0x3ccfd60b",
  pruneListing: "0xb31f038e",
  listings: "0xde74e57b",
  bids: "0x4423c5f1",
  lastSale: "0xb6934afb",
  pendingWithdrawals: "0xf3f43703",
  totalVolume: "0x5f81a57c",
  listedBitmap: "0x889ed178",
  bidBitmap: "0xcd6ef21c",
  getListings: "0x0373c0bf",
  getBids: "0x35d6d214",
  getLastSales: "0x258d08bf",
  giftRock: "0x1b3e2002",
  sellRock: "0xc6caa959",
  reverseResolve: "0x9af8b7aa",
  rocks: "0x676cfec6",
  // Gwei Name Service forward resolution (name -> address), used only by the optional private-sale
  // name field. Two shapes exist: the real GNS resolves in two steps, computeId(name) then
  // resolve(uint256); the local MockGNS has a one-step resolve(string). resolveAddress tries both.
  computeId: "0xfb021939", // computeId(string) -> uint256   (real GNS)
  resolveById: "0x4f896d4f", // resolve(uint256) -> address    (real GNS)
  resolveByName: "0x461a4478", // resolve(string) -> address     (MockGNS)
};

const TOPIC = {
  Listed: "0x9fd0e01e4cd41e8c101afb7fa962570335be73654fdb8a3fec862197742383ea",
  Unlisted: "0x398bd90ce129393b9155d48dccffb325e671f45c4250de457462a019268ff1f0",
  Bought: "0x8d92a13553f6d328e8e2f8d787835eadb96d99c4eae8ce1adab6441beb35c74d",
  Offered: "0x518fd790da45a5acbd08fd96a76218561c8278a0772a5cb9a537bb8ccfe1e36b",
  OfferWithdrawn: "0x60c7613a8b8ce872a461e88b0f376098063e67e4df6d0aa6a55790fe81acdb58",
  OfferAccepted: "0x7bc7d23e5aeba58dbde35bee1ac5d5ffe45557827f7ae6b35255586d1ff97652",
  Withdrawn: "0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5",
  // ERC-721 Transfer, emitted by EthereumRock on mint/transfer/burn. Used to enumerate a holder's rocks.
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};

// struct specs (order matches Solidity)
const LISTING = [
  ["seller", "address"], ["price", "uint"], ["onlyTo", "address"], ["expiry", "uint"],
  ["massSnap", "uint"], ["burnSnap", "uint"],
];
const BID = [["bidder", "address"], ["amount", "uint"]];
const SALEINFO = [["price", "uint"], ["time", "uint"], ["blockNum", "uint"], ["count", "uint"]];

export const ABI = {
  strip, uintWord, addrWord, boolWord,
  words, wBig, wNum, wAddr, wBool,
  encodeCall, encodeUintArrayCall, encodeStringCall,
  decodeFixedUintArray, decodeUintArray, decodeStruct, decodeStructArray, decodeString, decodeStringArray,
  hexToBytes, hexToUtf8, parseEther, formatEther, hexQuantity, bitsOf,
  SEL, TOPIC, LISTING, BID, SALEINFO,
};

export default ABI;
