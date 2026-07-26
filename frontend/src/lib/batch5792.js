// EIP-5792 request/response shaping, kept pure (no wallet or DOM state) so it can be unit-tested
// in node against the spec. The stateful orchestration lives in batch.js.
//
// 5792 lets a dapp hand the wallet a list of calls; a smart account, an EIP-7702-delegated EOA,
// or a 4337 account can run them as one atomic transaction. Wallets that can't just reject, and we
// fall back to sending each call in turn (see batch.js).
import { ABI } from "./abi.js";

// Params for wallet_sendCalls. calls: [{ to, data, value? (bigint) }].
export function buildSendCallsParams(from, chainIdHex, calls) {
  return [
    {
      version: "2.0.0",
      from,
      chainId: chainIdHex,
      atomicRequired: true, // all-or-nothing: no half-wrapped state, and one confirmation
      calls: calls.map((c) => {
        const call = { to: c.to, data: c.data || "0x" };
        if (c.value && c.value > 0n) call.value = ABI.hexQuantity(c.value);
        return call;
      }),
    },
  ];
}

// wallet_getCapabilities -> { <chainId>: { atomic: { status }, ... }, ... }. Wallets key the chain
// by hex (any case) or decimal; "supported" means atomic is guaranteed, "ready" means it can be
// (e.g. a 7702 upgrade on send). Either is good enough to attempt a batch.
export function parseAtomicStatus(caps, chainIdHex, chainIdNum) {
  if (!caps || typeof caps !== "object") return false;
  const wantHex = String(chainIdHex).toLowerCase();
  let entry = null;
  for (const k of Object.keys(caps)) {
    // Match the chain key whether it is hex (any case) or decimal. Number("0x7a69") === 31337.
    if (String(k).toLowerCase() === wantHex || Number(k) === chainIdNum) {
      entry = caps[k];
      break;
    }
  }
  const status = entry && entry.atomic && entry.atomic.status;
  return status === "supported" || status === "ready";
}

// wallet_getCallsStatus.status. 2.0.0: 100 pending / 200 confirmed / >=400 failed. Older drafts used
// strings or 0/1/2. Stay tolerant so this survives wallet-version drift.
export function classifyStatus(s) {
  if (!s) return "pending";
  const st = s.status;
  if (typeof st === "string") {
    const u = st.toUpperCase();
    if (u === "CONFIRMED" || u === "SUCCESS") return "confirmed";
    if (u === "FAILED" || u === "REVERTED") return "failed";
    return "pending";
  }
  if (typeof st === "number") {
    if (st === 1) return "confirmed"; // 0/1/2 draft
    if (st === 2) return "failed"; // 0/1/2 draft
    if (st === 0) return "pending"; // 0/1/2 draft
    if (st === 100) return "pending"; // 2.0.0
    if (st >= 200 && st < 400) return "confirmed"; // 2.0.0
    if (st >= 400) return "failed"; // 2.0.0
    return "pending";
  }
  if (Array.isArray(s.receipts) && s.receipts.length) return "confirmed";
  return "pending";
}

// The final call's receipt from a batch status, if the wallet returned any.
export function batchReceipt(s) {
  if (!s || !Array.isArray(s.receipts) || !s.receipts.length) return null;
  return s.receipts[s.receipts.length - 1];
}
