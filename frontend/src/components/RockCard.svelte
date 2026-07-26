<script>
  // One rock in a gallery grid. Shared by the market and the account holdings so the two can never
  // drift apart. `buy` is optional: pages showing rocks you already own pass nothing and get a
  // display-only tile.
  import RockArt from "./RockArt.svelte";
  import { ABI } from "../lib/abi.js";
  import { fmtDay, isZero, buyIssue } from "../lib/format.js";
  import { wallet } from "../lib/wallet.svelte.js";

  let { row, buy = null } = $props();

  const listed = $derived(!!(row.listing && row.listing.price > 0n));
  const isPrivate = $derived(!!(row.listing && !isZero(row.listing.onlyTo)));

  // A tile has no room for a sentence, so the reason lives in the title and the button just refuses.
  const blocked = $derived(
    !wallet.account ? "Connect a wallet to buy." : buyIssue(row.listing, wallet.account),
  );

  // The tile owns its own pending state, so the Buy button disables and says so while the parent's
  // buy + reload runs. On a real chain that is a ~12s window, not the instant it is on a local node.
  let busy = $state(false);
  async function doBuy() {
    if (busy || !buy) return;
    busy = true;
    try { await buy(row.id); } finally { busy = false; }
  }
</script>

<div class="card">
  <a class="art" href={"#/rock/" + row.id} aria-label={"Rock #" + row.id}><RockArt id={row.id} fluid /></a>
  <div class="meta">
    <a class="id" href={"#/rock/" + row.id}>#{row.id}</a>
    {#if isPrivate}<span class="tag">private</span>{/if}
  </div>
  <div class="row">
    <span class="price">{listed ? ABI.formatEther(row.listing.price) + " ETH" : "–"}</span>
    {#if listed && buy}
      <button type="button" class="primary buy" onclick={doBuy} disabled={!!blocked || busy} title={blocked ?? ""}>{busy ? "buying…" : "Buy"}</button>
    {/if}
  </div>
  <div class="row sub2">
    <span>{row.bid && row.bid.amount > 0n ? "bid " + ABI.formatEther(row.bid.amount) + " ETH" : ""}</span>
    <span>{listed ? "exp " + fmtDay(row.listing.expiry) : ""}</span>
  </div>
</div>

<style>
  /* raised off the paper, so a card reads as an object rather than a hairline on the background */
  .card { position: relative; border: 1px solid var(--line); background: var(--surface); padding: 0.6rem; transition: border-color 0.12s, box-shadow 0.12s; }
  .card:hover { border-color: var(--line-2); box-shadow: var(--shadow-sm); }
  .card .art { display: block; }
  /* the whole card opens the rock: the art anchor stretches over it, so there is still exactly one
     real link doing the navigating (keyboard, middle-click and open-in-new-tab all keep working) */
  .card .art::after { content: ""; position: absolute; inset: 0; }
  /* both rows wrap: in a two-across mobile grid a tile is ~150px, and a four-figure price next to a
     Buy button would otherwise push out of the card rather than move to the next line */
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem 0.5rem; flex-wrap: wrap; margin: 0.6rem 0.15rem 0.4rem; }
  .meta .id { font-family: var(--font-mono); font-weight: 650; color: var(--ink); }
  .meta .id:hover, .card:hover .meta .id { color: var(--accent); text-decoration: none; }
  /* anything with its own click has to sit above that overlay */
  .meta .id, .buy { position: relative; z-index: 1; }
  .tag { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); background: var(--accent-wash); padding: 0.05rem 0.45rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem 0.5rem; flex-wrap: wrap; padding: 0 0.15rem; }
  .price { font-family: var(--font-mono); font-weight: 650; }
  .buy { font-size: 0.8rem; padding: 0.32rem 0.75rem; }
  .sub2 { margin-top: 0.4rem; font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-3); min-height: 1rem; }
</style>
