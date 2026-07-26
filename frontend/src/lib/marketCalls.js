// Pure builders for the market's approval-gated actions, split out so they can be unit-tested under
// `node --test` (no Svelte-rune imports). Each returns a { to, data } call tuple; contracts.js sends
// one directly, or hands an array to sendCalls for the one-click (EIP-5792) flow. Keeping the
// encoding here means the single-tx and batched paths share identical calldata and can't drift.
import { ABI } from "./abi.js";

// setApprovalForAll(market, true) on the EthereumRock contract: the one-time grant a seller needs before the
// market may move their rock on a sale. Both list and acceptOffer revert without it.
export const approveCall = (rock, market) => ({
  to: rock,
  data: ABI.encodeCall(ABI.SEL.setApprovalForAll, [ABI.addrWord(market), ABI.boolWord(true)]),
});

// list(id, price, expiry) on the market: a public listing anyone may buy.
export const listCall = (market, id, priceWei, expiry) => ({
  to: market,
  data: ABI.encodeCall(ABI.SEL.list, [ABI.uintWord(id), ABI.uintWord(priceWei), ABI.uintWord(expiry)]),
});

// listTo(id, price, expiry, buyer) on the market: a private listing only `buyer` can fill. Same
// slot as a public listing, so it overwrites one, and buy reverts for anyone but `buyer`.
export const listToCall = (market, id, priceWei, expiry, buyer) => ({
  to: market,
  data: ABI.encodeCall(ABI.SEL.listTo, [
    ABI.uintWord(id),
    ABI.uintWord(priceWei),
    ABI.uintWord(expiry),
    ABI.addrWord(buyer),
  ]),
});

// acceptOffer(id, minAmount) on the market.
export const acceptOfferCall = (market, id, minWei) => ({
  to: market,
  data: ABI.encodeCall(ABI.SEL.acceptOffer, [ABI.uintWord(id), ABI.uintWord(minWei)]),
});

// Prepend the one-time approval only when the seller hasn't approved the market yet, so an
// already-approved seller lists/accepts in a single call (sendCalls then skips batching entirely).
export const withApproval = (approved, approve, action) => (approved ? [action] : [approve, action]);
