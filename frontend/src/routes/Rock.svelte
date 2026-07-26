<script>
  import {
    ownerOf, massOf, dustOf, listingOf, bidOf, saleOf, history, metadataOf, rolledOf,
    rawRockOwner, wardenOf,
    buy, makeOffer, withdrawOffer, acceptOfferBatched, cancelListing, listBatched, unwrap, merge, absorbBatched,
    pruneListing, isApprovedForAll, resolveAddress, transferBatched,
  } from "../lib/contracts.js";
  import { atomicSupported } from "../lib/batch.js";
  import { chainNow } from "../lib/rpc.js";
  import { ABI } from "../lib/abi.js";
  import { short, fmtDate, statusOf, isZero, errText, filled, idIssue, isAddress, dustIds, DUST_BATCH_MAX, buyIssue, bidPlan, readIssue } from "../lib/format.js";
  import { wallet } from "../lib/wallet.svelte.js";
  import { config } from "../config.js";
  import RockArt from "../components/RockArt.svelte";
  import Info from "../components/Info.svelte";
  import Addr from "../components/Addr.svelte";
  import Refresh from "../components/Refresh.svelte";

  let { id } = $props();

  let data = $state(null);
  let error = $state(null);
  let approved = $state(false);
  let oneClick = $state(false); // wallet can batch approve + list/accept into one confirmation (EIP-5792/7702)
  let hist = $state(null);

  // form state
  let bidStr = $state("");
  let priceStr = $state("");
  let daysStr = $state("30");
  let privateSale = $state(false); // reveals the buyer field; off = public listing
  let buyerStr = $state(""); // the private-sale recipient: an address or a .gwei name, while privateSale is on
  // A typed name is resolved to the address that actually goes on chain; shown for confirmation.
  let buyerResolved = $state(null); // { name, address } once a name resolves
  let buyerResolving = $state(false);
  // Transfer / give-away recipient: the same "address or .gwei name" input as the private-sale buyer.
  let recipientStr = $state("");
  let recipientResolved = $state(null);
  let recipientResolving = $state(false);
  let mergeOther = $state("");
  let mergeLook = $state("0");
  let absorbHigh = $state("");

  $effect(() => {
    wallet.current;
    wallet.account;
    id;
    load();
    refreshOneClick();
  });

  async function load() {
    error = null;
    try {
      const bid = BigInt(id);
      const [owner, mass, dust, listing, bidv, sale, meta, rolled] = await Promise.all([
        ownerOf(bid), massOf(bid), dustOf(bid), listingOf(bid), bidOf(bid), saleOf(bid),
        // reverts for an id with no live token, which is a normal state here, not an error
        metadataOf(bid).catch(() => null),
        // tells apart the three ways a rock can have no live token: never wrapped, unwrapped and
        // re-wrappable, or merged away for good. mass is deleted on a merge but kept on an unwrap.
        rolledOf(bid).catch(() => false),
      ]);
      data = { owner, mass, dust, listing, bid: bidv, sale, meta, rolled };
      if (wallet.account) approved = await isApprovedForAll(wallet.account).catch(() => false);
    } catch (e) {
      error = e.message;
    }
  }

  async function refreshOneClick() {
    oneClick = wallet.account ? await atomicSupported() : false;
  }

  const isOwner = $derived(data && data.owner && wallet.account && data.owner.toLowerCase() === wallet.account.toLowerCase());
  const listed = $derived(data && data.listing && !isZero(data.listing.seller));
  const hasBid = $derived(data && data.bid && data.bid.amount > 0n);
  const isBidder = $derived(hasBid && wallet.account && data.bid.bidder.toLowerCase() === wallet.account.toLowerCase());
  // Set only when a merge on THIS page just burned this rock, so the panel that replaces the page can
  // say where it went. Nothing is stored: the chain keeps no pointer, and this is a heads-up for the
  // person who just clicked, not a record. App.svelte keys the route on the id, so navigating away
  // destroys it; from then on this rock reads "merged away" like it does for everyone else.
  let mergedTo = $state(null);

  // A private listing can only be filled by the address it names. Everything needed to know that is
  // already in the listing this page loaded, so the button says so instead of letting the buy fail.
  const buyBlocker = $derived(listed && !isOwner ? buyIssue(data.listing, wallet.account) : null);
  // The field is always the TOTAL you want the bid to be, which is how people think about it.
  // What gets SENT differs: raising your own bid is a top-up on chain, so only the difference
  // leaves your wallet and the escrow already in stays put.
  //
  // Answered from the bid this page read, so it is instant. That copy goes stale, which is what
  // doBid re-reads for.
  const bidPreview = $derived.by(() => {
    if (!filled(bidStr)) return null;
    let total = null;
    try { total = ABI.parseEther(bidStr.trim()); } catch { total = null; }
    return bidPlan(total, hasBid ? data.bid.amount : 0n, !!isBidder);
  });

  // makeOffer compares against whatever stands when it executes, not when the page loaded, so the
  // standing bid is read again before asking for a signature. A bid that has been beaten in the
  // meantime then costs a refused click instead of a reverted transaction and its gas. The amount
  // to send is computed from that fresh read too: if you were outbid while this page sat open,
  // `isBidder` is stale and the old code would have sent only the difference.
  let bidBusy = $state(false);
  async function doBid() {
    err.bid = null;
    if (bidPreview?.issue) { err.bid = bidPreview.issue; return; }
    bidBusy = true;
    try {
      const total = ABI.parseEther(bidStr.trim());
      const live = await bidOf(nid());
      const standing = live.amount > 0n ? live.amount : 0n;
      const mine =
        standing > 0n && !!wallet.account && live.bidder.toLowerCase() === wallet.account.toLowerCase();
      const plan = bidPlan(total, standing, mine);
      if (plan.issue) {
        err.bid = plan.issue;
        await load(); // the hint under the field was answering from a stale bid; show the real one
        return;
      }
      await makeOffer(nid(), plan.send);
      bidStr = "";
      await load();
    } catch (e) {
      err.bid = errText(e);
    } finally {
      bidBusy = false;
    }
  }

  // Accepting takes no input. The floor the contract needs is the amount this page is showing you,
  // so that is what gets sent: you either sell for what you saw or the transaction reverts, and a
  // bid that rose in the meantime still goes through at the higher price. The fresh read is only so
  // a bid that was pulled or replaced by a smaller one costs a refused click instead of gas.
  async function doAccept() {
    await run("accept", async () => {
      const shown = data.bid.amount; // what the button says, and what the seller is agreeing to
      const live = await bidOf(nid());
      if (live.amount < shown) {
        // Whatever stands now is worse than the offer on screen. Reload first, so the card shows the
        // real bid and a second press is a decision about that one rather than a repeat of this error.
        await load();
        throw new Error(
          live.amount === 0n
            ? "That bid has been withdrawn."
            : `The bid dropped to ${ABI.formatEther(live.amount)} ETH. Accept again if you still want it.`,
        );
      }
      await acceptOfferBatched(nid(), shown);
    });
  }

  // Failures land in the card that raised them, keyed by action. There is no toast layer, so an
  // action that goes wrong has to say so where the user clicked.
  const err = $state({});
  const busy = $state({}); // per-action pending flag, so a button can disable and say "…" while it runs
  async function run(key, fn) {
    if (busy[key]) return;
    err[key] = null;
    busy[key] = true;
    try { await fn(); await load(); } catch (e) { err[key] = errText(e); } finally { busy[key] = false; }
  }
  const nid = () => BigInt(id);
  // Is `a` the connected wallet? Used to print "you" where a rock you own or a bid you placed would
  // otherwise show your own address or name back to you.
  const me = (a) => !!wallet.account && !!a && a.toLowerCase() === wallet.account.toLowerCase();

  // An empty field is not "rock #0". BigInt("") is 0n, so without these gates clicking Merge on a
  // blank field merges this rock into #0, which burns it. Nothing reaches a signature until the
  // number is real.
  const mergeIssue = $derived(
    idIssue(mergeOther) ??
      (filled(mergeOther) && Number(mergeOther) === Number(id) ? "A rock can't merge with itself." : null),
  );
  const canMerge = $derived(filled(mergeOther) && !mergeIssue);
  // Dust is fungible in everything but its numbering: unlimited supply, each worth exactly +1. So
  // the field takes however many you want to spend, as a list or a range, rather than one id.
  const absorbParsed = $derived(dustIds(absorbHigh));
  const canAbsorb = $derived(absorbParsed.ids.length > 0 && !absorbParsed.issue);

  // Guards the private-sale field before it reaches the wallet: only checked while the toggle is on.
  // A non-address would revert in the encoder, and the contract rejects your own address (a private
  // sale to yourself is pointless and listTo has no self-check, so buy would just never be fillable).
  // The buyer field takes an address or a .gwei name. A name is resolved to an address (debounced),
  // and that resolved address is what lists, so the seller confirms exactly who can buy. resolveAddress
  // is best-effort: a name that resolves to nothing leaves buyerAddr null and the button disabled.
  $effect(() => {
    const s = buyerStr.trim();
    buyerResolved = null;
    buyerResolving = false;
    if (!privateSale || !s || isAddress(s)) return; // an address (or an empty/off field) needs no lookup
    let alive = true;
    buyerResolving = true;
    const t = setTimeout(async () => {
      const addr = await resolveAddress(s).catch(() => null);
      if (!alive) return;
      buyerResolved = addr ? { name: s, address: addr } : null;
      buyerResolving = false;
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  });

  // The address a private listing will actually store: the field verbatim if it is one, else the
  // resolved name. null while a name is still resolving or did not resolve, which gates the button.
  const buyerAddr = $derived(
    !privateSale ? null : isAddress(buyerStr.trim()) ? buyerStr.trim() : (buyerResolved?.address ?? null),
  );

  const listIssue = $derived.by(() => {
    if (!privateSale) return null;
    const s = buyerStr.trim();
    if (!filled(s)) return "Enter the address or .gwei name allowed to buy, or turn off private sale.";
    // A name still resolving, or resolved to nothing, is not an error here: the resolution note says
    // what is happening and the button stays disabled while buyerAddr is null.
    if (!isAddress(s) && (buyerResolving || !buyerResolved)) return null;
    if (buyerAddr && me(buyerAddr)) {
      return "That's your own address. Name someone else, or turn off private sale.";
    }
    return null;
  });

  // A listing needs a real, positive price: _list reverts with ZeroPrice() on 0 (both public and
  // private lists go through it), and the price is a uint96. Gate it here so 0, a blank, or an
  // unparseable price never reaches the wallet. This is also what stops a 0 ETH "private sale" from
  // reading as a way to give a rock away: there is no such path, the sale would just fail.
  const MAX_UINT96 = (1n << 96n) - 1n;
  const priceWei = $derived.by(() => {
    const s = priceStr.trim();
    if (!s) return null;
    try { return ABI.parseEther(s); } catch { return null; }
  });
  const priceIssue = $derived.by(() => {
    if (!filled(priceStr)) return null; // nothing typed yet, so nothing to complain about
    if (priceWei == null) return "Enter a price in ETH, like 1.5.";
    if (priceWei === 0n) return "A listing needs a price above 0 ETH. You can't give a rock away by listing at 0; that sale would fail.";
    if (priceWei > MAX_UINT96) return "That price is larger than a listing can hold.";
    return null;
  });

  async function doList() {
    if (!filled(priceStr) || priceIssue || listIssue || (privateSale && !buyerAddr)) return; // same gate as the button
    await run("list", async () => {
      const { time } = await chainNow();
      const expiry = time + Number(daysStr || "30") * 86400;
      const buyer = privateSale ? buyerAddr : null; // the resolved address, never the raw name
      await listBatched(nid(), priceWei, expiry, buyer);
    });
  }

  // Transfer recipient resolution, parallel to the private-sale buyer field above (address or name).
  $effect(() => {
    const s = recipientStr.trim();
    recipientResolved = null;
    recipientResolving = false;
    if (!s || isAddress(s)) return;
    let alive = true;
    recipientResolving = true;
    const t = setTimeout(async () => {
      const addr = await resolveAddress(s).catch(() => null);
      if (!alive) return;
      recipientResolved = addr ? { name: s, address: addr } : null;
      recipientResolving = false;
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  });
  const recipientAddr = $derived(isAddress(recipientStr.trim()) ? recipientStr.trim() : (recipientResolved?.address ?? null));
  const transferIssue = $derived.by(() => {
    const s = recipientStr.trim();
    if (!filled(s)) return null;
    if (!isAddress(s) && (recipientResolving || !recipientResolved)) return null; // resolving / no match: note says so
    if (recipientAddr && me(recipientAddr)) return "That's your own address. A transfer sends the rock to someone else.";
    return null;
  });
  async function doTransfer() {
    if (transferIssue || !recipientAddr) return; // same gate as the button
    await run("transfer", async () => {
      await transferBatched(nid(), recipientAddr);
      recipientStr = ""; // sent; the card resets (and isOwner flips false on reload, hiding it)
    });
  }

  // Merge and absorb both check on submit, the way the wrap card does: name the real problem and
  // send nothing, rather than letting a doomed transaction reach the wallet and come back as a bare
  // contract revert string. Checked on click, not while typing, so the fields fire no RPC.
  async function mergeBlocker(otherB) {
    const me = (wallet.account || "").toLowerCase();
    const [mine, theirs] = await Promise.all([ownerOf(nid()), ownerOf(otherB)]);
    if (!theirs) return `Rock #${otherB} isn't wrapped, so there is nothing there to merge.`;
    if (theirs.toLowerCase() !== me) return `You don't own rock #${otherB}. A merge needs both rocks in one wallet.`;
    if (!mine || mine.toLowerCase() !== me) return `You no longer own rock #${id}.`;
    // the contract burns the HIGHER id, and 0-99 can never burn, so two low rocks cannot merge
    if ((otherB > nid() ? otherB : nid()) < 100n) {
      return `#${id} and #${otherB} are both under 100, and rocks 0-99 can never be burned. One of the two has to be 100 or above.`;
    }
    return null;
  }

  async function doMerge() {
    await run("merge", async () => {
      const otherB = BigInt(mergeOther);
      const blocker = await mergeBlocker(otherB).catch(() => null);
      if (blocker) throw new Error(blocker); // surfaces in err.merge via run, same slot as a revert
      await merge(nid(), otherB, BigInt(mergeLook));
      // The higher id burns. If that was the rock whose page this is, the reload below replaces the
      // whole page with the "merged away" panel, so hand it the survivor's number to point at.
      if (nid() > otherB) mergedTo = Number(otherB);
      // the other rock is burned now, so leaving its number in the field only invites a second
      // submit that reverts on an id that no longer exists
      mergeOther = "";
    });
  }
  // Absorb burns dust rocks (ids >= 10000) into this one, +1 each. Every rock is a gift plus a
  // burn, batched into one confirmation where the wallet supports it, sequential otherwise.
  // A dust rock you hold needs gifting into the warden first; one already sitting in the warden
  // (a gift that landed when the absorb did not) must NOT be gifted again, or that call reverts.
  // Anything else is not yours to burn.
  async function absorbPlan(ids) {
    const mine = (wallet.account || "").toLowerCase();
    const [warden, owners] = await Promise.all([
      wardenOf(wallet.account).catch(() => null),
      Promise.all(ids.map((h) => rawRockOwner(h).catch(() => null))),
    ]);
    const me = (warden || "").toLowerCase();
    const stray = ids.filter((h, i) => {
      const o = (owners[i] || "").toLowerCase();
      return o !== mine && o !== me;
    });
    if (stray.length) {
      const shown = stray.slice(0, 4).join(", #");
      return {
        issue:
          stray.length === 1
            ? `You don't hold raw dust rock #${shown} on the v1 contract, so it cannot be absorbed.`
            : `${stray.length} of these are not yours on the v1 contract: #${shown}${stray.length > 4 ? ", …" : ""}.`,
      };
    }
    return { needGift: ids.filter((h, i) => (owners[i] || "").toLowerCase() === mine) };
  }

  async function doAbsorb() {
    await run("absorb", async () => {
      const plan = await absorbPlan(absorbParsed.ids).catch(() => ({ needGift: absorbParsed.ids }));
      if (plan.issue) throw new Error(plan.issue);
      await absorbBatched(absorbParsed.ids, nid(), plan.needGift);
      absorbHigh = ""; // spent, so clear the list rather than inviting a re-send
    });
  }

  async function loadHistory() {
    hist = "loading…";
    err.history = null;
    try { hist = await history(nid()); } catch (e) { hist = []; err.history = errText(e); }
  }

  // Pressing Refresh means everything on this page: the rock, its orders, and the sale history if
  // you have already asked for it. The auto-refresh timer calls `load` instead, deliberately: the
  // history walk is one getLogs per past sale, which has no business running every 15 seconds.
  async function refresh() {
    await load();
    if (Array.isArray(hist)) await loadHistory();
  }
</script>

<!-- Back to the gallery. Styled as a button, but it stays an anchor on purpose: a real href is what
     keeps middle-click, cmd-click, "open in new tab" and the browser's own back/forward working. A
     <button> with an onclick would look identical and quietly lose all four. Same call as the nav's
     address chip. The chevron is drawn rather than typed, so it renders identically everywhere
     instead of depending on the font's arrow glyph. -->
<p class="backrow">
  <a class="back" href="#/market">
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M10 3 L5 8 L10 13" />
    </svg>
    Market
  </a>
</p>
<div class="head">
  <h1>Rock #{id}</h1>
  <div class="controls"><Refresh run={refresh} autoRun={load} /></div>
</div>

{#if error}
  <p class="muted">{readIssue(error, { connected: !!wallet.account, endpoint: config.rpcUrl })}</p>
{:else if !data}
  <p class="muted">loading…</p>
{:else if !data.owner}
  <div class="unwrapped">
    {#if Number(id) >= 10000}
      <p><strong>Rock #{id} is dust.</strong></p>
      <p class="muted">
        Rocks above id 9999 can't be wrapped. They can only be absorbed into a rock you own, adding
        +1 Dust to it.
      </p>
      <p><a class="cta" href="#/wrap">Go to wrap →</a></p>
    {:else if data.rolled && data.mass === 0n}
      <p><strong>Rock #{id} has been merged away.</strong></p>
      {#if mergedTo != null}
        <p class="muted">
          You just merged it into <a href={"#/rock/" + mergedTo}>rock #{mergedTo}</a>. Its mass and
          dust are there now, and this id can never be wrapped again.
        </p>
        <p><a class="cta" href={"#/rock/" + mergedTo}>View rock #{mergedTo} →</a></p>
      {:else}
        <p class="muted">
          Its mass and dust went to a lower id. This id can never be wrapped again.
        </p>
        <p><a class="cta" href="#/market">Browse the market →</a></p>
      {/if}
    {:else if data.rolled}
      <p><strong>Rock #{id} is unwrapped.</strong></p>
      <p class="muted">
        Someone holds the raw 2017 rock right now. Wrapping it again brings back this exact rock,
        with the same art, mass and dust.
      </p>
      <p><a class="cta" href="#/wrap">Wrap a rock →</a></p>
    {:else}
      <p><strong>Rock #{id} isn't wrapped yet.</strong></p>
      <p class="muted">
        There's no token for this id yet, so it can't be bought or bid on. If you hold the raw 2017
        rock, wrap it and it becomes tradeable here.
      </p>
      <p><a class="cta" href="#/wrap">Wrap a rock →</a></p>
    {/if}
  </div>
{:else}
  <div class="detail-head">
    <!-- the image comes from the same metadata read as the traits, so a merge that rewrites this
         rock's seed shows up here immediately instead of leaving the old art on screen -->
    <div class="artwrap"><RockArt {id} fluid src={data.meta?.image} /></div>
    <div class="facts">
      <h2>Traits</h2>
      <dl>
        <!-- Straight from the token's on-chain metadata, so this is the same set a marketplace
             shows: Id, Status, Mass, Dust, Color, Hue, Size. -->
        {#if data.meta}
          {#each data.meta.attributes as a (a.trait_type)}
            <dt>{a.trait_type}</dt>
            <dd>
              {#if a.trait_type === "Status"}
                <span class="tag" class:defined={a.value === "DEFINED"}>{a.value}</span>
              {:else if a.trait_type === "Color"}
                <span class="swatch" style="background:{a.value}"></span><span class="mono">{a.value}</span>
              {:else}
                {a.value}
              {/if}
            </dd>
          {/each}
        {:else}
          <dt>Status</dt><dd><span class="tag" class:defined={statusOf(id, 10000) === "DEFINED"}>{statusOf(id, 10000)}</span></dd>
          <dt>Mass</dt><dd>{data.mass}</dd>
          <dt>Dust</dt><dd>{data.dust}</dd>
        {/if}
        <dt>Owner</dt><dd>{#if data.owner}<Addr address={data.owner} stacked />{:else}not wrapped (no live token){/if}</dd>
      </dl>
    </div>
  </div>

  <h2>Orders</h2>
  <div class="orders">
    <p>
      <!-- no comma after the price: these are flex items with a gap between them, so a comma lands
           after a space and reads as a dangling one. The gap is the separator. -->
      <span class="ok">Listing</span> {#if listed}<strong>{ABI.formatEther(data.listing.price)} ETH</strong> expires {fmtDate(data.listing.expiry)}
        {#if !isZero(data.listing.onlyTo)} (private to {me(data.listing.onlyTo) ? "you" : short(data.listing.onlyTo)}){/if}
      {:else}none{/if}
    </p>
    <p><span class="ok">Top bid</span> {#if hasBid}<strong>{ABI.formatEther(data.bid.amount)} ETH</strong> by {me(data.bid.bidder) ? "you" : short(data.bid.bidder)}{:else}none{/if}</p>
    <p><span class="ok">Last sale</span> {#if data.sale.count > 0n}<strong>{ABI.formatEther(data.sale.price)} ETH</strong> ({data.sale.count} total){:else}never sold{/if}</p>
  </div>

  {#if !wallet.account}
    <p><em>Connect a wallet to trade.</em></p>
  {:else}
    <h2>Actions</h2>

    <!-- Both selling paths need the market approved first, so the same line belongs on both cards. -->
    {#snippet approvalNote()}
      {#if !approved}
        {#if oneClick}
          Your wallet can batch, so this approves the market in the same confirmation.
        {:else}
          This asks you to approve the market first, so it is two confirmations.
        {/if}
      {/if}
    {/snippet}

    {#if listed && !isOwner}
      <div class="action-card">
        <p class="note">
          Buys this rock for {ABI.formatEther(data.listing.price)} ETH and sends it to your wallet.
        </p>
        <div class="row">
          <div class="actions">
            <button type="button" class="primary" onclick={() => run("buy", () => buy(nid()))} disabled={!!buyBlocker || busy.buy}>{busy.buy ? "buying…" : "Buy for " + ABI.formatEther(data.listing.price) + " ETH"}</button>
          </div>
        </div>
        {#if buyBlocker}<p class="note bad">{buyBlocker}</p>{/if}
        {#if err.buy}<p class="failed">{err.buy}</p>{/if}
      </div>
    {/if}

    <!-- Shown to the standing bidder even if they own the rock, because a bid is escrowed ETH and
         there must always be a way out of it. -->
    {#if !isOwner || isBidder}
      <div class="action-card">
        <p class="note">
          Locks up ETH as a bid. If the owner accepts it the rock is yours, and if not you can take
          your ETH back at any time. Enter the <strong>total</strong> you want your bid to be.
          {#if isBidder}
            <strong>Your {ABI.formatEther(data.bid.amount)} ETH is locked here now.</strong>
            Raising your bid costs only the difference. Taking it back sends the whole
            {ABI.formatEther(data.bid.amount)} ETH to your wallet in one transaction.
          {:else if hasBid}
            <strong>The current bid is {ABI.formatEther(data.bid.amount)} ETH, so yours has to beat
            it.</strong>
          {/if}
        </p>
        <div class="row">
          {#if !isOwner}
            <div class="fields">
              <label>Bid <input type="text" bind:value={bidStr} placeholder="0.5" size="8" /> ETH</label>
            </div>
          {/if}
          <div class="actions">
            {#if !isOwner}
              <button type="button" class="primary" onclick={doBid} disabled={!filled(bidStr) || !!bidPreview?.issue || bidBusy || busy.bid}>
                {bidBusy ? "placing…" : "Make / raise offer"}
              </button>
            {/if}
            {#if isBidder}
              <button type="button" onclick={() => run("bid", () => withdrawOffer(nid()))} disabled={busy.bid || bidBusy}>{busy.bid ? "withdrawing…" : "Withdraw your bid"}</button>
            {/if}
          </div>
        </div>
        {#if bidPreview?.issue}
          <p class="note bad">{bidPreview.issue}</p>
        {:else if bidPreview?.kind === "raise"}
          <p class="note">
            Costs you <strong>{ABI.formatEther(bidPreview.send)} ETH</strong>, since you already have
            {ABI.formatEther(bidPreview.now)} ETH locked up.
          </p>
        {:else if bidPreview?.kind === "outbid"}
          <p class="note">
            Locks up the full <strong>{ABI.formatEther(bidPreview.total)} ETH</strong>.
          </p>
        {:else if bidPreview?.kind === "first"}
          <p class="note">
            Locks up <strong>{ABI.formatEther(bidPreview.total)} ETH</strong> until the owner accepts
            it or you take it back.
          </p>
        {/if}
        {#if err.bid}<p class="failed">{err.bid}</p>{/if}
      </div>
    {/if}

    {#if isOwner}
      <!-- `list` overwrites the listing slot outright, so on a live listing this is an edit of the
           price and expiry, not a second listing. -->
      <div class="action-card">
        <p class="note">
          Puts this rock up for sale at a price you set. Anyone can buy it until the listing expires,
          or just one address if you make it a private sale. Listing again updates the current
          listing. {@render approvalNote()}
        </p>
        <div class="row">
          <div class="fields">
            <label>List at <input type="text" bind:value={priceStr} placeholder="1.5" size="8" /> ETH for
              <input type="number" bind:value={daysStr} min="1" size="4" /> days</label>
            <div class="private">
              <label class="check"><input type="checkbox" bind:checked={privateSale} /> Private sale (one address only)</label>
              {#if privateSale}
                <label>Sell only to <input type="text" bind:value={buyerStr} placeholder="0x… or name.gwei" size="20" /></label>
              {/if}
            </div>
          </div>
          <div class="actions">
            <button type="button" class="primary" onclick={doList} disabled={!filled(priceStr) || !!priceIssue || !!listIssue || (privateSale && !buyerAddr) || busy.list || busy.cancel}>
              {busy.list ? "listing…" : listed ? "Update listing" : privateSale ? "List privately" : "List"}
            </button>
            {#if listed}
              <button type="button" onclick={() => run("cancel", () => cancelListing(nid()))} disabled={busy.cancel || busy.list}>{busy.cancel ? "cancelling…" : "Cancel listing"}</button>
            {/if}
          </div>
        </div>
        {#if priceIssue}<p class="note bad">{priceIssue}</p>{/if}
        {#if privateSale && filled(buyerStr) && !isAddress(buyerStr.trim())}
          {#if buyerResolving}
            <p class="note">Resolving name…</p>
          {:else if buyerResolved}
            <p class="note">Lists to <span class="mono">{buyerResolved.address}</span></p>
          {:else}
            <p class="note bad">No address is registered for that name. Check the spelling, or enter an address.</p>
          {/if}
        {/if}
        {#if listIssue}<p class="note bad">{listIssue}</p>{/if}
        {#if err.list}<p class="failed">{err.list}</p>{/if}
        {#if err.cancel}<p class="failed">{err.cancel}</p>{/if}
      </div>
      {#if hasBid}
        <div class="action-card">
          <p class="note">
            Sells this rock to the current bidder for {ABI.formatEther(data.bid.amount)} ETH{#if listed && me(data.listing.seller)} and cancels your listing{/if}.
            {@render approvalNote()}
          </p>
          <div class="row">
            <div class="actions">
              <button type="button" class="primary" onclick={doAccept} disabled={busy.accept}>{busy.accept ? "accepting…" : "Accept " + ABI.formatEther(data.bid.amount) + " ETH"}</button>
            </div>
          </div>
          {#if err.accept}<p class="failed">{err.accept}</p>{/if}
        </div>
      {/if}

      <h3>Consolidate</h3>
      <div class="action-card">
        <p class="note">
          Combines two rocks you own into one. The lower id survives with both rocks' mass and dust,
          and the higher id is burned. You pick which art it keeps.
        </p>
        <div class="row">
          <div class="fields">
            <label>Merge with #<input type="number" min="0" bind:value={mergeOther} size="6" /></label>
            <label>keep <select bind:value={mergeLook}>
              <option value="0">this rock's look</option>
              <option value="1">the other's look</option>
              <option value="2">reroll</option>
            </select></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" onclick={doMerge} disabled={!canMerge || busy.merge}>{busy.merge ? "merging…" : "Merge"}</button>
          </div>
        </div>
        {#if mergeIssue}<p class="note bad">{mergeIssue}</p>{/if}
        {#if err.merge}<p class="failed">{err.merge}</p>{/if}
      </div>
      <div class="action-card">
        <p class="note">
          Burns rocks above id 9999 that you own, each one adding +1 Dust to this rock.
          Type the ids, or a range like <span class="mono">10001-10005</span> (max
          {DUST_BATCH_MAX} at a time).
        </p>
        <div class="row">
          <div class="fields">
            <label>Absorb dust <input type="text" bind:value={absorbHigh} size="20" placeholder="10001, 10004-10006" /></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" onclick={doAbsorb} disabled={!canAbsorb || busy.absorb}>{busy.absorb ? "absorbing…" : "Absorb into #" + id}</button>
          </div>
        </div>
        {#if absorbParsed.issue}
          <p class="note bad">{absorbParsed.issue}</p>
        {:else if absorbParsed.ids.length}
          <p class="note">
            {absorbParsed.ids.length} dust {absorbParsed.ids.length === 1 ? "rock" : "rocks"},
            taking this rock's Dust from {data.dust} to {data.dust + BigInt(absorbParsed.ids.length)}.
            {#if oneClick}
              Your wallet can batch, so this is one confirmation.
            {:else}
              {absorbParsed.ids.length * 2} transactions, since your wallet cannot batch.
            {/if}
          </p>
        {/if}
        {#if err.absorb}<p class="failed">{err.absorb}</p>{/if}
      </div>

      <h3>Unwrap</h3>
      <div class="action-card">
        <p class="note">
          Turns this token back into the raw 2017 rock.
        </p>
        <div class="row">
          <div class="actions">
            <button type="button" class="primary" onclick={() => run("unwrap", () => unwrap(nid()))} disabled={busy.unwrap}>{busy.unwrap ? "unwrapping…" : "Unwrap"}</button>
          </div>
        </div>
        {#if err.unwrap}<p class="failed">{err.unwrap}</p>{/if}
      </div>

      <h3>Transfer</h3>
      <div class="action-card">
        <p class="note">
          Gifts this rock to an address or .gwei name.
          {#if listed && me(data.listing.seller)}
            It is listed, so the transfer cancels that listing too{#if !oneClick}, in a second
            transaction{/if}.
          {/if}
        </p>
        <div class="row">
          <div class="fields">
            <label>Send to <input type="text" bind:value={recipientStr} placeholder="0x… or name.gwei" size="20" /></label>
          </div>
          <div class="actions">
            <button type="button" class="primary" onclick={doTransfer} disabled={!recipientAddr || !!transferIssue || busy.transfer}>{busy.transfer ? "sending…" : "Transfer"}</button>
          </div>
        </div>
        {#if filled(recipientStr) && !isAddress(recipientStr.trim())}
          {#if recipientResolving}
            <p class="note">Resolving name…</p>
          {:else if recipientResolved}
            <p class="note">Sends to <span class="mono">{recipientResolved.address}</span></p>
          {:else}
            <p class="note bad">No address is registered for that name. Check the spelling, or enter an address.</p>
          {/if}
        {/if}
        {#if transferIssue}<p class="note bad">{transferIssue}</p>{/if}
        {#if err.transfer}<p class="failed">{err.transfer}</p>{/if}
      </div>
    {/if}

    <div class="action-card">
      <p class="note">
        Removes a listing that can no longer be bought, like an expired one.
      </p>
      <div class="row">
        <div class="actions">
          <button type="button" class="primary" onclick={() => run("prune", () => pruneListing(nid()))} disabled={busy.prune}>{busy.prune ? "pruning…" : "Prune this listing"}</button>
        </div>
      </div>
      {#if err.prune}<p class="failed">{err.prune}</p>{/if}
    </div>
  {/if}

  <h2>Price history <Info text="Every sale of this rock, newest first." /></h2>
  <p><button type="button" onclick={loadHistory}>Load history</button></p>
  {#if err.history}<p class="failed">{err.history}</p>{/if}
  {#if hist === "loading…"}
    <p class="muted">loading…</p>
  {:else if Array.isArray(hist)}
    {#if hist.length}
      <div class="ledger-wrap">
        <table class="ledger">
          <thead><tr><th>Block</th><th>Price</th><th>Kind</th><th>Seller</th><th>Buyer</th></tr></thead>
          <tbody>
            {#each hist as h (h.block + ":" + h.buyer)}
              <tr>
                <td>{h.block}</td>
                <td>{ABI.formatEther(h.price)} ETH</td>
                <td>{h.kind}</td>
                <td class="addr"><Addr address={h.seller} /></td>
                <td class="addr"><Addr address={h.buyer} /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="muted">No sales yet.</p>
    {/if}
  {/if}
{/if}

<style>
  /* The back control. Box copied from the global `button` rule in app.css, because an anchor does not
     inherit it; keep the two in step. Touch sizing comes from app.css's pointer:coarse block, which
     targets `button` only, so the padding bump is repeated here. */
  .backrow { margin: 0 0 1rem; }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
    font-weight: 550;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: var(--radius);
    padding: 0.45rem 0.85rem;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s, color 0.12s, transform 0.04s;
  }
  .back:hover { color: var(--accent); border-color: var(--accent); text-decoration: none; }
  .back:active { transform: translateY(1px); }
  .back svg { display: block; flex: none; }
  @media (pointer: coarse) {
    .back { padding: 0.55rem 0.95rem; }
  }

  /* the private-sale toggle: a plain checkbox, muted until it does something. flex-basis pushes the
     whole toggle onto its own line under the price field, so the listing row reads as one thought
     and the toggle as a modifier below it. The label keeps its natural width, so the hit target
     stops at the text instead of spanning the card. */
  .private { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.9rem; }
  .check { cursor: pointer; color: var(--ink-2); }
  .check input { cursor: pointer; }
  .unwrapped { max-width: 42rem; border: 1px solid var(--line); background: var(--surface); padding: 1.25rem 1.4rem; }
  .unwrapped p:last-child { margin-bottom: 0; }
  .cta {
    display: inline-block;
    margin-top: 0.35rem;
    padding: 0.5rem 1.1rem;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 550;
  }
  .cta:hover { background: var(--accent-2); border-color: var(--accent-2); color: var(--on-accent); text-decoration: none; }

  .detail-head {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 1.5rem 2.25rem;
    align-items: start;
    margin-bottom: 1.25rem;
  }
  .facts h2 { margin-top: 0; margin-bottom: 0.9rem; }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.65rem 1.5rem;
    align-items: center;
  }
  dl dd { font-size: 0.95rem; overflow-wrap: anywhere; }
  .tag {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    padding: 0.12rem 0.55rem;
    background: var(--surface-2);
    border: 1px solid var(--line-2);
    color: var(--ink-2);
  }
  .tag.defined { background: var(--accent-wash); border-color: transparent; color: var(--accent); }
  /* the Color trait is a hex string, which reads as nothing without the colour beside it */
  .swatch {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    margin-right: 0.4rem;
    vertical-align: -0.08rem;
    border: 1px solid var(--line-2);
  }
  .orders {
    display: grid;
    gap: 0.55rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 1rem 1.15rem;
  }
  .orders p { margin: 0; display: flex; gap: 0.85rem; align-items: baseline; }
  .orders .ok {
    flex: none;
    width: 5rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ink-2);
  }
  h2 { margin: 2rem 0 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--line); }
  h3 { margin: 1.6rem 0 0.6rem; }
  /* light table, mono figures; only the header row is set apart */
  .ledger-wrap { overflow-x: auto; border: 1px solid var(--line); margin-top: 0.9rem; }
  .ledger { margin: 0; min-width: 46rem; background: var(--surface); font-family: var(--font-mono); }
  .ledger th {
    background: var(--ink);
    color: var(--bg);
    border-bottom: 0;
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }
  .ledger td {
    color: var(--ink);
    border-bottom: 1px solid var(--line);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .ledger tbody tr:last-child td { border-bottom: 0; }
  .ledger tbody tr:hover td { background: var(--bg); }
  .ledger .addr { color: var(--ink-2); }
  @media (max-width: 640px) {
    .detail-head { grid-template-columns: 1fr; }
    .artwrap { max-width: 320px; }
  }
  @media (max-width: 560px) {
    /* the order lines are label + value, and at this width the value has to keep the whole row or
       "0.5 ETH" ends up split over two lines by the flex squeeze. Label goes above it instead. */
    .orders { padding: 0.85rem 0.9rem; }
    .orders p { flex-wrap: wrap; gap: 0.15rem 0.85rem; }
    .orders .ok { width: 100%; }
    .orders p strong { white-space: nowrap; }
    /* less air between sections, since there are a dozen of them on a phone */
    h2 { margin: 1.6rem 0 0.8rem; }
    h3 { margin: 1.2rem 0 0.5rem; }
    .unwrapped { padding: 1rem 1.05rem; }
    dl { gap: 0.5rem 1rem; }
  }
</style>
