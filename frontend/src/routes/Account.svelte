<script>
  import { loadBook, loadPage, pendingOf, wardenOf, withdraw, withdrawOffer, cancelListing, rocksOwnedBy } from "../lib/contracts.js";
  import { ABI } from "../lib/abi.js";
  import { fmtDate, isZero, errText } from "../lib/format.js";
  import { wallet } from "../lib/wallet.svelte.js";
  import { clearArtCache } from "../lib/artQueue.js";
  import RockCard from "../components/RockCard.svelte";
  import Refresh from "../components/Refresh.svelte";

  let pending = $state(null);
  let warden = $state(null);
  let myListings = $state([]);
  let myBids = $state([]);
  let owned = $state(null); // null until the opt-in scan runs
  let scanning = $state(false);
  let error = $state(null);

  const zero = "0x0000000000000000000000000000000000000000";

  $effect(() => {
    wallet.account;
    if (wallet.account) load();
  });

  async function load() {
    error = null;
    try {
      const me = wallet.account.toLowerCase();
      const [p, w, book] = await Promise.all([pendingOf(wallet.account), wardenOf(wallet.account), loadBook()]);
      pending = p;
      warden = w;
      myListings = book.filter((r) => r.listing && r.listing.seller.toLowerCase() === me);
      myBids = book.filter((r) => r.bid && r.bid.amount > 0n && r.bid.bidder.toLowerCase() === me);
    } catch (e) {
      error = e.message;
    }
  }

  // No toasts, so a failure shows in the card that caused it.
  const err = $state({});
  let busyWithdraw = $state(false);
  async function doWithdraw() {
    if (busyWithdraw) return;
    err.withdraw = null;
    busyWithdraw = true;
    try { await withdraw(); await load(); } catch (e) { err.withdraw = errText(e); } finally { busyWithdraw = false; }
  }

  // Escrowed ETH must always have a visible way out. This was the only market action with no UI at
  // all: withdrawOffer existed in the contract layer and was never wired to a control.
  let busyBid = $state(null);
  async function doWithdrawBid(id) {
    err.bid = null;
    busyBid = id;
    try { await withdrawOffer(BigInt(id)); await load(); } catch (e) { err.bid = errText(e); }
    busyBid = null;
  }

  let busyListing = $state(null);
  async function doCancel(id) {
    err.listing = null;
    busyListing = id;
    try { await cancelListing(BigInt(id)); await load(); } catch (e) { err.listing = errText(e); }
    busyListing = null;
  }

  async function scanOwned() {
    scanning = true;
    err.rocks = null;
    try { owned = await rocksOwnedBy(wallet.account); } catch (e) { owned = []; err.rocks = errText(e); }
    scanning = false;
    page = 0;
  }

  // Pressing Refresh means "everything on this page", so it re-runs the holdings scan too, but only
  // once you have opted into it. The auto-refresh timer calls `load` instead, deliberately: that
  // scan is an eth_getLogs over all of history plus an ownerOf per candidate, which is far too
  // expensive to put on a 15-second loop.
  async function refresh() {
    clearArtCache(); // same as the market: a manual refresh should not reuse old thumbnails
    await load();
    if (owned !== null) await scanOwned();
  }

  // Same paging as the market, for the same reason: every tile renders its own art from a tokenURI
  // read, so only the rocks actually on screen are ever fetched.
  const PER = 48;
  let page = $state(0);
  let rows = $state([]);
  const pages = $derived(owned ? Math.max(1, Math.ceil(owned.length / PER)) : 1);
  const pageIds = $derived(owned ? owned.slice(page * PER, (page + 1) * PER) : []);

  // Orders only; the tiles fetch their own art when they scroll into view. See Market.svelte.
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
</script>

