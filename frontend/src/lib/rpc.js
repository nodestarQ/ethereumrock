// JSON-RPC access. Prefers the connected wallet's provider (so the app ships no endpoint of its
// own); falls back to config.rpcUrl only if the operator set one for wallet-less browsing.
import { ABI } from "./abi.js";
import { wallet } from "./wallet.svelte.js";
import { config } from "../config.js";
import { isZero } from "./format.js";

export async function raw(method, params) {
  if (wallet.current) return wallet.current.request({ method, params });
  if (config.rpcUrl) {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "rpc error");
    return j.result;
  }
  throw new Error("connect a wallet to read the chain");
}

export async function ethCall(to, data) {
  if (isZero(to)) throw new Error("contract address not configured (edit src/config.js)");
  return raw("eth_call", [{ to, data }, "latest"]);
}

// The same address holds different code on different chains, so a write sent while the wallet is on
// the wrong one is not a failed action: it is an action against whatever stranger's contract happens
// to live at that address there, paid for with real value. The nav bar has always warned about this,
// but a warning is not a gate, and this is the one class of mistake the app cannot undo.
//
// Reads are left alone. They move nothing, the bar says the network is wrong, and the Switch network
// button beside it fixes the whole situation in one click.
export function assertChain() {
  if (wallet.chainId != null && wallet.chainId !== config.chainId) {
    throw new Error(
      "Wrong network: your wallet is on chain " + wallet.chainId + " and this app is on chain " +
        config.chainId + ". Switch networks and try again.",
    );
  }
}

export async function send(to, data, value) {
  if (!wallet.account) throw new Error("connect a wallet first");
  assertChain();
  if (isZero(to)) throw new Error("contract address not configured (edit src/config.js)");
  const tx = { from: wallet.account, to, data };
  if (value && value > 0n) tx.value = ABI.hexQuantity(value);
  const hash = await raw("eth_sendTransaction", [tx]);
  const r = await waitReceipt(hash);
  // A revert has to reach the caller. It used to only raise a toast, which meant the receipt came
  // back looking like success and a failed action changed nothing on screen without saying so.
  if (r && r.status !== "0x1") throw new Error("transaction reverted: " + hash);
  // A write is only useful once a re-READ can see it. On a public endpoint the node that serves the
  // next eth_call can lag the one that returned this receipt, so an immediate reload would show
  // pre-write state and the page would look frozen after a "successful" transaction. Wait for the
  // endpoint to reach the receipt's block before returning, so the caller's reload reflects the
  // change. This is what makes the top bid, the listing, the owner, etc. update after a tx without a
  // manual refresh. Skipped on a revert (thrown above) and a no-receipt timeout (nothing to sync to).
  if (r) await waitForBlock(r.blockNumber);
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitReceipt(hash) {
  for (let i = 0; i < 180; i++) {
    const r = await raw("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(1000);
  }
  return null;
}

// After a write mines, wait until the connected endpoint reports it is at least at the receipt's
// block, so a read issued right after (the page's reload) sees post-write state instead of the stale
// pre-write state a lagging load-balanced node might still return. Bounded (~12s) so it can never hang
// the UI; a local node satisfies it on the first check. Same lag the seed script fixed; same fix.
export async function waitForBlock(blockHex) {
  if (!blockHex) return;
  let target;
  try { target = BigInt(blockHex); } catch { return; }
  for (let i = 0; i < 20; i++) {
    try {
      if (BigInt(await raw("eth_blockNumber", [])) >= target) return;
    } catch { /* transient read failure; try again */ }
    await sleep(600);
  }
}

export async function chainNow() {
  const b = await raw("eth_getBlockByNumber", ["latest", false]);
  return { number: Number(BigInt(b.number)), time: Number(BigInt(b.timestamp)) };
}
