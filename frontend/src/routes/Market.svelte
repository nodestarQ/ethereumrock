<script>
  import { wrappedIds, listedIds, bidIds, getListings, loadPage, buy, totalSupply, totalVolume } from "../lib/contracts.js";
  import { navigate } from "../lib/router.svelte.js";
  import { ABI } from "../lib/abi.js";
  import { errText, readIssue } from "../lib/format.js";
  import { wallet } from "../lib/wallet.svelte.js";
  import { config } from "../config.js";
  import { clearArtCache } from "../lib/artQueue.js";
  import RockCard from "../components/RockCard.svelte";
  import Refresh from "../components/Refresh.svelte";

  let allIds = $state([]);
  let saleIds = $state([]);
  let bidIdList = $state([]);
  let listingBy = $state({}); // id -> listing, for the price sort and the floor
  let supply = $state(null);
  let volume = $state(null);
  let floor = $state(null);
  let error = $state(null);
  let loading = $state(false);

  let filter = $state("all"); // all | sale | bids
  let sort = $state("id");
  let page = $state(0);
  let rows = $state([]);
  let jump = $state("");

  const PER = 48;

  $effect(() => {
    wallet.current;
    loadIndex();
  });

  // The index is cheap: three bitmap reads + supply + volume, then one batch read of the listed set.
  async function loadIndex() {
    loading = true;
    error = null;
    // An explicit refresh means "show me the chain as it is", so cached thumbnails stop counting.
    // This only affects tiles that mount after it: one already showing its art is left alone.
    clearArtCache();
    try {
      const [all, sale, bid, sup, vol] = await Promise.all([
        wrappedIds(),
        listedIds(),
        bidIds(),
        totalSupply().catch(() => null),
        totalVolume().catch(() => null),
      ]);
      allIds = all;
      saleIds = sale;
      bidIdList = bid;
      supply = sup;
      volume = vol;

      const ls = sale.length ? await getListings(sale) : [];
      const by = {};
      sale.forEach((id, i) => (by[id] = ls[i]));
      listingBy = by;
      const prices = ls.map((l) => l.price).filter((p) => p > 0n);
      floor = prices.length ? prices.reduce((m, p) => (p < m ? p : m)) : null;
      page = 0;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  const baseIds = $derived(filter === "sale" ? saleIds : filter === "bids" ? bidIdList : allIds);

  const ordered = $derived.by(() => {
    const ids = [...baseIds];
    if (sort === "price") {
      const p = (id) => (listingBy[id] && listingBy[id].price > 0n ? listingBy[id].price : 2n ** 200n);
      ids.sort((a, b) => {
        const pa = p(a), pb = p(b);
        return pa < pb ? -1 : pa > pb ? 1 : a - b;
      });
    } else {
      ids.sort((a, b) => a - b);
    }
    return ids;
  });

  const pages = $derived(Math.max(1, Math.ceil(ordered.length / PER)));
  const pageIds = $derived(ordered.slice(page * PER, (page + 1) * PER));

  // Only the orders for the rocks on screen. The art is not fetched here at all: each tile asks for
  // its own once it is near the viewport, and those requests are batched together (see artQueue.js),
  // so a page costs one call for what you can see rather than four for all forty-eight.
  $effect(() => {
    const slice = pageIds;
    let alive = true;
    if (!slice.length) {
      rows = [];
      return;
    }
    loadPage(slice)
      .then((r) => { if (alive) rows = r; })
      .catch(() => {});
    return () => { alive = false; };
  });

  function setFilter(f) {
    filter = f;
    page = 0;
  }

  function goJump(e) {
    e.preventDefault();
    const n = String(jump).trim();
    if (n === "") return;
    navigate("/rock/" + Number(n));
    jump = "";
  }

  // The gallery tile is too small to hold a message, so a failed buy reports above the grid.
  let buyError = $state(null);
  async function doBuy(id) {
    buyError = null;
    try {
      await buy(BigInt(id));
      await loadIndex();
    } catch (e) {
      buyError = "#" + id + ": " + errText(e);
    }
  }
</script>

<div class="head">
  <h1>Market</h1>
  <div class="controls">
    <form class="jump" onsubmit={goJump}>
      <label class="eyebrow">Go to rock
        <input type="number" min="0" bind:value={jump} placeholder="1234" size="6" />
      </label>
      <button type="submit">Open</button>
    </form>
    <label class="eyebrow">Sort
      <select bind:value={sort}>
        <option value="id">Id</option>
        <option value="price">Price</option>
      </select>
    </label>
    <Refresh run={loadIndex} />
  </div>
</div>

{#if error}
  <p class="muted">{readIssue(error, { connected: !!wallet.account, endpoint: config.rpcUrl })}</p>
{:else}
  <div class="statbar">
    <div class="stat"><span class="v">{saleIds.length}</span><span class="eyebrow">For sale</span></div>
    <div class="stat"><span class="v">{floor != null ? ABI.formatEther(floor) : "–"}<em>{floor != null ? " ETH" : ""}</em></span><span class="eyebrow">Floor</span></div>
    <div class="stat"><span class="v">{supply ?? "–"}</span><span class="eyebrow">Supply</span></div>
    <div class="stat"><span class="v">{volume != null ? ABI.formatEther(volume) : "–"}<em>{volume != null ? " ETH" : ""}</em></span><span class="eyebrow">Volume</span></div>
  </div>

  {#if buyError}<p class="failed">{buyError}</p>{/if}

  <div class="tabs">
    <button type="button" class:active={filter === "all"} onclick={() => setFilter("all")}>All ({allIds.length})</button>
    <button type="button" class:active={filter === "sale"} onclick={() => setFilter("sale")}>For sale ({saleIds.length})</button>
    <button type="button" class:active={filter === "bids"} onclick={() => setFilter("bids")}>With bids ({bidIdList.length})</button>
  </div>

  {#if loading && !allIds.length}
    <p class="muted">Loading…</p>
  {:else if !ordered.length}
    <p class="muted">
      {#if filter === "sale"}Nothing is listed right now.
      {:else if filter === "bids"}No standing bids right now.
      {:else}No rocks wrapped yet. <a href="#/wrap">Wrap one →</a>{/if}
    </p>
  {:else}
    <div class="rock-grid">
      {#each rows as r (r.id)}
        <RockCard row={r} buy={doBuy} />
      {/each}
    </div>

    {#if pages > 1}
      <div class="pager">
        <button type="button" onclick={() => (page = Math.max(0, page - 1))} disabled={page === 0}>← Prev</button>
        <span class="where">Page {page + 1} of {pages} · {ordered.length} rocks</span>
        <button type="button" onclick={() => (page = Math.min(pages - 1, page + 1))} disabled={page >= pages - 1}>Next →</button>
      </div>
    {/if}
  {/if}
{/if}

<style>
  /* .head and .controls are shared page-header styles in app.css */
  .jump { display: inline-flex; align-items: center; gap: 0.5rem; }

  .statbar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border: 1px solid var(--line);
    background: var(--surface);
    margin-bottom: 1.25rem;
    overflow: hidden;
  }
  .stat { padding: 0.9rem 1.1rem; border-left: 1px solid var(--line); }
  .stat:first-child { border-left: 0; }
  .stat .v { display: block; font-family: var(--font-mono); font-size: 1.45rem; font-weight: 650; line-height: 1.2; }
  .stat .v em { font-style: normal; font-size: 0.6em; color: var(--ink-2); }

  .tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .tabs button { font-size: 0.85rem; }
  .tabs button.active { background: var(--accent-wash); border-color: var(--accent); color: var(--accent); }

  @media (max-width: 560px) {
    .statbar { grid-template-columns: repeat(2, 1fr); }
    .stat { padding: 0.75rem 0.9rem; }
    .stat:nth-child(3) { border-left: 0; }
    .stat:nth-child(3), .stat:nth-child(4) { border-top: 1px solid var(--line); }
    /* the jump form takes its own row and the input takes what is left of it, so the label stops
       wrapping to "GO TO / ROCK" and the field stops sitting at some arbitrary default width.
       The label needs a small flex-basis rather than `auto`: at auto it claims the input's default
       width first and pushes Open off the row, since a button cannot shrink below its text. */
    .jump { width: 100%; flex-wrap: wrap; }
    /* min-width:0 lets the label shrink past the input's own idea of how wide it should be, which is
       what keeps Open on the row at 320px */
    .jump label { flex: 1 1 8rem; min-width: 0; white-space: nowrap; }
    .jump input { flex: 1 1 4rem; min-width: 0; }
    .jump button { flex: none; }
    .tabs { gap: 0.35rem; margin-bottom: 1.15rem; }
    .tabs button { font-size: 0.8rem; padding: 0.5rem 0.7rem; }
  }
</style>