<div class="head">
  <h1>Account</h1>
  {#if wallet.account}
    <div class="controls"><Refresh run={refresh} autoRun={load} /></div>
  {/if}
</div>

{#if !wallet.account}
  <p>Connect a wallet to see your rocks, orders, and proceeds.</p>
{:else if error}
  <p>Couldn't load: {error}</p>
{:else}
  <!-- both in full: these are addresses you copy out to an explorer or to send a rock to, and a
       truncated one is no use for that -->
  <p>Address: <span class="addr">{wallet.account}</span></p>
  <p>Warden: {#if warden && !isZero(warden)}<span class="addr">{warden}</span>{:else}none yet (create one on the Wrap page){/if}</p>

  <h2>Proceeds</h2>
  <div class="action-card">
    <p class="note">
      Withdrawable ETH the market owes you: rocks you sold, and bids you were outbid on.
    </p>
    <div class="row">
      <div class="fields">Owed to you: <strong>{pending != null ? ABI.formatEther(pending) + " ETH" : "…"}</strong></div>
      <div class="actions">
        <button type="button" class="primary" onclick={doWithdraw} disabled={busyWithdraw || !pending || pending === 0n}>{busyWithdraw ? "withdrawing…" : "Withdraw"}</button>
      </div>
    </div>
    {#if err.withdraw}<p class="failed">{err.withdraw}</p>{/if}
  </div>

  <h2>Your listings</h2>
  {#if myListings.length}
    <div class="action-card">
      <p class="note">
        Rocks you have up for sale right now. Cancelling takes one off the market.
      </p>
      <ul class="orders">
        {#each myListings as r (r.id)}
          <li>
            <span>
              <a href={"#/rock/" + r.id}>#{r.id}</a>
              <span class="mono">{ABI.formatEther(r.listing.price)} ETH</span>
              <span class="muted">expires {fmtDate(r.listing.expiry)}</span>
              {#if r.listing.onlyTo && r.listing.onlyTo !== zero}<span class="tag">private</span>{/if}
            </span>
            <button type="button" onclick={() => doCancel(r.id)} disabled={busyListing === r.id}>
              {busyListing === r.id ? "cancelling…" : "Cancel listing"}
            </button>
          </li>
        {/each}
      </ul>
      {#if err.listing}<p class="failed">{err.listing}</p>{/if}
    </div>
  {:else}<p>none</p>{/if}

  <h2>Your bids</h2>
  {#if myBids.length}
    <div class="action-card">
      <p class="note">
        Withdrawable ETH you have locked up as bids.
      </p>
      <ul class="orders">
        {#each myBids as r (r.id)}
          <li>
            <span><a href={"#/rock/" + r.id}>#{r.id}</a> <span class="mono">{ABI.formatEther(r.bid.amount)} ETH</span></span>
            <button type="button" onclick={() => doWithdrawBid(r.id)} disabled={busyBid === r.id}>
              {busyBid === r.id ? "withdrawing…" : "Withdraw bid"}
            </button>
          </li>
        {/each}
      </ul>
      {#if err.bid}<p class="failed">{err.bid}</p>{/if}
    </div>
  {:else}<p>none</p>{/if}

  <h2>Your rocks</h2>
  <div class="action-card">
    <p class="note">
      Finds every rock this address holds. This can take some time.
    </p>
    <div class="row">
      <div class="actions">
        <button type="button" onclick={scanOwned} disabled={scanning}>
          {scanning ? "scanning…" : owned === null ? "Load my rocks" : "Reload"}
        </button>
      </div>
    </div>
    {#if err.rocks}<p class="failed">{err.rocks}</p>{/if}
  </div>

  {#if scanning}
    <p class="muted">scanning…</p>
  {:else if owned && owned.length}
    <p class="muted count">{owned.length} rock{owned.length === 1 ? "" : "s"} held by this address.</p>
    <div class="rock-grid">
      {#each rows as r (r.id)}
        <RockCard row={r} />
      {/each}
    </div>
    {#if pages > 1}
      <div class="pager">
        <button type="button" onclick={() => (page = Math.max(0, page - 1))} disabled={page === 0}>← Prev</button>
        <span class="where">Page {page + 1} of {pages} · {owned.length} rocks</span>
        <button type="button" onclick={() => (page = Math.min(pages - 1, page + 1))} disabled={page >= pages - 1}>Next →</button>
      </div>
    {/if}
  {:else if owned}
    <p class="muted">no wrapped rocks found for this address</p>
  {/if}
{/if}

<style>
  /* one row per order: what it is on the left, the way out of it on the right */
  .orders {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .orders li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
    border-top: 1px solid var(--line);
  }
  .orders li:first-child {
    border-top: 0;
  }
  /* the left half of a row is several facts in a line, not one string */
  .orders li > span:first-child {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  /* same private-sale marker the market tiles use */
  .tag {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    background: var(--accent-wash);
    padding: 0.05rem 0.45rem;
  }
  .count { margin: 0 0 0.9rem; }
  /* a full address is 42 characters, so it has to be allowed to break rather than push the page wide */
  .addr { font-family: var(--font-mono); font-size: 0.9em; overflow-wrap: anywhere; }
  /* small enough that all 42 characters land on one line from ~360px up. Breaking is still allowed,
     but a wrap that leaves one character on its own line reads like a mistake. */
  @media (max-width: 560px) {
    .addr { font-size: 0.8em; }
  }
</style>
