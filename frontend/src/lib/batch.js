// One-confirmation multi-step actions via EIP-5792 (wallet_sendCalls), executed atomically by
// EIP-7702 / ERC-4337 / smart-account wallets. When the wallet can't batch, this transparently
// falls back to sending each call in turn, which is exactly the old flow. Frontend-only: the
// contracts are unchanged, so every wallet keeps working and capable wallets just get one click.
import { wallet } from "./wallet.svelte.js";
import { config } from "../config.js";
import { ABI } from "./abi.js";
import { send, assertChain, waitForBlock } from "./rpc.js";
import { buildSendCallsParams, parseAtomicStatus, classifyStatus, batchReceipt } from "./batch5792.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chainHex = () => ABI.hexQuantity(BigInt(config.chainId));

// Cache the atomic-capability answer per account+chain; re-query on account switch.
let capsCache = null;

export async function atomicSupported() {
  const p = wallet.current;
  if (!p || !wallet.account) return false;
  const key = wallet.account + ":" + config.chainId;
  if (capsCache && capsCache.key === key) return capsCache.atomic;
  let atomic = false;
  try {
    const caps = await p.request({ method: "wallet_getCapabilities", params: [wallet.account, [chainHex()]] });
    atomic = parseAtomicStatus(caps, chainHex(), config.chainId);
  } catch {
    atomic = false; // wallet doesn't implement 5792
  }
  capsCache = { key, atomic };
  return atomic;
}

// calls: [{ to, data, value? (bigint) }]. Returns a receipt-like object (or null if still pending).
export async function sendCalls(calls, label) {
  if (!wallet.account) throw new Error("connect a wallet first");
  // the sequential path goes through rpc.send, which checks this itself, but the atomic path hands
  // the calls straight to the wallet, so the gate has to be here too
  assertChain();
  if (calls.length === 1) return send(calls[0].to, calls[0].data, calls[0].value || 0n);
  if (await atomicSupported()) {
    try {
      return await sendAtomic(calls, label);
    } catch (e) {
      if (isUserRejection(e)) throw e; // don't silently retry a deliberate rejection
      // wallet couldn't batch after all: fall through and send the steps one at a time, which the
      // user sees anyway as several confirmation prompts instead of one
    }
  }
  return sendSequential(calls);
}

async function sendAtomic(calls, label) {
  const p = wallet.current;
  const res = await p.request({ method: "wallet_sendCalls", params: buildSendCallsParams(wallet.account, chainHex(), calls) });
  const id = typeof res === "string" ? res : res && res.id;
  if (!id) throw new Error("wallet_sendCalls returned no id");
  for (let i = 0; i < 180; i++) {
    let s;
    try {
      s = await p.request({ method: "wallet_getCallsStatus", params: [id] });
    } catch {
      break; // status unsupported; treat as submitted
    }
    const c = classifyStatus(s);
    if (c === "confirmed") {
      const rc = batchReceipt(s);
      if (rc) await waitForBlock(rc.blockNumber); // same read-lag guard as a single send
      return rc || { status: "0x1" };
    }
    // same reasoning as a reverted single tx: the caller has to hear about it
    if (c === "failed") throw new Error((label ? label + ": " : "") + "batch reverted");
    await sleep(1000);
  }
  return null; // submitted but no status yet; the caller confirms against chain state
}

async function sendSequential(calls) {
  let last = null;
  for (const c of calls) last = await send(c.to, c.data, c.value || 0n);
  return last;
}

function isUserRejection(e) {
  const code = e && (e.code || (e.data && e.data.code));
  return code === 4001 || /reject|denied|cancell?ed/i.test((e && e.message) || "");
}
